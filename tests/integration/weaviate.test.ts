/**
 * Weaviate System Integration Tests
 *
 * Tests the full container lifecycle with real Weaviate processes.
 * Weaviate is an AI-native vector database with REST/GraphQL and gRPC APIs.
 *
 * TODO: Add integration tests for dumpFromConnectionString once we have a
 * test environment with remote Weaviate instances (e.g., via Docker Compose in CI).
 * Currently, connection string parsing is tested in unit/weaviate-restore.test.ts.
 */

import { describe, it, before, after } from 'node:test'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getWeaviateClassCount,
  createWeaviateClass,
  insertWeaviateObjects,
  waitForReady,
  waitForStopped,
  containerDataExists,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import {
  getDefaultUsername,
  saveCredentials,
} from '../../core/credential-manager'
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.Weaviate
const DATABASE = 'default' // Weaviate uses classes/collections, not traditional databases
const TEST_CLASS = 'TestVectors'
const TEST_VERSION = '1' // Major version - will be resolved to full version via version map
const IS_WINDOWS = process.platform === 'win32'

// Weaviate on Windows holds LSM file locks that prevent fsync during backup,
// causing "Access is denied" errors. Skip backup/restore tests on Windows.
const SKIP_BACKUP_ON_WINDOWS = IS_WINDOWS
  ? 'Weaviate backup fails on Windows due to LSM file locking (Access is denied)'
  : false

describe('Weaviate Integration Tests', () => {
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
    // Weaviate uses HTTP port + 1 for gRPC, so we need 2 ports per container
    // Request 6 consecutive ports and use every other one to avoid gRPC conflicts
    const allPorts = await findConsecutiveFreePorts(6, TEST_PORTS.weaviate.base)
    testPorts = [allPorts[0], allPorts[2], allPorts[4]]
    console.log(
      `   Using ports: ${testPorts.join(', ')} (with gRPC on +1 each)`,
    )

    containerName = generateTestName('weaviate-test')
    clonedContainerName = generateTestName('weaviate-test-clone')
    renamedContainerName = generateTestName('weaviate-test-renamed')
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

    // Ensure Weaviate binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring Weaviate binaries are available...')
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

    // Wait for Weaviate to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'Weaviate should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   Container started and ready')
  })

  it('should create class and insert data', async () => {
    console.log(`\n Creating class and inserting test data...`)

    // Create a test class
    const created = await createWeaviateClass(testPorts[0], TEST_CLASS)
    assert(created, 'Should create class')

    // Insert some test objects
    const objects = [
      {
        properties: { content: 'test object 1' },
        vector: [0.1, 0.2, 0.3, 0.4],
      },
      {
        properties: { content: 'test object 2' },
        vector: [0.2, 0.3, 0.4, 0.5],
      },
      {
        properties: { content: 'test object 3' },
        vector: [0.3, 0.4, 0.5, 0.6],
      },
    ]
    const inserted = await insertWeaviateObjects(
      testPorts[0],
      TEST_CLASS,
      objects,
    )
    assert(inserted, 'Should insert objects')

    // Verify class count
    const classCount = await getWeaviateClassCount(testPorts[0])
    assertEqual(classCount, 1, 'Should have 1 class')

    console.log(`   Created class with test objects`)
  })

  it('should query data using executeQuery (REST API)', async () => {
    logDebug('Querying data using engine.executeQuery (REST API)...')

    // Test GET schema (REST API query format: METHOD /path)
    const schemaResult = await executeQuery(containerName, 'GET /v1/schema')

    // Verify schema is returned
    assertEqual(schemaResult.rowCount, 1, 'Should have one result object')
    assertTruthy(
      schemaResult.columns.includes('classes'),
      'Should have classes in result',
    )

    // Test GET class info
    const classResult = await executeQuery(
      containerName,
      `GET /v1/schema/${TEST_CLASS}`,
    )

    assertEqual(classResult.rowCount, 1, 'Should return class info')

    logDebug(`REST API query returned schema info`)
  })

  it(
    'should clone container using backup/restore',
    { skip: SKIP_BACKUP_ON_WINDOWS },
    async () => {
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

      // Create backup from source (backup is a directory, not a single file)
      const { tmpdir } = await import('os')
      const backupPath = `${tmpdir()}/weaviate-test-backup-${Date.now()}`

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
      const stopped = await waitForStopped(containerName, ENGINE, 90000)
      assert(stopped, 'Source container should be fully stopped before restore')

      // Restore to cloned container (copies backup dir into clone's backups path)
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
      assert(ready, 'Cloned Weaviate should be ready')

      // Trigger restore via Weaviate API
      // Read the real backup ID from backup_config.json (Weaviate validates the match)
      const { readFile } = await import('fs/promises')
      const { join: joinPath } = await import('path')
      const backupConfigPath = joinPath(backupPath, 'backup_config.json')
      const backupConfig = JSON.parse(
        await readFile(backupConfigPath, 'utf-8'),
      ) as { id: string }
      const backupId = backupConfig.id
      console.log(`   Using backup ID from config: ${backupId}`)

      // Weaviate requires node_mapping when restoring to a different node hostname
      const sourceHostname = `node-${testPorts[0]}`
      const targetHostname = `node-${testPorts[1]}`
      const restoreResponse = await fetch(
        `http://127.0.0.1:${testPorts[1]}/v1/backups/filesystem/${backupId}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_mapping: { [sourceHostname]: targetHostname },
          }),
        },
      )
      if (!restoreResponse.ok) {
        const errorText = await restoreResponse.text()
        console.log(
          `   Restore API response: ${restoreResponse.status} - ${errorText}`,
        )
        console.log(`   Backup ID: ${backupId}`)
      }
      assert(restoreResponse.ok, 'Restore API call should succeed')

      // Wait for restore to complete
      let restored = false
      let finalStatus = ''
      for (let i = 0; i < 30; i++) {
        const statusResp = await fetch(
          `http://127.0.0.1:${testPorts[1]}/v1/backups/filesystem/${backupId}/restore`,
        )
        if (statusResp.ok) {
          const status = (await statusResp.json()) as { status: string }
          finalStatus = status.status
          if (finalStatus === 'SUCCESS') {
            restored = true
            break
          }
          if (finalStatus === 'FAILED') {
            throw new Error('Restore failed')
          }
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
      assert(
        restored,
        `Restore should have completed (last status: "${finalStatus || 'no response'}")`,
      )

      // Clean up backup directory
      const { rm } = await import('fs/promises')
      await rm(backupPath, { recursive: true, force: true })

      console.log('   Container cloned via backup/restore')
    },
  )

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

  it(
    'should backup with API-key auth and restore successfully',
    { skip: SKIP_BACKUP_ON_WINDOWS },
    async () => {
      console.log('\n Testing auth-backed Weaviate backup/restore...')

      const allPorts = await findConsecutiveFreePorts(4, TEST_PORTS.weaviate.base + 20)
      const [sourcePort, targetPort] = [allPorts[0], allPorts[2]]
      const sourceName = generateTestName('weaviate-auth-test-source')
      const targetName = generateTestName('weaviate-auth-test-target')
      const username = getDefaultUsername(ENGINE)
      const sourceApiKey = 'weaviate-source-key-123'
      const targetApiKey = 'weaviate-target-key-456'
      const { tmpdir } = await import('os')
      const { rm, readFile } = await import('fs/promises')
      const { join: joinPath } = await import('path')
      const backupPath = `${tmpdir()}/weaviate-auth-backup-${Date.now()}`
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
        assert(sourceReady, 'Source Weaviate should be ready')

        const created = await createWeaviateClass(sourcePort, TEST_CLASS)
        assert(created, 'Should create source class')
        const inserted = await insertWeaviateObjects(sourcePort, TEST_CLASS, [
          {
            properties: { content: 'alpha document' },
            vector: [0.1, 0.2, 0.3],
          },
          {
            properties: { content: 'beta document' },
            vector: [0.4, 0.5, 0.6],
          },
        ])
        assert(inserted, 'Should insert source objects')

        const sourceCreds = await engine.createUser(sourceConfig!, {
          username,
          password: sourceApiKey,
        })
        await saveCredentials(sourceName, ENGINE, sourceCreds)

        const sourceAuthedReady = await waitForReady(ENGINE, sourcePort)
        assert(sourceAuthedReady, 'Source Weaviate should be ready after auth restart')

        await containerManager.create(targetName, {
          engine: ENGINE,
          version: TEST_VERSION,
          port: targetPort,
          database: DATABASE,
        })
        await engine.initDataDir(targetName, TEST_VERSION, { port: targetPort })

        const targetConfig = await containerManager.getConfig(targetName)
        assert(targetConfig !== null, 'Target container config should exist')
        await engine.start(targetConfig!)
        await containerManager.updateConfig(targetName, { status: 'running' })

        const targetReady = await waitForReady(ENGINE, targetPort)
        assert(targetReady, 'Target Weaviate should be ready before auth config')

        const targetCreds = await engine.createUser(targetConfig!, {
          username,
          password: targetApiKey,
        })
        await saveCredentials(targetName, ENGINE, targetCreds)

        const targetAuthedReady = await waitForReady(ENGINE, targetPort)
        assert(targetAuthedReady, 'Target Weaviate should be ready after auth restart')

        await engine.stop(targetConfig!)
        await containerManager.updateConfig(targetName, { status: 'stopped' })
        const targetStopped = await waitForStopped(targetName, ENGINE, 90000)
        assert(targetStopped, 'Target should stop before restore copy')

        await engine.backup(sourceConfig!, backupPath, {
          database: DATABASE,
          format: 'snapshot',
        })

        await engine.restore(targetConfig!, backupPath, {
          database: DATABASE,
        })

        await engine.start(targetConfig!)
        await containerManager.updateConfig(targetName, { status: 'running' })
        const restoredReady = await waitForReady(ENGINE, targetPort)
        assert(restoredReady, 'Target Weaviate should be ready after restore')

        const backupConfigPath = joinPath(backupPath, 'backup_config.json')
        const backupConfig = JSON.parse(
          await readFile(backupConfigPath, 'utf-8'),
        ) as { id: string }
        const backupId = backupConfig.id

        const sourceHostname = `node-${sourcePort}`
        const targetHostname = `node-${targetPort}`
        const restoreResponse = await fetch(
          `http://127.0.0.1:${targetPort}/v1/backups/filesystem/${backupId}/restore`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${targetCreds.apiKey}`,
            },
            body: JSON.stringify({
              node_mapping: { [sourceHostname]: targetHostname },
            }),
          },
        )
        assert(restoreResponse.ok, 'Auth-backed restore API call should succeed')

        let restored = false
        for (let attempt = 0; attempt < 30; attempt++) {
          const statusResp = await fetch(
            `http://127.0.0.1:${targetPort}/v1/backups/filesystem/${backupId}/restore`,
            {
              headers: { Authorization: `Bearer ${targetCreds.apiKey}` },
            },
          )
          if (statusResp.ok) {
            const status = (await statusResp.json()) as { status: string }
            if (status.status === 'SUCCESS') {
              restored = true
              break
            }
            if (status.status === 'FAILED') {
              throw new Error('Weaviate restore failed')
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        assert(restored, 'Weaviate auth-backed restore should complete')

        const queryResult = await engine.executeQuery(
          targetConfig!,
          `GET /v1/objects?class=${TEST_CLASS}&limit=10`,
          {
            password: targetCreds.apiKey,
          },
        )
        const restoredObjects =
          (queryResult.rows[0] as { objects?: unknown[] } | undefined)
            ?.objects ?? []
        assertEqual(
          restoredObjects.length,
          2,
          'Should query restored objects with API key',
        )

        console.log('   API-key Weaviate backup/restore succeeded')
      } finally {
        await rm(backupPath, { recursive: true, force: true }).catch(() => {})

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
    },
  )

  it('should delete cloned container', async () => {
    console.log(`\n Deleting cloned container "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    if (!config) {
      // Clone test was skipped (e.g., on Windows), nothing to delete
      console.log('   Cloned container does not exist (clone test was skipped)')
      return
    }

    const engine = getEngine(ENGINE)
    await engine.stop(config)
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
