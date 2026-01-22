/**
 * Meilisearch System Integration Tests
 *
 * Tests the full container lifecycle with real Meilisearch processes.
 * Meilisearch is a full-text search engine with REST API.
 *
 * TODO: Add integration tests for dumpFromConnectionString once we have a
 * test environment with remote Meilisearch instances (e.g., via Docker Compose in CI).
 * Currently, connection string parsing is tested in unit/meilisearch-restore.test.ts.
 */

import { describe, it, before, after } from 'node:test'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getMeilisearchIndexCount,
  createMeilisearchIndex,
  insertMeilisearchDocuments,
  getMeilisearchDocumentCount,
  waitForMeilisearchTask,
  waitForReady,
  waitForStopped,
  containerDataExists,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.Meilisearch
const DATABASE = 'default' // Meilisearch uses indexes, not traditional databases
const TEST_INDEX = 'test_documents'
const TEST_VERSION = '1' // Major version - will be resolved to full version via version map
const IS_WINDOWS = process.platform === 'win32'

// Meilisearch has a bug on Windows where snapshot creation fails with:
// "map size must be a multiple of the system page size"
// Skip backup/restore tests on Windows until Meilisearch fixes this upstream.
const SKIP_BACKUP_ON_WINDOWS = IS_WINDOWS
  ? 'Meilisearch snapshot creation has a bug on Windows (page size alignment)'
  : false

describe('Meilisearch Integration Tests', () => {
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
    // Meilisearch uses a single port (no gRPC), so we only need 3 ports
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.meilisearch.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('meilisearch-test')
    clonedContainerName = generateTestName('meilisearch-test-clone')
    renamedContainerName = generateTestName('meilisearch-test-renamed')
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

    // Ensure Meilisearch binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring Meilisearch binaries are available...')
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

    // Wait for Meilisearch to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'Meilisearch should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   Container started and ready')
  })

  it('should create index and insert data', async () => {
    console.log(`\n Creating index and inserting test data...`)

    // Create a test index
    const created = await createMeilisearchIndex(testPorts[0], TEST_INDEX, 'id')
    assert(created, 'Should create index')

    // Wait for the index to be created (async operation)
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Insert some test documents
    const documents = [
      { id: 1, title: 'Hello World', content: 'This is the first document' },
      { id: 2, title: 'Second Post', content: 'This is another document' },
      { id: 3, title: 'Third Entry', content: 'Yet another test document' },
    ]
    const result = await insertMeilisearchDocuments(
      testPorts[0],
      TEST_INDEX,
      documents,
    )
    assert(result.success, 'Should insert documents')

    // Wait for the task to complete
    if (result.taskUid !== undefined) {
      const taskComplete = await waitForMeilisearchTask(
        testPorts[0],
        result.taskUid,
      )
      assert(taskComplete, 'Document insertion task should complete')
    } else {
      // Give time for async processing
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    // Verify index count
    const indexCount = await getMeilisearchIndexCount(testPorts[0])
    assertEqual(indexCount, 1, 'Should have 1 index')

    // Verify document count
    const docCount = await getMeilisearchDocumentCount(testPorts[0], TEST_INDEX)
    assertEqual(docCount, 3, 'Should have 3 documents')

    console.log(`   Created index with ${docCount} documents`)
  })

  it('should clone container using backup/restore', { skip: SKIP_BACKUP_ON_WINDOWS }, async () => {
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
    const backupPath = `${tmpdir()}/meilisearch-test-backup-${Date.now()}.snapshot`

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
    const stopped = await waitForStopped(containerName, ENGINE, 60000)
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
    assert(ready, 'Cloned Meilisearch should be ready')

    // Clean up backup file
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   Container cloned via backup/restore')
  })

  it('should verify cloned data matches source', { skip: SKIP_BACKUP_ON_WINDOWS }, async () => {
    console.log('\n Verifying cloned data matches source...')

    // Verify index count on cloned container
    const indexCount = await getMeilisearchIndexCount(testPorts[1])
    assertEqual(indexCount, 1, 'Cloned container should have 1 index')

    // Verify document count on cloned container
    const docCount = await getMeilisearchDocumentCount(testPorts[1], TEST_INDEX)
    assertEqual(docCount, 3, 'Cloned container should have 3 documents')

    console.log(`   Cloned data verified: ${indexCount} index, ${docCount} documents`)
  })

  it('should stop and rename container', async () => {
    console.log(`\n Renaming container and changing port...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    // Stop the container if running (might already be stopped from previous test)
    const engine = getEngine(ENGINE)
    const isRunning = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    if (isRunning) {
      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
    }

    // Always wait for container to be fully stopped
    const stopped = await waitForStopped(containerName, ENGINE, 60000)
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
      await waitForStopped(clonedContainerName, ENGINE, 60000)
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
