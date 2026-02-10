/**
 * SurrealDB System Integration Tests
 *
 * Tests the full container lifecycle with real SurrealDB processes.
 * SurrealDB is a multi-model database with SQL-like query language (SurrealQL).
 *
 * TODO: Add integration tests for dumpFromConnectionString once we have a
 * test environment with remote SurrealDB instances.
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
  runScriptSQL,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { paths } from '../../config/paths'

const ENGINE = Engine.SurrealDB
const DATABASE = 'test' // SurrealDB namespace/database
const SEED_FILE = join(__dirname, '../fixtures/surrealdb/seeds/sample-db.surql')
const EXPECTED_ROW_COUNT = 5 // 5 user rows
const TEST_VERSION = '2' // Major version

/**
 * Get row count from SurrealDB using surreal sql
 * Uses spawn with stdin for cross-platform compatibility (echo pipe doesn't work on Windows)
 */
async function getSurrealDBRowCount(
  port: number,
  containerName: string,
  database: string,
  table: string,
): Promise<number> {
  const { spawn } = await import('child_process')

  const engine = getEngine(ENGINE)
  const surrealPath = await engine
    .getSurrealPath(TEST_VERSION)
    .catch(() => 'surreal')

  // Derive namespace from container name (same as engine does)
  const namespace = containerName.replace(/-/g, '_')

  // Query to count rows in SurrealDB
  // SurrealQL syntax: SELECT count() FROM table GROUP ALL
  const query = `SELECT count() FROM ${table} GROUP ALL`

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const args = [
        'sql',
        '--endpoint',
        `ws://127.0.0.1:${port}`,
        '--namespace',
        namespace,
        '--database',
        database,
        '--username',
        'root',
        '--password',
        'root',
        '--json',
        '--hide-welcome',
      ]
      // Set cwd to container directory so history.txt goes there, not project root
      const cwd = paths.getContainerPath(containerName, { engine: ENGINE })
      const proc = spawn(surrealPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
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
      proc.stdin.write(query)
      proc.stdin.end()
    })

    // Parse JSON output - SurrealDB returns array of results
    // Format: [[{"count":5}]]
    const results = JSON.parse(stdout)
    if (
      Array.isArray(results) &&
      results[0] &&
      Array.isArray(results[0]) &&
      results[0][0]?.count !== undefined
    ) {
      return results[0][0].count
    }
    return 0
  } catch (error) {
    console.error('Error getting row count:', error)
    return 0
  }
}

describe('SurrealDB Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string
  // On Windows, rename is skipped so the container keeps its original name
  // This tracks the "current" container name for tests after the rename point
  const getActiveContainerName = () =>
    process.platform === 'win32' ? containerName : renamedContainerName

  before(async () => {
    console.log('\n Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    console.log('\n Finding available test ports...')
    // SurrealDB uses 1 port per container
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.surrealdb.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('surrealdb-test')
    clonedContainerName = generateTestName('surrealdb-test-clone')
    renamedContainerName = generateTestName('surrealdb-test-renamed')
    portConflictContainerName = generateTestName('surrealdb-test-conflict')
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

    // Ensure SurrealDB binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring SurrealDB binaries are available...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0],
      database: DATABASE,
    })

    // SurrealDB doesn't need initDataDir - data directory is created on start

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

    // Wait for SurrealDB to be ready (60s timeout for slow CI runners)
    const ready = await waitForReady(ENGINE, testPorts[0], 60000)
    assert(ready, 'SurrealDB should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   Container started and ready')
  })

  it('should seed the database with test data using runScript', async () => {
    console.log(`\n Seeding database with test data using engine.runScript...`)

    // Use runScriptFile which internally calls engine.runScript
    // This tests the `spindb run` command functionality
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const rowCount = await getSurrealDBRowCount(
      testPorts[0],
      containerName,
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Should have correct row count after seeding',
    )

    console.log(`   Seeded ${rowCount} rows using engine.runScript`)
  })

  it('should query seeded data using executeQuery', async () => {
    logDebug('Querying seeded data using engine.executeQuery...')

    // Test basic SELECT query (SurrealQL syntax)
    const result = await executeQuery(
      containerName,
      'SELECT id, name, email FROM test_user ORDER BY id',
      DATABASE,
    )

    assertEqual(result.rowCount, EXPECTED_ROW_COUNT, 'Should return all rows')

    // Verify first row data
    assertEqual(result.rows[0].name, 'Alice', 'First row should be Alice')
    assertEqual(
      result.rows[0].email,
      'alice@example.com',
      'First row email should match',
    )

    // Verify columns include expected fields
    assertTruthy(result.columns.includes('name'), 'Columns should include name')
    assertTruthy(
      result.columns.includes('email'),
      'Columns should include email',
    )

    // Test filtered query
    const filteredResult = await executeQuery(
      containerName,
      "SELECT name FROM test_user WHERE email CONTAINS 'bob'",
      DATABASE,
    )

    assertEqual(filteredResult.rowCount, 1, 'Should return one row for Bob')
    assertEqual(filteredResult.rows[0].name, 'Bob', 'Should find Bob')

    logDebug(`Query returned ${result.rowCount} rows with correct data`)
  })

  it('should create a user and update password on re-create', async () => {
    console.log(`\n👤 Testing createUser...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)

    const creds1 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'firstpass123',
      database: DATABASE,
    })
    assertEqual(creds1.username, 'testuser', 'Username should match')
    assertEqual(creds1.password, 'firstpass123', 'Password should match')
    console.log('   ✓ Created user with initial password')

    // DEFINE USER is idempotent - should update password
    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.password, 'secondpass456', 'Password should be updated')
    console.log('   ✓ Re-created user with new password (idempotent)')
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
    assert(ready, 'Cloned SurrealDB should be ready before restore')

    // Create backup from source
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(
      tmpdir(),
      `surrealdb-test-backup-${Date.now()}.surql`,
    )

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    try {
      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'surql',
      })

      // Restore to cloned container
      await engine.restore(clonedConfig!, backupPath, {
        database: DATABASE,
      })
    } finally {
      // Clean up backup file even if restore fails
      await rm(backupPath, { force: true })
    }

    console.log('   Container cloned via backup/restore')
  })

  it('should verify restored data matches source', async () => {
    console.log(`\n Verifying restored data...`)

    const rowCount = await getSurrealDBRowCount(
      testPorts[1],
      clonedContainerName,
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Restored data should have same row count',
    )

    console.log(`   Verified ${rowCount} rows in restored container`)
  })

  it('should stop and delete the restored container', async (t) => {
    // Skip on Windows - SurrealDB's SurrealKV uses memory-mapped files that
    // Windows holds handles to for 100+ seconds, causing EBUSY errors
    if (process.platform === 'win32') {
      t.skip('Delete test skipped on Windows (SurrealKV file handle locking)')
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
      `\n Deleting one row using engine.runScript with inline command...`,
    )

    // Use runScriptSQL which internally calls engine.runScript with --sql option
    await runScriptSQL(containerName, 'DELETE test_user:5', DATABASE)

    const rowCount = await getSurrealDBRowCount(
      testPorts[0],
      containerName,
      DATABASE,
      'test_user',
    )
    // Should have 4 rows now
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, 'Should have one less row')

    console.log(
      `   Row deleted using engine.runScript, now have ${rowCount} rows`,
    )
  })

  it('should stop, rename container, and change port', async (t) => {
    // Skip on Windows - SurrealDB uses memory-mapped files that Windows holds
    // handles to for extended periods even after process exit, causing EPERM
    // errors on rename that persist beyond reasonable retry timeouts
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
    assert(ready, 'Renamed SurrealDB should be ready')

    // Verify row count reflects deletion
    // Note: The namespace is stored inside SurrealDB's data files, so after rename
    // we still need to query using the ORIGINAL container name's namespace
    const rowCount = await getSurrealDBRowCount(
      testPorts[2],
      containerName,
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Row count should persist after rename',
    )

    console.log(`   Data persisted: ${rowCount} rows`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log(`\n Testing port conflict handling...`)

    try {
      // Try to create container on a port that's already in use (testPorts[2])
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // This port is in use by renamed container
        database: 'test_db', // Different database to avoid confusion
      })

      // The container should be created but when we try to start, it should detect conflict
      // In real usage, the start command would auto-assign a new port
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
      // Always clean up this test container, even if the test fails
      await containerManager
        .delete(portConflictContainerName, { force: true })
        .catch(() => {
          // Ignore errors during cleanup (container may not exist if creation failed)
        })
    }
  })

  it('should show warning when starting already running container', async (t) => {
    console.log(`\n Testing start on already running container...`)

    const activeContainer = getActiveContainerName()
    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
      // Container doesn't exist (previous tests may have failed)
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
      // Container doesn't exist (previous tests may have failed)
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
    // Skip on Windows - SurrealDB's SurrealKV uses memory-mapped files that
    // Windows holds handles to for 100+ seconds, causing EBUSY errors
    if (process.platform === 'win32') {
      t.skip(
        'Force delete test skipped on Windows (SurrealKV file handle locking)',
      )
      return
    }

    const activeContainer = getActiveContainerName()
    console.log(`\n Force deleting container "${activeContainer}"...`)

    const config = await containerManager.getConfig(activeContainer)
    if (!config) {
      // Container doesn't exist (previous tests may have failed)
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
