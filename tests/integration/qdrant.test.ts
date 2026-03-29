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
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { getDefaultUsername, saveCredentials } from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
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
    console.log(
      `   Using ports: ${testPorts.join(', ')} (with gRPC on +1 each)`,
    )

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
    await engine.initDataDir(containerName, TEST_VERSION, {
      port: testPorts[0],
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
    const inserted = await insertQdrantPoints(
      testPorts[0],
      TEST_COLLECTION,
      points,
    )
    assert(inserted, 'Should insert points')

    // Verify collection count
    const collectionCount = await getQdrantCollectionCount(testPorts[0])
    assertEqual(collectionCount, 1, 'Should have 1 collection')

    // Verify point count
    const pointCount = await getQdrantPointCount(testPorts[0], TEST_COLLECTION)
    assertEqual(pointCount, 3, 'Should have 3 points')

    console.log(`   Created collection with ${pointCount} points`)
  })

  it('should query data using executeQuery (REST API)', async () => {
    logDebug('Querying data using engine.executeQuery (REST API)...')

    // Test GET collections (REST API query format: METHOD /path)
    const collectionsResult = await executeQuery(
      containerName,
      'GET /collections',
    )

    // Verify collections are returned (Qdrant returns { result: { collections: [...] } })
    assertEqual(collectionsResult.rowCount, 1, 'Should have one result object')
    assertTruthy(
      collectionsResult.columns.includes('collections'),
      'Should have collections in result',
    )

    // Test GET collection info
    const collectionResult = await executeQuery(
      containerName,
      `GET /collections/${TEST_COLLECTION}`,
    )

    assertEqual(collectionResult.rowCount, 1, 'Should return collection info')

    // Test POST scroll to get points
    const scrollResult = await executeQuery(
      containerName,
      `POST /collections/${TEST_COLLECTION}/points/scroll {"limit": 10}`,
    )

    assertEqual(scrollResult.rowCount, 1, 'Should return scroll results')
    // Verify we got points back
    const scrollData = scrollResult.rows[0] as Record<string, unknown>
    const points = scrollData.points as unknown[]
    assertEqual(points.length, 3, 'Should have 3 points')

    logDebug(`REST API query returned collection with ${points.length} points`)
  })

  it('should clone container using backup/restore', async (t) => {
    if (process.platform === 'win32') {
      t.skip(
        'Qdrant snapshot restore is not stable on Windows yet; clone/restore remains covered on Unix runners.',
      )
      return
    }

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

    // Note: We don't restart the source container here because:
    // 1. On Windows, TCP TIME_WAIT can hold ports for minutes after process termination
    // 2. The backup/restore is already verified by the clone starting successfully
    // 3. The next test will handle the source container (rename to different port)

    console.log('   Container cloned via backup/restore')
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

    // Always wait for container to be fully stopped, even if already stopped
    // This ensures file handles are released before rename (especially on Windows)
    const stopped = await waitForStopped(containerName, ENGINE, 120000)
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

  it('should backup with auth-enabled source and restore successfully', async (t) => {
    if (process.platform === 'win32') {
      t.skip(
        'Qdrant auth-backed snapshot restore is not stable on Windows yet; restore coverage remains on Unix runners.',
      )
      return
    }

    console.log(`\n🔐 Testing auth-aware Qdrant backup/restore...`)

    const allPorts = await findConsecutiveFreePorts(4, TEST_PORTS.qdrant.base + 20)
    const [sourcePort, targetPort] = [allPorts[0], allPorts[2]]
    const sourceName = generateTestName('qdrant-auth-test-source')
    const targetName = generateTestName('qdrant-auth-test-target')
    const username = getDefaultUsername(ENGINE)
    const sourceApiKey = 'qdrant-auth-key-123'
    const targetApiKey = 'qdrant-auth-key-456'
    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = `${tmpdir()}/qdrant-auth-backup-${Date.now()}.snapshot`
    const engine = getEngine(ENGINE)

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: sourcePort,
        database: DATABASE,
      })
      await engine.initDataDir(sourceName, TEST_VERSION, { port: sourcePort })

      const sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, 'Source container config should exist')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })

      const sourceReady = await waitForReady(ENGINE, sourcePort)
      assert(sourceReady, 'Source Qdrant should be ready')

      const created = await createQdrantCollection(
        sourcePort,
        TEST_COLLECTION,
        4,
      )
      assert(created, 'Should create source collection')

      const inserted = await insertQdrantPoints(sourcePort, TEST_COLLECTION, [
        { id: 1, vector: [0.1, 0.2, 0.3, 0.4], payload: { name: 'test1' } },
        { id: 2, vector: [0.2, 0.3, 0.4, 0.5], payload: { name: 'test2' } },
        { id: 3, vector: [0.3, 0.4, 0.5, 0.6], payload: { name: 'test3' } },
      ])
      assert(inserted, 'Should insert source points')

      const sourceCreds = await engine.createUser(sourceConfig!, {
        username,
        password: sourceApiKey,
        database: DATABASE,
      })
      await saveCredentials(sourceName, ENGINE, sourceCreds)

      const authedReady = await waitForReady(ENGINE, sourcePort)
      assert(authedReady, 'Auth-enabled source Qdrant should be ready')

      const authResult = await engine.executeQuery(
        sourceConfig!,
        `POST /collections/${TEST_COLLECTION}/points/scroll {"limit": 10}`,
        {
          username: sourceCreds.username,
          password: sourceCreds.apiKey,
        },
      )
      const authRow = authResult.rows[0] as Record<string, unknown>
      const authPoints = authRow.points as unknown[]
      assertEqual(authPoints.length, 3, 'Auth query should see 3 source points')

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, TEST_VERSION, { port: targetPort })

      const targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, 'Target container config should exist')
      const targetCreds = await engine.createUser(targetConfig!, {
        username,
        password: targetApiKey,
        database: DATABASE,
      })
      await saveCredentials(targetName, ENGINE, targetCreds)

      await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'snapshot',
      })

      await engine.stop(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'stopped' })
      const sourceStopped = await waitForStopped(sourceName, ENGINE, 90000)
      assert(sourceStopped, 'Source should stop before restore')

      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
      })

      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      const targetReady = await waitForReady(ENGINE, targetPort)
      assert(targetReady, 'Target Qdrant should be ready after restore')

      let restoredPointCount = 0
      for (let attempt = 0; attempt < 30; attempt++) {
        const restoredResult = await engine.executeQuery(
          targetConfig!,
          `POST /collections/${TEST_COLLECTION}/points/scroll {"limit": 10}`,
          {
            username: targetCreds.username,
            password: targetCreds.apiKey,
          },
        )
        const restoredRow = restoredResult.rows[0] as Record<string, unknown>
        const restoredPoints = restoredRow.points as unknown[]
        restoredPointCount = restoredPoints.length
        if (restoredPointCount === 3) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      assertEqual(
        restoredPointCount,
        3,
        'Restored Qdrant collection should have 3 points',
      )

      console.log(
        '   ✓ Backup works with auth-enabled Qdrant source and restore preserves data',
      )
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})

      const sourceConfig = await containerManager.getConfig(sourceName)
      if (sourceConfig) {
        await engine.stop(sourceConfig).catch(() => {})
        await waitForStopped(sourceName, ENGINE, 90000).catch(() => false)
        await containerManager.delete(sourceName, { force: true }).catch(
          () => {},
        )
      }

      const targetConfig = await containerManager.getConfig(targetName)
      if (targetConfig) {
        await engine.stop(targetConfig).catch(() => {})
        await waitForStopped(targetName, ENGINE, 90000).catch(() => false)
        await containerManager.delete(targetName, { force: true }).catch(
          () => {},
        )
      }
    }
  })

  it('should delete cloned container', async () => {
    console.log(`\n Deleting cloned container "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    if (!config) {
      console.log('   Cloned container not present, skipping delete')
      return
    }

    const engine = getEngine(ENGINE)
    await engine.stop(config)
    // Use longer timeout on Windows for port/file release
    await waitForStopped(clonedContainerName, ENGINE, 90000)

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
