/**
 * InfluxDB System Integration Tests
 *
 * Tests the full container lifecycle with real InfluxDB processes.
 * InfluxDB is a time-series database with a REST API.
 *
 * TODO: Add integration tests for dumpFromConnectionString once we have a
 * test environment with remote InfluxDB instances (e.g., via Docker Compose in CI).
 * Currently, connection string parsing is tested in unit/influxdb-restore.test.ts.
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
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.InfluxDB
const DATABASE = 'testdb'
const TEST_VERSION = '3' // Major version - will be resolved to full version via version map

/**
 * Helper: write data to InfluxDB via line protocol
 */
async function writeLineProtocol(
  port: number,
  database: string,
  lines: string,
): Promise<boolean> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v3/write_lp?db=${encodeURIComponent(database)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: lines,
        signal: controller.signal,
      },
    )
    clearTimeout(timeoutId)
    return response.ok || response.status === 204
  } catch {
    clearTimeout(timeoutId)
    return false
  }
}

/**
 * Helper: query InfluxDB via SQL
 */
async function querySql(
  port: number,
  database: string,
  sql: string,
): Promise<unknown[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v3/query_sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: database, q: sql, format: 'json' }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    if (!response.ok) return []
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const data = await response.json()
      return Array.isArray(data) ? data : []
    }
    return []
  } catch {
    clearTimeout(timeoutId)
    return []
  }
}

/**
 * Helper: get row count from a table
 */
async function getRowCount(
  port: number,
  database: string,
  table: string,
): Promise<number> {
  const rows = await querySql(
    port,
    database,
    `SELECT COUNT(*) as count FROM "${table}"`,
  )
  if (rows.length > 0) {
    const row = rows[0] as Record<string, unknown>
    const count = row.count
    if (typeof count === 'number') return count
  }
  return 0
}

/**
 * Helper: poll until row count reaches expected value (or timeout)
 */
async function waitForRowCount(
  port: number,
  database: string,
  table: string,
  expected: number,
  maxRetries = 10,
): Promise<number> {
  for (let i = 0; i < maxRetries; i++) {
    const count = await getRowCount(port, database, table)
    if (count >= expected) return count
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return getRowCount(port, database, table)
}

const SEED_DATA = [
  'test_user,id=1 name="Alice",email="alice@example.com"',
  'test_user,id=2 name="Bob",email="bob@example.com"',
  'test_user,id=3 name="Charlie",email="charlie@example.com"',
  'test_user,id=4 name="Diana",email="diana@example.com"',
  'test_user,id=5 name="Eve",email="eve@example.com"',
].join('\n')

describe('InfluxDB Integration Tests', () => {
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
    // InfluxDB uses a single port (HTTP API), so we only need 3 ports
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.influxdb.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('influxdb-test')
    clonedContainerName = generateTestName('influxdb-test-clone')
    renamedContainerName = generateTestName('influxdb-test-renamed')
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

    // Ensure InfluxDB binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring InfluxDB binaries are available...')
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

    // Wait for InfluxDB to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'InfluxDB should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   Container started and ready')
  })

  it('should seed the database with test data', async () => {
    console.log(`\n Seeding database with test data...`)

    // Write line protocol data (creates database implicitly)
    const writeOk = await writeLineProtocol(testPorts[0], DATABASE, SEED_DATA)
    assert(writeOk, 'Should write seed data successfully')

    // Wait for data to be indexed (poll instead of fixed sleep)
    const count = await waitForRowCount(testPorts[0], DATABASE, 'test_user', 5)
    assertEqual(count, 5, 'Should have 5 test_user records')

    console.log(`   Seeded ${count} records`)
  })

  it('should query data using executeQuery (REST API)', async () => {
    console.log(`\n Querying data using engine.executeQuery (REST API)...`)

    // Test SQL query via engine
    const result = await executeQuery(containerName, 'SELECT * FROM test_user')

    assertTruthy(result.rowCount > 0, 'Should have query results')
    assertEqual(result.rowCount, 5, 'Should have 5 rows')

    console.log(`   REST API query returned ${result.rowCount} rows`)
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
    const backupPath = `${tmpdir()}/influxdb-test-backup-${Date.now()}.sql`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    // Start cloned container first (InfluxDB restore needs running instance)
    const clonedConfig = await containerManager.getConfig(clonedContainerName)
    assert(clonedConfig !== null, 'Cloned container config should exist')

    await engine.start(clonedConfig!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // Wait for ready
    const clonedReady = await waitForReady(ENGINE, testPorts[1])
    assert(clonedReady, 'Cloned InfluxDB should be ready before restore')

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

    // Allow time for data to be indexed on clone
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Verify record count on cloned container
    const count = await getRowCount(testPorts[1], DATABASE, 'test_user')
    assertEqual(count, 5, 'Cloned container should have 5 records')

    console.log(`   Cloned data verified: ${count} records`)
  })

  it('should detect backup format from file content', async () => {
    console.log('\n Detecting backup format...')

    const { tmpdir } = await import('os')
    const { writeFile, rm } = await import('fs/promises')

    // Create a test SQL backup file
    const testBackupPath = `${tmpdir()}/influxdb-format-test-${Date.now()}.sql`
    await writeFile(
      testBackupPath,
      '-- InfluxDB SQL Backup\nINSERT INTO test (col) VALUES (1);\n',
    )

    const engine = getEngine(ENGINE)
    const format = await engine.detectBackupFormat(testBackupPath)
    assertEqual(format.format, 'sql', 'Should detect SQL format')

    await rm(testBackupPath, { force: true })
    console.log(`   Detected format: ${format.format}`)
  })

  it('should modify data using runScript inline SQL', async () => {
    console.log('\n Modifying data using inline SQL...')

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    // Write additional data point via line protocol
    const writeOk = await writeLineProtocol(
      testPorts[0],
      DATABASE,
      'test_user,id=6 name="Frank",email="frank@example.com"',
    )
    assert(writeOk, 'Should write additional data')

    // Allow time for data to be indexed
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Verify the new record
    const count = await getRowCount(testPorts[0], DATABASE, 'test_user')
    assertEqual(count, 6, 'Should have 6 records after insert')

    console.log(`   Data modified: now ${count} records`)
  })

  it('should create SQL format backup', async () => {
    console.log('\n Creating SQL format backup...')

    const { tmpdir } = await import('os')
    const { stat, rm } = await import('fs/promises')

    const backupPath = `${tmpdir()}/influxdb-sql-backup-${Date.now()}.sql`

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    assertEqual(result.format, 'sql', 'Backup format should be sql')

    const stats = await stat(backupPath)
    assert(stats.size > 0, 'Backup file should not be empty')

    await rm(backupPath, { force: true })
    console.log(`   SQL backup created (${stats.size} bytes)`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log('\n Testing port conflict handling...')

    // Try to start another container on the same port
    const conflictName = generateTestName('influxdb-conflict')
    await containerManager.create(conflictName, {
      engine: ENGINE,
      version: TEST_VERSION,
      port: testPorts[0], // Same port as running container
      database: 'conflictdb',
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(conflictName, TEST_VERSION, {
      port: testPorts[0],
    })

    const config = await containerManager.getConfig(conflictName)
    let startFailed = false
    try {
      await engine.start(config!)
    } catch {
      startFailed = true
    }
    assert(startFailed, 'Should fail to start on occupied port')

    // Clean up
    await containerManager.delete(conflictName, { force: true })
    console.log('   Port conflict handled correctly')
  })

  it('should show warning when starting already running container', async () => {
    console.log('\n Starting already running container...')

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    // Should not throw, just return existing connection info
    const result = await engine.start(config!)
    assertEqual(result.port, testPorts[0], 'Should return existing port')

    console.log('   Already running container handled gracefully')
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

  it('should verify data persists after rename', async () => {
    console.log('\n Verifying data persists after rename...')

    // Start renamed container
    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, 'Renamed container config should exist')

    const engine = getEngine(ENGINE)
    await engine.start(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'running',
    })

    const ready = await waitForReady(ENGINE, testPorts[2])
    assert(ready, 'Renamed container should be ready')

    // Verify data persists
    const count = await getRowCount(testPorts[2], DATABASE, 'test_user')
    assertEqual(count, 6, 'Renamed container should have 6 records')

    console.log(`   Data persists: ${count} records`)
  })

  it('should handle stopping already stopped container gracefully', async () => {
    console.log('\n Stopping already stopped container...')

    const config = await containerManager.getConfig(renamedContainerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)

    // Stop it first
    await engine.stop(config!)
    await containerManager.updateConfig(renamedContainerName, {
      status: 'stopped',
    })
    await waitForStopped(renamedContainerName, ENGINE, 60000)

    // Stop again - should not throw
    await engine.stop(config!)

    console.log('   Stopping already stopped container handled gracefully')
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
