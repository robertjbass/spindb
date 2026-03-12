/**
 * libSQL (sqld) System Integration Tests
 *
 * Tests the full container lifecycle with real sqld processes.
 * libSQL is a SQLite fork with HTTP API access via the Hrana protocol.
 * Single database per instance ('main'), no create/drop database.
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
import { logDebug } from '../../core/error-handler'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { libsqlQuery, libsqlApiRequest } from '../../engines/libsql/api-client'

const ENGINE = Engine.LibSQL
const DATABASE = 'main' // libSQL runs a single database per instance
const TEST_VERSION = '0' // Major version - will be resolved to full version via version map

describe('libSQL Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let authToken: string | undefined

  before(async () => {
    console.log('\n Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    console.log('\n Finding available test ports...')
    // libSQL uses a single HTTP port, so we only need 3 ports
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.libsql.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('libsql-test')
    clonedContainerName = generateTestName('libsql-test-clone')
    renamedContainerName = generateTestName('libsql-test-renamed')
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

    // Ensure libSQL binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring libSQL binaries are available...')
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

    // Wait for sqld to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'libSQL should be ready to accept connections')

    const running = await processManager.isRunning(containerName, {
      engine: ENGINE,
    })
    assert(running, 'Container should be running')

    console.log('   Container started and ready')
  })

  it('should respond to health check', async () => {
    console.log('\n Checking health endpoint...')

    const response = await libsqlApiRequest(testPorts[0], 'GET', '/health')
    assertEqual(response.status, 200, 'Health endpoint should return 200')

    console.log('   Health check passed')
  })

  it('should create table and insert data via Hrana protocol', async () => {
    console.log('\n Creating table and inserting test data...')

    // Create a test table
    await libsqlQuery(
      testPorts[0],
      `CREATE TABLE IF NOT EXISTS test_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
    )

    // Insert test data
    await libsqlQuery(
      testPorts[0],
      `INSERT OR IGNORE INTO test_user (name, email) VALUES
        ('Alice Johnson', 'alice@example.com'),
        ('Bob Smith', 'bob@example.com'),
        ('Charlie Brown', 'charlie@example.com')`,
    )

    // Verify data was inserted
    const result = await libsqlQuery(
      testPorts[0],
      'SELECT COUNT(*) as count FROM test_user',
    )
    assertEqual(result.rows.length, 1, 'Should return one row')

    const count = Number(
      result.rows[0][0].type === 'integer' ? result.rows[0][0].value : 0,
    )
    assertEqual(count, 3, 'Should have 3 rows')

    console.log(`   Created table with ${count} rows`)
  })

  it('should query data using executeQuery', async () => {
    logDebug('Querying data using engine.executeQuery...')

    // Test SELECT query via the engine's executeQuery interface
    const selectResult = await executeQuery(
      containerName,
      'SELECT name, email FROM test_user ORDER BY name',
    )

    assertEqual(selectResult.rowCount, 3, 'Should return 3 rows')
    assertTruthy(
      selectResult.columns.includes('name'),
      'Should have "name" column',
    )
    assertTruthy(
      selectResult.columns.includes('email'),
      'Should have "email" column',
    )

    // Verify row data
    const firstRow = selectResult.rows[0] as Record<string, unknown>
    assertEqual(firstRow.name, 'Alice Johnson', 'First row should be Alice')
    assertEqual(
      firstRow.email,
      'alice@example.com',
      'First row email should match',
    )

    // Test sqlite_master query (list tables)
    const tablesResult = await executeQuery(
      containerName,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    assertTruthy(tablesResult.rowCount >= 1, 'Should have at least one table')

    logDebug(`executeQuery returned ${selectResult.rowCount} rows`)
  })

  it('should create user with JWT authentication', async () => {
    console.log('\n Creating JWT auth user...')

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    const credentials = await engine.createUser(config!, {
      username: 'auth_token',
      password: '',
    })

    assertTruthy(
      credentials.apiKey,
      'Credentials should have a non-empty apiKey',
    )
    assertEqual(
      credentials.password,
      '',
      'Password should be empty for JWT auth',
    )
    assertEqual(
      credentials.username,
      'auth_token',
      'Username should be auth_token',
    )
    assertEqual(credentials.engine, ENGINE, 'Engine should match')

    // Store the token for later tests
    authToken = credentials.apiKey

    // Wait for sqld to be ready after restart
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'libSQL should be ready after auth restart')

    console.log('   JWT auth user created')
  })

  it('should be idempotent on createUser', async () => {
    console.log('\n Testing createUser idempotency...')

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    const credentials = await engine.createUser(config!, {
      username: 'auth_token',
      password: '',
    })

    assertTruthy(
      credentials.apiKey,
      'Credentials should have apiKey on second call',
    )
    assertEqual(
      credentials.apiKey,
      authToken,
      'Token should be the same on idempotent call',
    )

    console.log('   createUser idempotency verified')
  })

  it('should query with authentication after createUser', async () => {
    console.log('\n Querying with auth via executeQuery...')

    // executeQuery loads credentials automatically via loadAuthToken
    const result = await executeQuery(
      containerName,
      'SELECT COUNT(*) as count FROM test_user',
    )

    assertEqual(result.rowCount, 1, 'Should return one row')
    const firstRow = result.rows[0] as Record<string, unknown>
    assertEqual(firstRow.count, 3, 'Should have 3 rows')

    console.log('   Authenticated query succeeded')
  })

  it('should reject unauthenticated requests after auth is enabled', async () => {
    console.log('\n Testing unauthenticated request rejection...')

    let rejected = false
    try {
      // Direct libsqlQuery call without auth token should fail
      await libsqlQuery(testPorts[0], 'SELECT 1')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      assertTruthy(
        message.includes('401'),
        'Error should indicate 401 unauthorized',
      )
      rejected = true
    }

    assert(rejected, 'Unauthenticated request should be rejected with 401')

    console.log('   Unauthenticated request correctly rejected')
  })

  it('should backup in binary format (file copy)', async () => {
    console.log('\n Creating binary backup...')

    const { tmpdir } = await import('os')
    const backupPath = `${tmpdir()}/libsql-test-backup-binary-${Date.now()}.db`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    const engine = getEngine(ENGINE)
    const result = await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'binary',
    })

    assertTruthy(result.size > 0, 'Backup file should have content')
    assertEqual(result.format, 'binary', 'Backup format should be binary')

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   Binary backup created (${result.size} bytes)`)
  })

  it('should backup in sql format (HTTP API dump)', async () => {
    console.log('\n Creating SQL backup...')

    const { tmpdir } = await import('os')
    const backupPath = `${tmpdir()}/libsql-test-backup-sql-${Date.now()}.sql`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    const engine = getEngine(ENGINE)
    const result = await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    assertTruthy(result.size > 0, 'SQL backup file should have content')
    assertEqual(result.format, 'sql', 'Backup format should be sql')

    // Verify the SQL dump contains expected content
    const { readFile } = await import('fs/promises')
    const content = await readFile(backupPath, 'utf-8')
    assertTruthy(
      content.includes('CREATE TABLE'),
      'SQL dump should contain CREATE TABLE',
    )
    assertTruthy(
      content.includes('test_user'),
      'SQL dump should reference test_user table',
    )
    assertTruthy(
      content.includes('INSERT INTO'),
      'SQL dump should contain INSERT statements',
    )

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   SQL backup created (${result.size} bytes)`)
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
    const backupPath = `${tmpdir()}/libsql-test-backup-${Date.now()}.db`

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'binary',
    })

    // Stop source for restore (restore needs container stopped for binary format)
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
    assert(ready, 'Cloned libSQL should be ready')

    // Clean up backup file
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   Container cloned via backup/restore')
  })

  it('should verify cloned data matches source', async () => {
    console.log('\n Verifying cloned data matches source...')

    // Query the cloned container to verify data
    const result = await libsqlQuery(
      testPorts[1],
      'SELECT COUNT(*) as count FROM test_user',
    )
    assertEqual(result.rows.length, 1, 'Should return one row')

    const count = Number(
      result.rows[0][0].type === 'integer' ? result.rows[0][0].value : 0,
    )
    assertEqual(count, 3, 'Cloned container should have 3 rows')

    // Verify specific data
    const dataResult = await libsqlQuery(
      testPorts[1],
      'SELECT name FROM test_user ORDER BY name',
    )
    assertEqual(dataResult.rows.length, 3, 'Should have 3 rows')

    const firstName = String(
      dataResult.rows[0][0].type === 'text' ? dataResult.rows[0][0].value : '',
    )
    assertEqual(firstName, 'Alice Johnson', 'First name should match')

    console.log(`   Cloned data verified: ${count} rows`)
  })

  it('should stop and rename container', async () => {
    console.log('\n Renaming container and changing port...')

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
    console.log('\n Verifying no test containers remain...')

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   All test containers cleaned up')
  })
})
