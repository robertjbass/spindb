/**
 * Qdrant System Integration Tests
 *
 * Tests the full container lifecycle with real Qdrant processes.
 * Qdrant is a vector similarity search engine.
 *
 * TODO: Add integration tests for dumpFromConnectionString once we have a
 * test environment with remote Qdrant instances (e.g., via Docker Compose in CI).
 * Currently, connection string parsing is tested in unit/qdrant-restore.test.ts.
 */

import { describe, it, before, after } from 'node:test'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getQdrantCollectionCount,
  createQdrantCollection,
  insertQdrantPoints,
  getQdrantPointCount,
  waitForReady,
  waitForStopped,
  containerDataExists,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.Qdrant
const DATABASE = 'default' // Qdrant uses collections, not traditional databases
const TEST_COLLECTION = 'test_vectors'
const TEST_VERSION = '1' // Major version - will be resolved to full version via version map

describe('Qdrant Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string

  before(async () => {
    console.log('\n Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    console.log('\n Finding available test ports...')
    // Qdrant uses HTTP port + 1 for gRPC, so we need 2 ports per container
    // Request 6 consecutive ports and use every other one to avoid gRPC conflicts
    const allPorts = await findConsecutiveFreePorts(6, TEST_PORTS.qdrant.base)
    testPorts = [allPorts[0], allPorts[2], allPorts[4]]
    console.log(`   Using ports: ${testPorts.join(', ')} (with gRPC on +1 each)`)

    containerName = generateTestName('qdrant-test')
    clonedContainerName = generateTestName('qdrant-test-clone')
    renamedContainerName = generateTestName('qdrant-test-renamed')
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

    // Ensure Qdrant binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring Qdrant binaries are available...')
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

    // Wait for Qdrant to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'Qdrant should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   Container started and ready')
  })

  it('should create collection and insert data', async () => {
    console.log(`\n Creating collection and inserting test data...`)

    // Create a test collection
    const created = await createQdrantCollection(
      testPorts[0],
      TEST_COLLECTION,
      4,
    )
    assert(created, 'Should create collection')

    // Insert some test points
    const points = [
      { id: 1, vector: [0.1, 0.2, 0.3, 0.4], payload: { name: 'test1' } },
      { id: 2, vector: [0.2, 0.3, 0.4, 0.5], payload: { name: 'test2' } },
      { id: 3, vector: [0.3, 0.4, 0.5, 0.6], payload: { name: 'test3' } },
    ]
    const inserted = await insertQdrantPoints(testPorts[0], TEST_COLLECTION, points)
    assert(inserted, 'Should insert points')

    // Verify collection count
    const collectionCount = await getQdrantCollectionCount(testPorts[0])
    assertEqual(collectionCount, 1, 'Should have 1 collection')

    // Verify point count
    const pointCount = await getQdrantPointCount(testPorts[0], TEST_COLLECTION)
    assertEqual(pointCount, 3, 'Should have 3 points')

    console.log(`   Created collection with ${pointCount} points`)
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
    await engine.initDataDir(clonedContainerName, TEST_VERSION, {
      port: testPorts[1],
    })

    // Create backup from source
    const { tmpdir } = await import('os')
    const backupPath = `${tmpdir()}/qdrant-test-backup-${Date.now()}.snapshot`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'snapshot',
    })

    // Stop source for restore (restore needs container stopped)
    await engine.stop(sourceConfig!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // Wait for the container to be fully stopped
    // Use longer timeout on Windows for port/file release
    const stopped = await waitForStopped(containerName, ENGINE, 90000)
    assert(stopped, 'Source container should be fully stopped before restore')

    // Restore to cloned container
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, 'Cloned container config should exist')

    await engine.restore(clonedConfig!, backupPath, {
      database: DATABASE,
    })

    // Start cloned container
    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // Wait for ready
    const ready = await waitForReady(ENGINE, testPorts[1])
    assert(ready, 'Cloned Qdrant should be ready')

    // Clean up backup file
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    // Restart source container
    await engine.start(sourceConfig!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    // Wait for source container to be ready
    const sourceReady = await waitForReady(ENGINE, testPorts[0])
    assert(sourceReady, 'Source Qdrant should be ready after restart')

    console.log('   Container cloned via backup/restore')
  })

  it('should stop and rename container', async () => {
    console.log(`\n Renaming container and changing port...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    // Stop the container
    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // Wait for the container to be fully stopped
    // Use longer timeout on Windows for port/file release
    const stopped = await waitForStopped(containerName, ENGINE, 90000)
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

  it('should delete cloned container', async () => {
    console.log(`\n Deleting cloned container "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    if (config) {
      const engine = getEngine(ENGINE)
      await engine.stop(config)
      // Use longer timeout on Windows for port/file release
      await waitForStopped(clonedContainerName, ENGINE, 90000)
    }

    await containerManager.delete(clonedContainerName, { force: true })

    // Verify filesystem is cleaned up
    const exists = containerDataExists(clonedContainerName, ENGINE)
    assert(!exists, 'Container data directory should be deleted')

    console.log('   Cloned container deleted')
  })

  it('should delete renamed container with --force', async () => {
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
