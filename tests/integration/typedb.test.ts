/**
 * TypeDB System Integration Tests
 *
 * Tests the full container lifecycle with real TypeDB processes.
 * TypeDB is a strongly-typed database for knowledge representation and reasoning
 * with its own query language (TypeQL).
 *
 * TODO: Add integration tests for dumpFromConnectionString once we have a
 * test environment with remote TypeDB instances.
 */

import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  waitForReady,
  waitForStopped,
  containerDataExists,
  runScriptFile,
  executeQuery,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.TypeDB
const DATABASE = 'test_tdb' // Matches the database name in sample-db.tqls
const SEED_FILE = join(__dirname, '../fixtures/typedb/seeds/sample-db.tqls')
const EXPECTED_ROW_COUNT = 5 // 5 test_user entities
const TEST_VERSION = '3' // Major version

/**
 * Get entity count from TypeDB using console with reduce count query.
 * TypeDB console --command mode doesn't support multi-step transaction flows,
 * so we use a temp script file with --script instead.
 */
async function getTypeDBRowCount(
  port: number,
  database: string,
  entityType: string,
): Promise<number> {
  const { spawn } = await import('child_process')
  const { writeFile, unlink } = await import('fs/promises')
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  const { getConsoleBaseArgs } = await import('../../engines/typedb/cli-utils')

  const engine = getEngine(ENGINE)
  const consolePath = await engine
    .getTypeDBConsolePath(TEST_VERSION)
    .catch(() => {
      throw new Error('TypeDB console binary not found')
    })

  const query = `match $u isa ${entityType}; reduce $c = count;`
  const scriptContent = `transaction read ${database}\n\n${query}\n\nclose\n`
  const tempScript = join(
    tmpdir(),
    `spindb-typedb-count-${Date.now()}-${Math.random().toString(36).slice(2)}.tqls`,
  )

  try {
    await writeFile(tempScript, scriptContent, 'utf-8')

    const stdout = await new Promise<string>((resolve, reject) => {
      const args = [...getConsoleBaseArgs(port), '--script', tempScript]
      const proc = spawn(consolePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let stderr = ''
      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      proc.on('close', (code) => {
        if (code === 0) resolve(output)
        else reject(new Error(stderr || `Exit code ${code}`))
      })
      proc.on('error', reject)
    })

    // Parse the count from TypeDB output - format: "$c | 5"
    const countMatch = stdout.match(/\$c\s*\|\s*(\d+)/)
    if (countMatch) {
      return parseInt(countMatch[1], 10)
    }

    logDebug(`Could not parse TypeDB count from output: ${stdout}`)
    return 0
  } catch (error) {
    console.error('Error getting TypeDB row count:', error)
    return 0
  } finally {
    await unlink(tempScript).catch(() => {})
  }
}

describe('TypeDB Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string
  // On Windows, rename is skipped so the container keeps its original name
  const getActiveContainerName = () =>
    process.platform === 'win32' ? containerName : renamedContainerName

  before(async () => {
    console.log('\n Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    console.log('\n Finding available test ports...')
    // TypeDB uses 1 main port per container (HTTP port derived as main + 6271)
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.typedb.base)
    // Also verify HTTP ports (main + 6271) are free
    const { portManager } = await import('../../core/port-manager')
    for (const port of testPorts) {
      const httpPort = port + 6271
      const httpFree = await portManager.isPortAvailable(httpPort)
      if (!httpFree) {
        throw new Error(
          `HTTP port ${httpPort} (for main port ${port}) is in use; cannot proceed with TypeDB tests.`,
        )
      }
    }
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('typedb-test')
    clonedContainerName = generateTestName('typedb-test-clone')
    renamedContainerName = generateTestName('typedb-test-renamed')
    portConflictContainerName = generateTestName('typedb-test-conflict')
  })

  after(async () => {
    console.log('\n Final cleanup...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }
  })

  it('should create container without starting (--no-start)', async () => {
    console.log(`\n Creating container "${containerName}" without starting...`)

    // Ensure TypeDB binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring TypeDB binaries are available...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0],
      database: DATABASE,
    })

    // Verify container exists but is not running
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')
    assertEqual(
      config?.status,
      'created',
      'Container status should be "created"',
    )

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(!running, 'Container should not be running')

    console.log('   Container created and not running')
  })

  it('should start the container', async () => {
    console.log(`\n Starting container "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // Wait for TypeDB to be ready (60s timeout for slow CI runners)
    const ready = await waitForReady(ENGINE, testPorts[0], 60000)
    assert(ready, 'TypeDB should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   Container started and ready')
  })

  it('should create a database', async () => {
    console.log(`\n Creating database "${DATABASE}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    await engine.createDatabase(config!, DATABASE)

    console.log(`   Database "${DATABASE}" created`)
  })

  it('should seed the database with test data using runScript', async () => {
    console.log(`\n Seeding database with test data using engine.runScript...`)

    // Use runScriptFile which internally calls engine.runScript
    // The seed file (.tqls) contains transaction commands for schema + data
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const rowCount = await getTypeDBRowCount(
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Should have correct row count after seeding',
    )

    console.log(`   Seeded ${rowCount} entities using engine.runScript`)
  })

  it('should query seeded data using executeQuery', async () => {
    logDebug('Querying seeded data using engine.executeQuery...')

    // Test basic fetch query (TypeQL syntax)
    const result = await executeQuery(
      containerName,
      'match $u isa test_user; fetch { "name": $u.name };',
      DATABASE,
    )

    // TypeDB returns raw console output as a single result
    assertEqual(result.rowCount, 1, 'Should return raw result')

    // The result should contain user names
    const output = result.rows[0].result as string
    assert(output.includes('Alice'), 'Result should contain Alice')
    assert(output.includes('Bob'), 'Result should contain Bob')

    logDebug('Query returned expected data')
  })

  it('should create a user', async () => {
    console.log(`\n Testing createUser...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)

    const creds = await engine.createUser(config!, {
      username: 'testuser',
      password: 'testpass123',
      database: DATABASE,
    })
    assertEqual(creds.username, 'testuser', 'Username should match')
    assertEqual(creds.password, 'testpass123', 'Password should match')
    console.log('   Created user successfully')
  })

  it('should clone container using backup/restore', async () => {
    console.log(
      `\n Creating container "${clonedContainerName}" via backup/restore...`,
    )

    // Create cloned container
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[1],
      database: DATABASE,
    })

    const engine = getEngine(ENGINE)

    // Start cloned container first (needed for import)
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, 'Cloned container config should exist')

    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // Wait for it to be ready
    const ready = await waitForReady(ENGINE, testPorts[1], 60000)
    assert(ready, 'Cloned TypeDB should be ready before restore')

    // Create backup from source
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(tmpdir(), `typedb-test-backup-${Date.now()}.typeql`)

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    try {
      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'typeql',
      })

      // Restore to cloned container (TypeDB import creates the database)
      await engine.restore(clonedConfig!, backupPath, {
        database: DATABASE,
      })
    } finally {
      // Clean up backup files (TypeDB creates schema + data files)
      const schemaPath = backupPath.replace(/\.typeql$/, '-schema.typeql')
      const dataPath = backupPath.replace(/\.typeql$/, '-data.typeql')
      await rm(backupPath, { force: true })
      await rm(schemaPath, { force: true })
      await rm(dataPath, { force: true })
    }

    console.log('   Container cloned via backup/restore')
  })

  it('should verify restored data matches source', async () => {
    console.log(`\n Verifying restored data...`)

    const rowCount = await getTypeDBRowCount(
      testPorts[1],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Restored data should have same row count',
    )

    console.log(`   Verified ${rowCount} entities in restored container`)
  })

  it('should stop and delete the restored container', async (t) => {
    // Skip on Windows - Rust binary may hold file handles
    if (process.platform === 'win32') {
      t.skip('Delete test skipped on Windows (file handle locking)')
      return
    }

    console.log(`\n Deleting restored container "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    await engine.stop(config!)

    // Wait for the container to be fully stopped
    const stopped = await waitForStopped(clonedContainerName, ENGINE)
    assert(stopped, 'Container should be fully stopped before delete')

    await containerManager.delete(clonedContainerName, { force: true })

    // Verify filesystem is cleaned up
    const exists = containerDataExists(clonedContainerName, ENGINE)
    assert(!exists, 'Container data directory should be deleted')

    // Verify not in container list
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === clonedContainerName)
    assert(!found, 'Container should not be in list')

    console.log('   Container deleted and filesystem cleaned up')
  })

  it('should modify data using runScript inline command', async () => {
    console.log(
      `\n Deleting one entity using engine.runScript with inline command...`,
    )

    // Delete an entity via a write transaction using temp script
    // TypeDB console --command mode doesn't support multi-step transaction flows
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    const consolePath = await engine.getTypeDBConsolePath(TEST_VERSION)
    const { getConsoleBaseArgs } = await import(
      '../../engines/typedb/cli-utils'
    )
    const { spawn } = await import('child_process')
    const { writeFile: writeTempFile, unlink: unlinkTemp } = await import(
      'fs/promises'
    )
    const { tmpdir: getTmpdir } = await import('os')
    const { join: joinPath } = await import('path')

    const deleteScript = `transaction write ${DATABASE}\n\nmatch $u isa test_user, has id 5; delete $u;\n\ncommit\n`
    const tempScript = joinPath(
      getTmpdir(),
      `spindb-typedb-delete-${Date.now()}.tqls`,
    )

    try {
      await writeTempFile(tempScript, deleteScript, 'utf-8')

      await new Promise<void>((resolve, reject) => {
        const args = [
          ...getConsoleBaseArgs(testPorts[0]),
          '--script',
          tempScript,
        ]
        const proc = spawn(consolePath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stderr = ''
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(stderr || `Exit code ${code}`))
        })
        proc.on('error', reject)
      })
    } finally {
      await unlinkTemp(tempScript).catch(() => {})
    }

    const rowCount = await getTypeDBRowCount(
      testPorts[0],
      DATABASE,
      'test_user',
    )
    // Should have 4 entities now
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, 'Should have one less entity')

    console.log(`   Entity deleted, now have ${rowCount} entities`)
  })

  it('should stop, rename container, and change port', async (t) => {
    // Skip on Windows - Rust binary may hold file handles
    if (process.platform === 'win32') {
      t.skip('Rename test skipped on Windows (file handle locking issues)')
      return
    }

    console.log(`\n Renaming container and changing port...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    // Stop the container
    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // Wait for the container to be fully stopped (PID file removed)
    const stopped = await waitForStopped(containerName, ENGINE)
    assert(stopped, 'Container should be fully stopped before rename')

    // Rename container and change port
    await containerManager.rename(containerName, renamedContainerName)
    await containerManager.updateConfig(renamedContainerName, {
      port: testPorts[2],
    })

    // Verify rename
    const oldConfig = await containerManager.getConfig(containerName)
    assert(oldConfig === null, 'Old container name should not exist')

    const newConfig = await containerManager.getConfig(renamedContainerName)
    assert(newConfig !== null, 'Renamed container should exist')
    assertEqual(newConfig?.port, testPorts[2], 'Port should be updated')

    console.log(
      `   Renamed to "${renamedContainerName}" on port ${testPorts[2]}`,
    )
  })

  it('should verify data persists after rename', async (t) => {
    // Skip on Windows - depends on rename test which is skipped
    if (process.platform === 'win32') {
      t.skip('Rename verification skipped on Windows (rename test skipped)')
      return
    }

    console.log(`\n Verifying data persists after rename...`)

    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, 'Container config should exist')

    // Start the renamed container
    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    // Wait for ready
    const ready = await waitForReady(ENGINE, testPorts[2], 60000)
    assert(ready, 'Renamed TypeDB should be ready')

    // Verify row count reflects deletion
    const rowCount = await getTypeDBRowCount(
      testPorts[2],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Entity count should persist after rename',
    )

    console.log(`   Data persisted: ${rowCount} entities`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log(`\n Testing port conflict handling...`)

    try {
      // Try to create container on a port that's already in use (testPorts[2])
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // This port is in use by renamed container
        database: 'test_db',
      })

      // The container should be created but when we try to start, it should detect conflict
      const config = await containerManager.getConfig(portConflictContainerName)
      assert(config !== null, 'Container should be created')
      assertEqual(
        config?.port,
        testPorts[2],
        'Port should be set to conflicting port initially',
      )

      console.log(
        '   Container created with conflicting port (would auto-reassign on start)',
      )
    } finally {
      // Always clean up this test container
      await containerManager
        .delete(portConflictContainerName, { force: true })
        .catch(() => {
          // Ignore errors during cleanup
        })
    }
  })

  it('should show warning when starting already running container', async (t) => {
    console.log(`\n Testing start on already running container...`)

    const activeContainer = getActiveContainerName()
    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
      t.skip('Container not found - previous tests may have failed')
      return
    }

    const engine = getEngine(ENGINE)

    // Check if container is running - if not, start it first
    const initiallyRunning = await processManager.isRunning(activeContainer, {
      engine: ENGINE,
    })

    if (!initiallyRunning) {
      console.log('   Container not running, starting it first...')
      await engine.start(config)
      const ready = await waitForReady(ENGINE, config.port, 60000)
      if (!ready) {
        t.skip('Container failed to start - skipping duplicate start test')
        return
      }
      await containerManager.updateConfig(activeContainer, {
        status: 'running',
      })
    }

    // Now the container should be running
    const running = await processManager.isRunning(activeContainer, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    // Attempting to start again should not throw (idempotent behavior)
    await engine.start(config)

    // Should still be running
    const stillRunning = await processManager.isRunning(activeContainer, {
      engine: ENGINE,
    })
    assert(
      stillRunning,
      'Container should still be running after duplicate start',
    )

    console.log(
      '   Container is already running (duplicate start handled gracefully)',
    )
  })

  it('should handle stopping already stopped container gracefully', async (t) => {
    console.log(`\n Testing stop on already stopped container...`)

    const activeContainer = getActiveContainerName()
    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
      t.skip('Container not found - previous tests may have failed')
      return
    }

    const engine = getEngine(ENGINE)

    // First stop the container
    await engine.stop(config)
    await containerManager.updateConfig(activeContainer, {
      status: 'stopped',
    })

    // Wait for the container to be fully stopped
    const stopped = await waitForStopped(activeContainer, ENGINE)
    assert(stopped, 'Container should be fully stopped')

    // Now it's stopped, verify
    const running = await processManager.isRunning(activeContainer, {
      engine: ENGINE,
    })
    assert(!running, 'Container should be stopped')

    // Attempting to stop again should not throw (idempotent behavior)
    await engine.stop(config)

    // Still stopped
    const stillStopped = await processManager.isRunning(activeContainer, {
      engine: ENGINE,
    })
    assert(
      !stillStopped,
      'Container should still be stopped after duplicate stop',
    )

    console.log('   Duplicate stop handled gracefully (idempotent)')
  })

  it('should delete container with --force', async (t) => {
    // Skip on Windows - Rust binary may hold file handles
    if (process.platform === 'win32') {
      t.skip('Force delete test skipped on Windows (file handle locking)')
      return
    }

    const activeContainer = getActiveContainerName()
    console.log(`\n Force deleting container "${activeContainer}"...`)

    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
      console.log('   Container not found - skipping delete test')
      t.skip('Container not found - previous tests may have failed')
      return
    }

    await containerManager.delete(activeContainer, { force: true })

    // Verify filesystem cleaned up
    const exists = containerDataExists(activeContainer, ENGINE)
    assert(!exists, 'Container data directory should be deleted')

    // Verify not in list
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === activeContainer)
    assert(!found, 'Container should not be in list')

    console.log('   Container force deleted')
  })

  it('should have no test containers remaining', async (t) => {
    // Skip on Windows - delete tests are skipped so containers will remain
    if (process.platform === 'win32') {
      t.skip('Cleanup verification skipped on Windows (delete tests skipped)')
      return
    }

    console.log(`\n Verifying no test containers remain...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   All test containers cleaned up')
  })
})
