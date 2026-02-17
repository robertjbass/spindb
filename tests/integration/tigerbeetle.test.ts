/**
 * TigerBeetle System Integration Tests
 *
 * Tests the full container lifecycle with real TigerBeetle processes.
 * TigerBeetle is a high-performance financial ledger database with a
 * custom binary protocol (no REST/SQL).
 *
 * Note: No data operation tests via REST/SQL (custom binary protocol).
 * REPL connect is tested by verifying the process spawns correctly.
 */

import { describe, it, before, after } from 'node:test'

import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  waitForReady,
  waitForStopped,
  containerDataExists,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.TigerBeetle
const DATABASE = 'default' // TigerBeetle has no database concept
const TEST_VERSION = '0.16'

describe('TigerBeetle Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let renamedContainerName: string

  before(async () => {
    console.log('\n Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    console.log('\n Finding available test ports...')
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.tigerbeetle.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('tigerbeetle-test')
    renamedContainerName = generateTestName('tigerbeetle-test-renamed')
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

    // Ensure TigerBeetle binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring TigerBeetle binaries are available...')
    await engine.ensureBinaries(TEST_VERSION, ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0],
      database: DATABASE,
    })

    // Initialize the data directory (runs tigerbeetle format)
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

    // Wait for TigerBeetle to be ready (TCP port check)
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'TigerBeetle should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   Container started and ready')
  })

  it('should report correct status', async () => {
    console.log(`\n Checking container status...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    const status = await engine.status(config!)
    assert(status.running, 'Status should indicate running')
    assert(status.message.length > 0, 'Status message should not be empty')

    console.log('   Status verified as running')
  })

  it('should get connection string', async () => {
    console.log(`\n Getting connection string...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    const connString = engine.getConnectionString(config!)
    assert(
      connString.includes(String(testPorts[0])),
      'Connection string should include port',
    )
    assert(
      connString.includes('127.0.0.1'),
      'Connection string should include host',
    )

    console.log(`   Connection string: ${connString}`)
  })

  it('should stop and backup container (stop-and-copy)', async () => {
    console.log(`\n Backing up container...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)

    // Stop the container (required for TigerBeetle backup)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    const stopped = await waitForStopped(containerName, ENGINE, 30000)
    assert(stopped, 'Container should be fully stopped')

    // Create backup
    const { tmpdir } = await import('os')
    const backupPath = `${tmpdir()}/tigerbeetle-test-backup-${Date.now()}.tigerbeetle`

    await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'binary',
    })

    // Verify backup file exists
    const { existsSync } = await import('fs')
    assert(existsSync(backupPath), 'Backup file should exist')

    // Restart container
    await engine.start(config!)
    await containerManager.updateConfig(containerName, { status: 'running' })
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'TigerBeetle should be ready after restart')

    // Clean up backup
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   Backup completed successfully')
  })

  it('should stop and rename container', async () => {
    console.log(`\n Renaming container and changing port...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    const stopped = await waitForStopped(containerName, ENGINE, 30000)
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
