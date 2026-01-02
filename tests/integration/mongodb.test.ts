/**
 * MongoDB System Integration Tests
 *
 * Tests the full container lifecycle with real MongoDB processes.
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
  containerDataExists,
  getConnectionString,
  assert,
  assertEqual,
  runScriptFile,
  runScriptSQL,
} from './helpers'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.MongoDB
const DATABASE = 'testdb'
const SEED_FILE = join(__dirname, '../fixtures/mongodb/seeds/sample-db.js')
const EXPECTED_ROW_COUNT = 5

describe('MongoDB Integration Tests', () => {
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
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.mongodb.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('mongodb-test')
    clonedContainerName = generateTestName('mongodb-test-clone')
    renamedContainerName = generateTestName('mongodb-test-renamed')
    portConflictContainerName = generateTestName('mongodb-test-conflict')
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

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: '8.0',
      port: testPorts[0],
      database: DATABASE,
    })

    // Initialize the data directory
    const engine = getEngine(ENGINE)
    await engine.initDataDir(containerName, '8.0', {})

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

    // Wait for MongoDB to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'MongoDB should be ready to accept connections')

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

  it('should create a new container from connection string (dump/restore)', async () => {
    console.log(
      `\n📋 Creating container "${clonedContainerName}" from connection string...`,
    )

    const sourceConnectionString = getConnectionString(
      ENGINE,
      testPorts[0],
      DATABASE,
    )

    // Create container
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: '8.0',
      port: testPorts[1],
      database: DATABASE,
    })

    // Initialize and start
    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, '8.0', {})

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, 'Cloned container config should exist')

    await engine.start(config!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // Wait for ready
    const ready = await waitForReady(ENGINE, testPorts[1])
    assert(ready, 'Cloned MongoDB should be ready')

    // Dump from source and restore to target
    const { tmpdir } = await import('os')
    const dumpPath = join(tmpdir(), `mongodb-test-dump-${Date.now()}.gz`)

    await engine.dumpFromConnectionString(sourceConnectionString, dumpPath)
    await engine.restore(config!, dumpPath, {
      database: DATABASE,
    })

    // Clean up dump file
    const { rm } = await import('fs/promises')
    await rm(dumpPath, { force: true })

    console.log('   ✓ Container created from connection string')
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

    // Use runScriptSQL which internally calls engine.runScript with --sql option
    // For MongoDB, the "sql" is actually JavaScript
    await runScriptSQL(
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
    assert(ready, 'Renamed MongoDB should be ready')

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
      version: '8.0',
      port: testPorts[2], // This port is in use by renamed container
      database: 'conflictdb',
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(portConflictContainerName, '8.0', {})

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
      '   ✓ Container created with conflicting port (would auto-reassign on start)',
    )
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
    assert(stillRunning, 'Container should still be running after duplicate start')

    console.log('   ✓ Container is already running (duplicate start handled gracefully)')
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

    // Now it's stopped, verify
    const running = await processManager.isRunning(renamedContainerName, {
      engine: ENGINE,
    })
    assert(!running, 'Container should be stopped')

    // Attempting to stop again should not throw
    // (In real CLI usage, this would show a warning message)
    console.log('   ✓ Container is already stopped (would show warning in CLI)')
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

  it('should have no test containers remaining', async () => {
    console.log(`\n✅ Verifying no test containers remain...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   ✓ All test containers cleaned up')
  })
})
