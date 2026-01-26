/**
 * CouchDB System Integration Tests
 *
 * Tests the full container lifecycle with real CouchDB processes.
 * CouchDB is a document database with REST API.
 *
 * TODO: Add integration tests for dumpFromConnectionString once we have a
 * test environment with remote CouchDB instances (e.g., via Docker Compose in CI).
 * Currently, connection string parsing is tested in unit/couchdb-restore.test.ts.
 */

import { describe, it, before, after } from 'node:test'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getCouchDBDatabaseCount,
  createCouchDBDatabase,
  insertCouchDBDocuments,
  getCouchDBDocumentCount,
  waitForReady,
  waitForStopped,
  containerDataExists,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.CouchDB
const DATABASE = 'test_db'
const TEST_VERSION = '3' // Major version - will be resolved to full version via version map

describe('CouchDB Integration Tests', () => {
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
    // CouchDB uses a single port (HTTP API), so we only need 3 ports
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.couchdb.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('couchdb-test')
    clonedContainerName = generateTestName('couchdb-test-clone')
    renamedContainerName = generateTestName('couchdb-test-renamed')
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

    // Ensure CouchDB binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring CouchDB binaries are available...')
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

    // Wait for CouchDB to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'CouchDB should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   Container started and ready')
  })

  it('should create database and insert data', async () => {
    console.log(`\n Creating database and inserting test data...`)

    // Create a test database
    const createResult = await createCouchDBDatabase(testPorts[0], DATABASE)
    assert(createResult, 'Should create database')

    // Insert some test documents
    const documents = [
      { _id: 'user1', name: 'Alice', age: 30 },
      { _id: 'user2', name: 'Bob', age: 25 },
      { _id: 'user3', name: 'Charlie', age: 35 },
      { _id: 'user4', name: 'Diana', age: 28 },
      { _id: 'user5', name: 'Eve', age: 32 },
    ]
    const insertResult = await insertCouchDBDocuments(
      testPorts[0],
      DATABASE,
      documents,
    )
    assert(insertResult, 'Should insert documents')

    // Verify database count (should have at least 1 user-created database)
    const dbCount = await getCouchDBDatabaseCount(testPorts[0])
    assert(dbCount >= 1, 'Should have at least 1 database')

    // Verify document count
    const docCount = await getCouchDBDocumentCount(testPorts[0], DATABASE)
    assertEqual(docCount, 5, 'Should have 5 documents')

    console.log(`   Created database with ${docCount} documents`)
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
    const backupPath = `${tmpdir()}/couchdb-test-backup-${Date.now()}.json`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'json',
    })

    // Start cloned container first (CouchDB restore needs running instance)
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, 'Cloned container config should exist')

    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // Wait for ready
    const clonedReady = await waitForReady(ENGINE, testPorts[1])
    assert(clonedReady, 'Cloned CouchDB should be ready before restore')

    // Restore to cloned container
    await engine.restore(clonedConfig!, backupPath, {
      database: DATABASE,
    })

    // Clean up backup file
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   Container cloned via backup/restore')
  })

  it('should verify cloned data matches source', async () => {
    console.log('\n Verifying cloned data matches source...')

    // Verify database exists on cloned container
    const dbCount = await getCouchDBDatabaseCount(testPorts[1])
    assert(dbCount >= 1, 'Cloned container should have at least 1 database')

    // Verify document count on cloned container
    const docCount = await getCouchDBDocumentCount(testPorts[1], DATABASE)
    assertEqual(docCount, 5, 'Cloned container should have 5 documents')

    console.log(`   Cloned data verified: ${dbCount} database(s), ${docCount} documents`)
  })

  it('should stop and rename container', async () => {
    console.log(`\n Renaming container and changing port...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    // Stop the container if running
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
