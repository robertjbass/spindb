/**
 * FerretDB System Integration Tests
 *
 * Tests the full container lifecycle with real FerretDB processes.
 * FerretDB is a MongoDB-compatible proxy that stores data in PostgreSQL.
 */

import { describe, it, before, after } from 'node:test'
import net from 'net'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getRowCount,
  waitForReady,
  waitForStopped,
  containerDataExists,
  runScriptFile,
  runScriptJS,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { readFile, unlink } from 'fs/promises'

const ENGINE = Engine.FerretDB
const DATABASE = 'testdb'
const SEED_FILE = join(__dirname, '../fixtures/ferretdb/seeds/sample-db.js')
const EXPECTED_ROW_COUNT = 5
const TEST_VERSION = '2' // Major version - will be resolved to full version via version map

describe('FerretDB Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string

  before(async () => {
    console.log('\n🧹 Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    console.log('\n🔍 Finding available test ports...')
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.ferretdb.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('ferretdb-test')
    clonedContainerName = generateTestName('ferretdb-test-clone')
    renamedContainerName = generateTestName('ferretdb-test-renamed')
    portConflictContainerName = generateTestName('ferretdb-test-conflict')
  })

  after(async () => {
    console.log('\n🧹 Final cleanup...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }
  })

  it('should create container without starting (--no-start)', async () => {
    console.log(
      `\n📦 Creating container "${containerName}" without starting...`,
    )

    // Ensure FerretDB binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring FerretDB binaries are available...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0],
      database: DATABASE,
    })

    // Initialize the data directory
    await engine.initDataDir(containerName, TEST_VERSION, {})

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

    console.log('   ✓ Container created and not running')
  })

  it('should start the container', async () => {
    console.log(`\n▶️  Starting container "${containerName}"...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // Wait for FerretDB to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'FerretDB should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   ✓ Container started and ready')
  })

  it('should seed the database with test data using runScript', async () => {
    console.log(
      `\n🌱 Seeding database with test data using engine.runScript...`,
    )

    // Use runScriptFile which internally calls engine.runScript
    // This tests the `spindb run` command functionality
    await runScriptFile(containerName, SEED_FILE, DATABASE)

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Should have correct document count after seeding',
    )

    console.log(`   ✓ Seeded ${rowCount} documents using engine.runScript`)
  })

  it('should query seeded data using executeQuery', async () => {
    logDebug('Querying seeded data using engine.executeQuery...')

    // Test basic find query (FerretDB uses MongoDB JavaScript syntax)
    // Sort by id field (not _id which is auto-generated)
    // Must call .toArray() to convert cursor to array for JSON serialization
    const result = await executeQuery(
      containerName,
      'test_user.find({}).sort({id: 1}).toArray()',
      DATABASE,
    )

    assertEqual(
      result.rowCount,
      EXPECTED_ROW_COUNT,
      'Should return all documents',
    )

    // Verify first document data (sorted by id, so id:1 = Alice Johnson)
    assertEqual(
      result.rows[0].name,
      'Alice Johnson',
      'First document should be Alice Johnson',
    )
    assertEqual(
      result.rows[0].email,
      'alice@example.com',
      'First document email should match',
    )

    // Test filtered query
    const filteredResult = await executeQuery(
      containerName,
      'test_user.find({email: /bob/}).toArray()',
      DATABASE,
    )

    assertEqual(
      filteredResult.rowCount,
      1,
      'Should return one document for Bob',
    )
    assertEqual(
      filteredResult.rows[0].name,
      'Bob Smith',
      'Should find Bob Smith',
    )

    // Verify columns include expected fields
    assertTruthy(result.columns.includes('name'), 'Columns should include name')
    assertTruthy(
      result.columns.includes('email'),
      'Columns should include email',
    )

    logDebug(`Query returned ${result.rowCount} documents with correct data`)
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

    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.password, 'secondpass456', 'Password should be updated')
    console.log('   ✓ Re-created user with new password (idempotent)')
  })

  it('should clone a container via backup/restore', async () => {
    console.log(
      `\n📋 Creating container "${clonedContainerName}" via backup/restore...`,
    )

    // Create container
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[1],
      database: DATABASE,
    })

    // Initialize and start
    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, TEST_VERSION, {})

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, 'Cloned container config should exist')

    await engine.start(config!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // Wait for ready
    const ready = await waitForReady(ENGINE, testPorts[1])
    assert(ready, 'Cloned FerretDB should be ready')

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source config should exist')

    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const dumpPath = join(tmpdir(), `ferretdb-test-dump-${Date.now()}.archive`)

    await engine.backup(sourceConfig!, dumpPath, {
      database: DATABASE,
      format: 'archive',
    })

    try {
      await engine.restore(config!, dumpPath, {
        database: DATABASE,
      })
    } finally {
      // Clean up dump file regardless of restore success/failure
      await rm(dumpPath, { force: true })
    }

    console.log('   ✓ Container cloned via backup/restore')
  })

  it('should verify restored data matches source', async () => {
    console.log(`\n🔍 Verifying restored data...`)
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[1],
      DATABASE,
      'test_user',
    )

    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Restored data should have same document count',
    )
    console.log(`   ✓ Verified ${rowCount} documents in restored container`)
  })

  it('should stop and delete the restored container', async () => {
    console.log(`\n🗑️  Deleting restored container "${clonedContainerName}"...`)

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

    console.log('   ✓ Container deleted and filesystem cleaned up')
  })

  it('should modify data using runScript inline JavaScript', async () => {
    console.log(
      `\n✏️  Deleting one document using engine.runScript with inline JS...`,
    )

    // Use runScriptJS for MongoDB-compatible engines (FerretDB)
    // This is an alias for runScriptSQL that makes the intent clearer
    await runScriptJS(
      containerName,
      "db.test_user.deleteOne({email: 'eve@example.com'})",
      DATABASE,
    )

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Should have one less document',
    )

    console.log(
      `   ✓ Document deleted using engine.runScript, now have ${rowCount} documents`,
    )
  })

  it('should stop, rename container, and change port', async () => {
    console.log(`\n📝 Renaming container and changing port...`)

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
      `   ✓ Renamed to "${renamedContainerName}" on port ${testPorts[2]}`,
    )
  })

  it('should verify data persists after rename', async () => {
    console.log(`\n🔍 Verifying data persists after rename...`)

    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, 'Container config should exist')

    // Start the renamed container
    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    // Wait for ready
    const ready = await waitForReady(ENGINE, testPorts[2])
    assert(ready, 'Renamed FerretDB should be ready')

    // Verify document count reflects deletion
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[2],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Document count should persist after rename',
    )

    console.log(`   ✓ Data persisted: ${rowCount} documents`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log(`\n⚠️  Testing port conflict handling...`)

    // Try to create container on a port that's already in use (testPorts[2])
    await containerManager.create(portConflictContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[2], // This port is in use by renamed container
      database: 'conflictdb',
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(portConflictContainerName, TEST_VERSION, {})

    // The container should be created but when we try to start, it should detect conflict
    const config = await containerManager.getConfig(portConflictContainerName)
    assert(config !== null, 'Container should be created')
    assertEqual(
      config?.port,
      testPorts[2],
      'Port should be set to conflicting port initially',
    )

    try {
      // Attempt to start the container - this should either:
      // 1. Fail with a port conflict error, or
      // 2. Succeed if the engine auto-detects and handles the conflict
      await engine.start(config!)
      await containerManager.updateConfig(portConflictContainerName, {
        status: 'running',
      })

      // If start succeeded, verify the container is running
      const running = await processManager.isRunning(
        portConflictContainerName,
        {
          engine: ENGINE,
        },
      )

      if (running) {
        // Check if the port was auto-reassigned (behavior varies by engine)
        const updatedConfig = await containerManager.getConfig(
          portConflictContainerName,
        )
        console.log(
          `   ✓ Container started (port: ${updatedConfig?.port}, conflict handling succeeded)`,
        )

        // Stop the container before cleanup
        await engine.stop(updatedConfig!)
        await waitForStopped(portConflictContainerName, ENGINE)
      } else {
        console.log(
          '   ✓ Container start attempted but not running (port conflict detected)',
        )
      }
    } catch (error) {
      // Port conflict error is expected behavior
      const e = error as Error
      assert(
        e.message.includes('port') ||
          e.message.includes('address') ||
          e.message.includes('EADDRINUSE') ||
          e.message.includes('in use'),
        `Expected port conflict error, got: ${e.message}`,
      )
      console.log(`   ✓ Port conflict detected with error: ${e.message}`)
    } finally {
      // Clean up this test container regardless of pass/fail
      await containerManager.delete(portConflictContainerName, { force: true })
    }
  })

  it('should show warning when starting already running container', async () => {
    console.log(`\n⚠️  Testing start on already running container...`)

    // Container should already be running from earlier test
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should already be running')

    // Attempting to start again should not throw
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)

    // This should complete without throwing (idempotent behavior)
    await engine.start(config!)

    // Should still be running
    const stillRunning = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(
      stillRunning,
      'Container should still be running after duplicate start',
    )

    console.log(
      '   ✓ Container is already running (duplicate start handled gracefully)',
    )
  })

  it('should restart after partial shutdown (orphaned PG backend)', async () => {
    console.log(
      `\n🔄 Testing restart after partial shutdown (proxy killed, PG backend alive)...`,
    )

    // Container should already be running from earlier test
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, 'Container config should exist')
    assert(config!.backendPort !== undefined, 'backendPort should be set')

    const containerDir = paths.getContainerPath(renamedContainerName, {
      engine: ENGINE,
    })
    const ferretPidFile = join(containerDir, 'ferretdb.pid')

    // 1. Read the FerretDB proxy PID and kill only the proxy
    const pidContent = await readFile(ferretPidFile, 'utf8')
    const proxyPid = parseInt(pidContent.trim(), 10)
    assert(!isNaN(proxyPid), 'FerretDB proxy PID should be valid')
    assert(
      platformService.isProcessRunning(proxyPid),
      'FerretDB proxy should be running',
    )

    // Kill the proxy process directly (simulating a crash)
    await platformService.terminateProcess(proxyPid, true)

    // Wait for the process to actually die (SIGKILL is async)
    const killStart = Date.now()
    while (
      platformService.isProcessRunning(proxyPid) &&
      Date.now() - killStart < 5000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await unlink(ferretPidFile).catch(() => {})

    // 2. Verify proxy is dead but PG backend is still alive on backendPort
    assert(
      !platformService.isProcessRunning(proxyPid),
      'FerretDB proxy should be dead after kill',
    )

    // processManager.isRunning checks the ferretdb.pid file — should be false now
    const proxyRunning = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(
      !proxyRunning,
      'processManager should report not running (proxy dead)',
    )

    // But the PG backend should still be listening
    const pgAlive = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(config!.backendPort!, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.setTimeout(2000, () => {
        socket.destroy()
        resolve(false)
      })
    })
    assert(pgAlive, 'PostgreSQL backend should still be running on backendPort')

    // 3. Call start() again — this should succeed (detect PG running, only start proxy)
    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    // 4. Verify everything is working
    const ready = await waitForReady(ENGINE, config!.port)
    assert(ready, 'FerretDB should be ready after restart')

    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(running, 'FerretDB should be running after restart')

    // Verify data is still accessible
    const rowCount = await getRowCount(
      ENGINE,
      config!.port,
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Data should be intact after partial shutdown restart',
    )

    console.log('   ✓ Restart after partial shutdown succeeded, data intact')
  })

  it('should show warning when stopping already stopped container', async () => {
    console.log(`\n⚠️  Testing stop on already stopped container...`)

    // First stop the container
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'stopped',
    })

    // Wait for the container to be fully stopped
    const stopped = await waitForStopped(renamedContainerName, ENGINE)
    assert(stopped, 'Container should be fully stopped')

    // Now it's stopped, verify
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(!running, 'Container should be stopped')

    // Attempting to stop again should not throw (idempotent behavior)
    await engine.stop(config!)
    console.log(
      '   ✓ Container is already stopped (double-stop handled gracefully)',
    )
  })

  it('should delete container with --force', async () => {
    console.log(`\n🗑️  Force deleting container "${renamedContainerName}"...`)

    await containerManager.delete(renamedContainerName, { force: true })

    // Verify filesystem cleaned up
    const exists = containerDataExists(renamedContainerName, ENGINE)
    assert(!exists, 'Container data directory should be deleted')

    // Verify not in list
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === renamedContainerName)
    assert(!found, 'Container should not be in list')

    console.log('   ✓ Container force deleted')
  })

  it('should backup and restore with password-authenticated local root credentials', async () => {
    console.log(
      `\n🔐 Testing auth-aware FerretDB backup/restore on local containers...`,
    )

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.ferretdb.base + 40,
    )
    const sourceName = generateTestName('ferretdb-auth-test-source')
    const targetName = generateTestName('ferretdb-auth-test-target')
    const sourcePassword = 'sourcepass123'
    const targetPassword = 'targetpass456'
    const { tmpdir } = await import('os')
    const { mkdir, rm, writeFile } = await import('fs/promises')
    const backupPath = join(
      tmpdir(),
      `ferretdb-auth-backup-${Date.now()}.archive`,
    )
    const engine = getEngine(ENGINE)

    const writeDefaultCredentialFile = async (
      containerName: string,
      port: number,
      password: string,
    ) => {
      const credentialsDir = join(
        paths.getContainerPath(containerName, { engine: ENGINE }),
        'credentials',
      )
      await mkdir(credentialsDir, { recursive: true })
      const connectionString = `mongodb://root:${encodeURIComponent(password)}@127.0.0.1:${port}/admin?authSource=admin`
      await writeFile(
        join(credentialsDir, '.env.spindb'),
        [
          'DB_USER=root',
          `DB_PASSWORD=${password}`,
          'DB_HOST=127.0.0.1',
          `DB_PORT=${port}`,
          'DB_NAME=admin',
          `DB_URL=${connectionString}`,
          '',
        ].join('\n'),
        'utf-8',
      )
    }

    const waitForAuthedReady = async (
      containerName: string,
      timeoutMs = 30000,
    ): Promise<{ ready: boolean; lastError: string | null }> => {
      const startTime = Date.now()
      let lastError: string | null = null
      while (Date.now() - startTime < timeoutMs) {
        try {
          const config = await containerManager.getConfig(containerName)
          if (config) {
            const result = await engine.executeQuery(
              config,
              'db.runCommand({ ping: 1 })',
              {
                database: 'admin',
              },
            )
            if (result.rowCount === 1) {
              return { ready: true, lastError: null }
            }
          }
        } catch (error) {
          lastError =
            error instanceof Error ? error.message : 'unknown auth-ready error'
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return { ready: false, lastError }
    }

    const enablePasswordAuth = async (
      containerName: string,
      port: number,
      password: string,
    ) => {
      const config = await containerManager.getConfig(containerName)
      assert(config !== null, 'Container config should exist')

      await runScriptJS(
        containerName,
        `db.getSiblingDB('admin').createUser({ user: 'root', pwd: ${JSON.stringify(password)}, roles: [{ role: 'root', db: 'admin' }] })`,
        'admin',
      )
      await writeDefaultCredentialFile(containerName, port, password)

      await engine.stop(config!)
      await containerManager.updateConfig(containerName, {
        status: 'stopped',
        authEnabled: true,
      })
      const stopped = await waitForStopped(containerName, ENGINE)
      assert(stopped, 'Container should be fully stopped before auth restart')

      const updatedConfig = await containerManager.getConfig(containerName)
      assert(updatedConfig !== null, 'Updated container config should exist')
      await engine.start(updatedConfig!)
      await containerManager.updateConfig(containerName, {
        status: 'running',
      })

      const authReady = await waitForAuthedReady(containerName)
      assert(
        authReady.ready,
        `Auth-enabled FerretDB should be ready (${authReady.lastError ?? 'no error'})`,
      )
    }

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: sourcePort,
        database: DATABASE,
      })
      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })

      await engine.initDataDir(sourceName, TEST_VERSION, {})
      await engine.initDataDir(targetName, TEST_VERSION, {})

      const sourceConfig = await containerManager.getConfig(sourceName)
      const targetConfig = await containerManager.getConfig(targetName)
      assert(sourceConfig !== null, 'Source config should exist')
      assert(targetConfig !== null, 'Target config should exist')

      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })

      const sourceReady = await waitForReady(ENGINE, sourcePort)
      const targetReady = await waitForReady(ENGINE, targetPort)
      assert(sourceReady, 'Source FerretDB should be ready before auth')
      assert(targetReady, 'Target FerretDB should be ready before auth')

      await runScriptFile(sourceName, SEED_FILE, DATABASE)
      const seededCount = await getRowCount(
        ENGINE,
        sourcePort,
        DATABASE,
        'test_user',
      )
      assertEqual(
        seededCount,
        EXPECTED_ROW_COUNT,
        'Seeded source should contain the expected documents before auth',
      )

      await enablePasswordAuth(sourceName, sourcePort, sourcePassword)
      await enablePasswordAuth(targetName, targetPort, targetPassword)

      const authedSourceConfig = await containerManager.getConfig(sourceName)
      const authedTargetConfig = await containerManager.getConfig(targetName)
      assert(authedSourceConfig !== null, 'Auth source config should exist')
      assert(authedTargetConfig !== null, 'Auth target config should exist')

      await engine.backup(authedSourceConfig!, backupPath, {
        database: DATABASE,
        format: 'archive',
      })

      await engine.restore(authedTargetConfig!, backupPath, {
        database: DATABASE,
        sourceDatabase: DATABASE,
      })

      const restoredResult = await executeQuery(
        targetName,
        'db.test_user.find({}).sort({id: 1})',
        DATABASE,
      )
      assertEqual(
        restoredResult.rowCount,
        EXPECTED_ROW_COUNT,
        'Restored FerretDB should contain the expected documents',
      )
      assertEqual(
        restoredResult.rows[0].name,
        'Alice Johnson',
        'First restored document should match source data',
      )

      console.log(
        '   ✓ Backup and restore work with password-authenticated FerretDB',
      )
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})

      for (const containerName of [sourceName, targetName]) {
        const config = await containerManager.getConfig(containerName)
        if (config) {
          const running = await processManager.isRunning(containerName, {
            engine: ENGINE,
          })
          if (running) {
            await engine.stop(config).catch(() => {})
          }
          await containerManager
            .delete(containerName, { force: true })
            .catch(() => {})
        }
      }
    }
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n✅ Verifying no test containers remain...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   ✓ All test containers cleaned up')
  })
})
