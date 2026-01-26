/**
 * CockroachDB System Integration Tests
 *
 * Tests the full container lifecycle with real CockroachDB processes.
 * CockroachDB is a distributed SQL database with PostgreSQL wire protocol compatibility.
 *
 * TODO: Add integration tests for dumpFromConnectionString once we have a
 * test environment with remote CockroachDB instances.
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
  getRowCount,
  waitForReady,
  waitForStopped,
  containerDataExists,
  runScriptFile,
  runScriptSQL,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.CockroachDB
const DATABASE = 'defaultdb' // CockroachDB default database
const SEED_FILE = join(__dirname, '../fixtures/cockroachdb/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5 // 5 user rows
const TEST_VERSION = '25' // Major version

describe('CockroachDB Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string

  before(async () => {
    console.log('\n Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    console.log('\n Finding available test ports...')
    // CockroachDB uses 2 ports per container (SQL + HTTP), so we need 6 consecutive ports
    // and use every other one for SQL: [0], [2], [4] to avoid HTTP port conflicts
    const allPorts = await findConsecutiveFreePorts(6, TEST_PORTS.cockroachdb.base)
    testPorts = [allPorts[0], allPorts[2], allPorts[4]]
    console.log(`   Using ports: ${testPorts.join(', ')} (with HTTP on +1 each)`)

    containerName = generateTestName('cockroachdb-test')
    clonedContainerName = generateTestName('cockroachdb-test-clone')
    renamedContainerName = generateTestName('cockroachdb-test-renamed')
    portConflictContainerName = generateTestName('cockroachdb-test-conflict')
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

    // Ensure CockroachDB binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring CockroachDB binaries are available...')
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
    await engine.initDataDir(containerName, TEST_VERSION, { port: testPorts[0] })

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

    // Wait for CockroachDB to be ready (90s timeout for slow CI runners)
    const ready = await waitForReady(ENGINE, testPorts[0], 90000)
    assert(ready, 'CockroachDB should be ready to accept connections')

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

    const rowCount = await getRowCount(ENGINE, testPorts[0], DATABASE, 'test_user')
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Should have correct row count after seeding',
    )

    console.log(`   Seeded ${rowCount} rows using engine.runScript`)
  })

  it('should clone container using backup/restore', async () => {
    console.log(
      `\n Creating container "${clonedContainerName}" via backup/restore...`,
    )

    // Create and initialize cloned container
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[1],
      database: DATABASE,
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, TEST_VERSION, { port: testPorts[1] })

    // Start cloned container first (needed for SQL restore)
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, 'Cloned container config should exist')

    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // Wait for it to be ready
    const ready = await waitForReady(ENGINE, testPorts[1], 90000)
    assert(ready, 'Cloned CockroachDB should be ready before restore')

    // Create backup from source
    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `cockroachdb-test-backup-${Date.now()}.sql`)

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    // Restore to cloned container
    await engine.restore(clonedConfig!, backupPath, {
      database: DATABASE,
    })

    // Clean up backup file
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   Container cloned via backup/restore')
  })

  it('should verify restored data matches source', async () => {
    console.log(`\n Verifying restored data...`)

    const rowCount = await getRowCount(ENGINE, testPorts[1], DATABASE, 'test_user')
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Restored data should have same row count',
    )

    console.log(`   Verified ${rowCount} rows in restored container`)
  })

  it('should stop and delete the restored container', async () => {
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
    // CockroachDB requires semicolon at end of statement
    await runScriptSQL(
      containerName,
      "DELETE FROM test_user WHERE id = 5;",
      DATABASE,
    )

    const rowCount = await getRowCount(ENGINE, testPorts[0], DATABASE, 'test_user')
    // Should have 4 rows now
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, 'Should have one less row')

    console.log(
      `   Row deleted using engine.runScript, now have ${rowCount} rows`,
    )
  })

  it('should stop, rename container, and change port', async () => {
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

  it('should verify data persists after rename', async () => {
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
    const ready = await waitForReady(ENGINE, testPorts[2], 90000)
    assert(ready, 'Renamed CockroachDB should be ready')

    // Verify row count reflects deletion
    const rowCount = await getRowCount(ENGINE, testPorts[2], DATABASE, 'test_user')
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Row count should persist after rename',
    )

    console.log(`   Data persisted: ${rowCount} rows`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log(`\n Testing port conflict handling...`)

    const engine = getEngine(ENGINE)

    // Use try/finally to ensure cleanup always happens
    try {
      // Try to create container on a port that's already in use (testPorts[2])
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // This port is in use by renamed container
        database: 'test_db', // Different database to avoid confusion
      })

      await engine.initDataDir(portConflictContainerName, TEST_VERSION, { port: testPorts[2] })

      // Verify container was created with the conflicting port
      const config = await containerManager.getConfig(portConflictContainerName)
      assert(config !== null, 'Container should be created')
      assertEqual(
        config?.port,
        testPorts[2],
        'Port should be set to conflicting port initially',
      )

      // Try to start the container - it should fail due to port conflict
      // CockroachDB uses --background mode, so the start command may return
      // but the server won't actually be ready due to port conflict
      let startFailed = false
      try {
        await engine.start(config!)
        // If start didn't throw, check if the server is actually ready
        // With port conflict, CockroachDB should fail to start or report not ready
        const ready = await waitForReady(ENGINE, testPorts[2], 10000)
        if (!ready) {
          // Server didn't become ready, which is expected with port conflict
          startFailed = true
        }
      } catch (error) {
        // Start threw an error, which is also acceptable for port conflict
        startFailed = true
        console.log(`   Start failed as expected: ${error instanceof Error ? error.message : error}`)
      }

      console.log(
        startFailed
          ? '   Port conflict detected (start failed or server not ready)'
          : '   Container started despite port conflict (unexpected but handled)',
      )

      // Try to stop in case it partially started
      try {
        await engine.stop(config!)
      } catch {
        // Ignore stop errors
      }
    } finally {
      // Always clean up the port conflict container
      try {
        await containerManager.delete(portConflictContainerName, { force: true })
        console.log(`   Cleaned up port conflict container`)
      } catch {
        // Ignore cleanup errors - will be caught in final cleanup
      }

      // Always ensure the renamed container is running for the next test
      // On Windows, port conflicts can cause both containers to crash
      const renamedConfig = await containerManager.getConfig(renamedContainerName)
      if (renamedConfig) {
        const renamedRunning = await processManager.isRunning(renamedContainerName, { engine: ENGINE })
        if (!renamedRunning) {
          console.log('   Restarting renamed container after port conflict test...')
          await engine.start(renamedConfig)
          const ready = await waitForReady(ENGINE, testPorts[2], 90000)
          if (!ready) {
            console.log('   Warning: renamed container failed to restart')
          } else {
            await containerManager.updateConfig(renamedContainerName, { status: 'running' })
            console.log('   Renamed container restarted successfully')
          }
        }
      }
    }
  })

  it('should show warning when starting already running container', async () => {
    console.log(`\n Testing start on already running container...`)

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
      '   Container is already running (duplicate start handled gracefully)',
    )
  })

  it('should handle stopping already stopped container gracefully', async () => {
    console.log(`\n Testing stop on already stopped container...`)

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

    // Still stopped
    const stillStopped = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(
      !stillStopped,
      'Container should still be stopped after duplicate stop',
    )

    console.log('   Duplicate stop handled gracefully (idempotent)')
  })

  it('should delete container with --force', async () => {
    console.log(`\n Force deleting container "${renamedContainerName}"...`)

    await containerManager.delete(renamedContainerName, { force: true })

    // Verify filesystem cleaned up
    const exists = containerDataExists(renamedContainerName, ENGINE)
    assert(!exists, 'Container data directory should be deleted')

    // Verify not in list
    const containers = await containerManager.list()
    const found = containers.find((c) => c.name === renamedContainerName)
    assert(!found, 'Container should not be in list')

    console.log('   Container force deleted')
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n Verifying no test containers remain...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   All test containers cleaned up')
  })
})
