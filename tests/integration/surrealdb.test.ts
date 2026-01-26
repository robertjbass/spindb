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
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.SurrealDB
const DATABASE = 'test' // SurrealDB namespace/database
const SEED_FILE = join(__dirname, '../fixtures/surrealdb/seeds/sample-db.surql')
const EXPECTED_ROW_COUNT = 5 // 5 user rows
const TEST_VERSION = '2' // Major version

/**
 * Get row count from SurrealDB using surreal sql
 */
async function getSurrealDBRowCount(
  port: number,
  containerName: string,
  database: string,
  table: string,
): Promise<number> {
  const { promisify } = await import('util')
  const { exec } = await import('child_process')
  const execAsync = promisify(exec)

  const engine = getEngine(ENGINE)
  const surrealPath = await engine.getSurrealPath(TEST_VERSION).catch(() => 'surreal')

  // Derive namespace from container name (same as engine does)
  const namespace = containerName.replace(/-/g, '_')

  // Query to count rows in SurrealDB
  // SurrealQL syntax: SELECT count() FROM table GROUP ALL
  const query = `SELECT count() FROM ${table} GROUP ALL`

  try {
    const { stdout } = await execAsync(
      `echo "${query}" | "${surrealPath}" sql --endpoint ws://127.0.0.1:${port} --namespace ${namespace} --database ${database} --username root --password root --json --hide-welcome`,
      { timeout: 10000 },
    )

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

    const rowCount = await getSurrealDBRowCount(testPorts[0], containerName, DATABASE, 'test_user')
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
    const backupPath = join(tmpdir(), `surrealdb-test-backup-${Date.now()}.surql`)

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'surql',
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

    const rowCount = await getSurrealDBRowCount(testPorts[1], clonedContainerName, DATABASE, 'test_user')
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
    await runScriptSQL(
      containerName,
      'DELETE test_user:5',
      DATABASE,
    )

    const rowCount = await getSurrealDBRowCount(testPorts[0], containerName, DATABASE, 'test_user')
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
    const ready = await waitForReady(ENGINE, testPorts[2], 60000)
    assert(ready, 'Renamed SurrealDB should be ready')

    // Verify row count reflects deletion
    // Note: The namespace is stored inside SurrealDB's data files, so after rename
    // we still need to query using the ORIGINAL container name's namespace
    const rowCount = await getSurrealDBRowCount(testPorts[2], containerName, DATABASE, 'test_user')
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Row count should persist after rename',
    )

    console.log(`   Data persisted: ${rowCount} rows`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log(`\n Testing port conflict handling...`)

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

    // Clean up this test container
    await containerManager.delete(portConflictContainerName, { force: true })

    console.log(
      '   Container created with conflicting port (would auto-reassign on start)',
    )
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
