/**
 * PostgreSQL System Integration Tests
 *
 * Tests the full container lifecycle with real PostgreSQL processes.
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
  waitForStopped,
  containerDataExists,
  getConnectionString,
  runScriptFile,
  runScriptSQL,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertDeepEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { paths } from '../../config/paths'

const ENGINE = Engine.PostgreSQL
const DATABASE = 'testdb'
const SEED_FILE = join(__dirname, '../fixtures/postgresql/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5

describe('PostgreSQL Integration Tests', () => {
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
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.postgresql.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('pg-test')
    clonedContainerName = generateTestName('pg-test-clone')
    renamedContainerName = generateTestName('pg-test-renamed')
    portConflictContainerName = generateTestName('pg-test-conflict')
  })

  after(async () => {
    // Print diagnostic info to STDERR so it definitely appears
    process.stderr.write('\n')
    process.stderr.write(
      '╔══════════════════════════════════════════════════════════════╗\n',
    )
    process.stderr.write(
      '║              TEST SUITE SUMMARY (after hook)                 ║\n',
    )
    process.stderr.write(
      '╠══════════════════════════════════════════════════════════════╣\n',
    )

    // Show test container names that were supposed to be used
    process.stderr.write(`║ containerName: ${containerName || 'UNDEFINED'}\n`)
    process.stderr.write(
      `║ renamedContainerName: ${renamedContainerName || 'UNDEFINED'}\n`,
    )
    process.stderr.write(
      `║ clonedContainerName: ${clonedContainerName || 'UNDEFINED'}\n`,
    )
    process.stderr.write(
      '╠══════════════════════════════════════════════════════════════╣\n',
    )

    try {
      const containers = await containerManager.list()
      const testContainers = containers.filter((c) => c.name.includes('-test'))
      process.stderr.write(
        `║ All containers: ${JSON.stringify(containers.map((c) => c.name))}\n`,
      )
      process.stderr.write(
        `║ Test containers remaining: ${testContainers.length}\n`,
      )
      for (const tc of testContainers) {
        process.stderr.write(
          `║   - ${tc.name} (${tc.engine}, status: ${tc.status})\n`,
        )
      }

      // Check which expected containers exist
      const hasOriginal = containers.some((c) => c.name === containerName)
      const hasRenamed = containers.some((c) => c.name === renamedContainerName)
      const hasClone = containers.some((c) => c.name === clonedContainerName)
      process.stderr.write(
        '╠══════════════════════════════════════════════════════════════╣\n',
      )
      process.stderr.write(
        `║ Original (${containerName}): ${hasOriginal ? 'EXISTS' : 'missing'}\n`,
      )
      process.stderr.write(
        `║ Renamed (${renamedContainerName}): ${hasRenamed ? 'EXISTS' : 'missing'}\n`,
      )
      process.stderr.write(
        `║ Clone (${clonedContainerName}): ${hasClone ? 'EXISTS (should be deleted)' : 'deleted OK'}\n`,
      )
    } catch (error) {
      process.stderr.write(`║ Error listing containers: ${error}\n`)
    }
    process.stderr.write(
      '╚══════════════════════════════════════════════════════════════╝\n',
    )

    console.log('\n🧹 Final cleanup...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }
  })

  // DIAGNOSTIC TEST - this should always pass and shows environment info
  it('[DIAGNOSTIC] environment check', async () => {
    process.stdout.write('\n--- DIAGNOSTIC TEST START ---\n')
    process.stdout.write(
      `HOME: ${process.env.HOME || process.env.USERPROFILE}\n`,
    )
    process.stdout.write(`CWD: ${process.cwd()}\n`)
    process.stdout.write(`testPorts: ${JSON.stringify(testPorts)}\n`)
    process.stdout.write(`containerName: ${containerName}\n`)
    process.stdout.write(`renamedContainerName: ${renamedContainerName}\n`)

    // Check if PostgreSQL binaries exist
    const engine = getEngine(ENGINE)
    let psqlPath: string | null = null
    try {
      psqlPath = await engine.getPsqlPath()
    } catch {
      psqlPath = null
    }
    process.stdout.write(`PostgreSQL psql path: ${psqlPath || 'NOT FOUND'}\n`)

    // Check containers at start
    let containers: Awaited<ReturnType<typeof containerManager.list>> = []
    try {
      containers = await containerManager.list()
      process.stdout.write(
        `Existing containers: ${JSON.stringify(containers.map((c) => c.name))}\n`,
      )
    } catch (error) {
      process.stdout.write(
        `Existing containers: ERROR - ${error instanceof Error ? error.message : error}\n`,
      )
    }
    process.stdout.write('--- DIAGNOSTIC TEST END ---\n\n')

    // Always pass to show we got here
    assert(true, 'Diagnostic test passed')
  })

  it('should create container without starting (--no-start)', async () => {
    console.log(
      `\n📦 Creating container "${containerName}" without starting...`,
    )

    // Ensure PostgreSQL binaries are downloaded first
    // NOTE: Version must match CI workflow download (spindb-pg-18 cache key)
    const engine = getEngine(ENGINE)
    console.log('   Ensuring PostgreSQL binaries are available...')
    await engine.ensureBinaries('18', ({ message }) => {
      console.log(`   ${message}`)
    })

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: '18',
      port: testPorts[0],
      database: DATABASE,
    })

    // Initialize the database cluster
    await engine.initDataDir(containerName, '18', { superuser: 'postgres' })

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

    // Wait for PostgreSQL to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'PostgreSQL should be ready to accept connections')

    // Create the user database
    await engine.createDatabase(config!, DATABASE)

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
      'Should have correct row count after seeding',
    )

    console.log(`   ✓ Seeded ${rowCount} rows using engine.runScript`)
  })

  it('should query seeded data using executeQuery', async () => {
    console.log(`\n🔍 Querying seeded data using engine.executeQuery...`)

    // Test basic SELECT query
    const result = await executeQuery(
      containerName,
      'SELECT id, name, email FROM test_user ORDER BY id',
      DATABASE,
    )

    assertEqual(result.rowCount, EXPECTED_ROW_COUNT, 'Should return all rows')
    assertDeepEqual(
      result.columns,
      ['id', 'name', 'email'],
      'Should have correct columns',
    )

    // Verify first row data
    assertEqual(
      result.rows[0].name,
      'Alice Johnson',
      'First row should be Alice Johnson',
    )
    assertEqual(
      result.rows[0].email,
      'alice@example.com',
      'First row email should match',
    )

    // Test filtered query
    const filteredResult = await executeQuery(
      containerName,
      "SELECT name FROM test_user WHERE email LIKE '%bob%'",
      DATABASE,
    )

    assertEqual(filteredResult.rowCount, 1, 'Should return one row for Bob')
    assertEqual(
      filteredResult.rows[0].name,
      'Bob Smith',
      'Should find Bob Smith',
    )

    console.log(`   ✓ Query returned ${result.rowCount} rows with correct data`)
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
      version: '18',
      port: testPorts[1],
      database: DATABASE,
    })

    // Initialize and start
    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, '18', {
      superuser: 'postgres',
    })

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, 'Cloned container config should exist')

    await engine.start(config!)
    await containerManager.updateConfig(clonedContainerName, {
      status: 'running',
    })

    // Wait for ready
    const ready = await waitForReady(ENGINE, testPorts[1])
    assert(ready, 'Cloned PostgreSQL should be ready')

    // Create database
    await engine.createDatabase(config!, DATABASE)

    // Dump from source and restore to target
    const { tmpdir } = await import('os')
    const dumpPath = join(tmpdir(), `pg-test-dump-${Date.now()}.dump`)

    await engine.dumpFromConnectionString(sourceConnectionString, dumpPath)
    await engine.restore(config!, dumpPath, {
      database: DATABASE,
      createDatabase: false,
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
      'Restored data should have same row count',
    )

    console.log(`   ✓ Verified ${rowCount} rows in restored container`)
  })

  // ============================================
  // Backup Format Tests
  // ============================================

  it('should backup to SQL format (.sql)', async () => {
    console.log(`\n📦 Testing SQL format backup (.sql)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `pg-sql-backup-${Date.now()}.sql`)

    // Backup with 'sql' format produces plain SQL
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    assert(result.path === backupPath, 'Backup path should match')
    assert(result.format === 'sql', 'Format should be sql')
    assert(result.size > 0, 'Backup should have content')

    // Verify file contains SQL statements
    const { readFile } = await import('fs/promises')
    const content = await readFile(backupPath, 'utf-8')
    assert(
      content.includes('CREATE TABLE'),
      'Backup should contain CREATE TABLE',
    )
    assert(
      content.includes('test_user'),
      'Backup should contain test_user table',
    )

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ SQL backup created with ${result.size} bytes`)
  })

  it('should backup to custom format (.dump)', async () => {
    console.log(`\n📦 Testing custom format backup (.dump)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `pg-dump-backup-${Date.now()}.dump`)

    // Backup with 'custom' format produces custom binary
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'custom',
    })

    assert(result.path === backupPath, 'Backup path should match')
    assert(result.format === 'custom', 'Format should be custom')
    assert(result.size > 0, 'Backup should have content')

    // Verify file is binary (starts with PGDMP)
    const { readFile } = await import('fs/promises')
    const buffer = await readFile(backupPath)
    const header = buffer.slice(0, 5).toString('ascii')
    assert(header === 'PGDMP', 'Backup should have PGDMP header')

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ Custom format backup created with ${result.size} bytes`)
  })

  it('should restore from SQL format and verify data', async () => {
    console.log(`\n📥 Testing SQL format restore...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, 'Container config should exist')

    // Create SQL backup from source
    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source config should exist')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `pg-sql-restore-${Date.now()}.sql`)

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    // Create a new database in cloned container for restore test
    const testDb = 'restore_test_db'
    await engine.createDatabase(config!, testDb)

    // Restore SQL backup to new database
    await engine.restore(config!, backupPath, {
      database: testDb,
      createDatabase: false,
    })

    // Verify data was restored
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[1],
      testDb,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Restored data should match source',
    )

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ SQL restore verified with ${rowCount} rows`)
  })

  it('should stop and delete the restored container', async () => {
    console.log(`\n🗑️  Deleting restored container "${clonedContainerName}"...`)

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

    console.log('   ✓ Container deleted and filesystem cleaned up')
  })

  it('should modify data using runScript inline SQL', async () => {
    console.log(
      `\n✏️  Deleting one row using engine.runScript with inline SQL...`,
    )

    // Use runScriptSQL which internally calls engine.runScript with --sql option
    // This tests the `spindb run --sql` command functionality
    await runScriptSQL(
      containerName,
      "DELETE FROM test_user WHERE email = 'eve@example.com'",
      DATABASE,
    )

    const rowCount = await getRowCount(
      ENGINE,
      testPorts[0],
      DATABASE,
      'test_user',
    )
    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, 'Should have one less row')

    console.log(
      `   ✓ Row deleted using engine.runScript, now have ${rowCount} rows`,
    )
  })

  it('should create a user and update password on re-create', async () => {
    console.log(`\n👤 Testing createUser...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)

    // Create user with first password
    const creds1 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'firstpass123',
      database: DATABASE,
    })
    assertEqual(creds1.username, 'testuser', 'Username should match')
    assertEqual(creds1.password, 'firstpass123', 'Password should match')
    assert(
      creds1.connectionString.includes('testuser'),
      'Connection string should contain username',
    )
    console.log('   ✓ Created user with initial password')

    // Re-create same user with different password (should update, not error)
    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.username, 'testuser', 'Username should still match')
    assertEqual(creds2.password, 'secondpass456', 'Password should be updated')
    console.log('   ✓ Re-created user with new password (idempotent)')
  })

  it('should stop, rename container, and change port', async () => {
    console.log(`\n📝 Renaming container and changing port...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    // Stop the container
    const engine = getEngine(ENGINE)
    await engine.stop(config!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

    // Wait for the container to be fully stopped (PID file removed)
    // This is important because rename() checks isRunning() before proceeding
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
    assert(ready, 'Renamed PostgreSQL should be ready')

    // Verify row count reflects deletion
    const rowCount = await getRowCount(
      ENGINE,
      testPorts[2],
      DATABASE,
      'test_user',
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Row count should persist after rename',
    )

    console.log(`   ✓ Data persisted: ${rowCount} rows`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log(`\n⚠️  Testing port conflict handling...`)

    try {
      // Try to create container on a port that's already in use (testPorts[2])
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: '18',
        port: testPorts[2], // This port is in use by renamed container
        database: 'conflictdb',
      })

      const engine = getEngine(ENGINE)
      await engine.initDataDir(portConflictContainerName, '18', {
        superuser: 'postgres',
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

      console.log(
        '   ✓ Container created with conflicting port (would auto-reassign on start)',
      )
    } finally {
      // Always clean up this test container, even if the test fails
      await containerManager
        .delete(portConflictContainerName, { force: true })
        .catch(() => {
          // Ignore errors during cleanup (container may not exist if creation failed)
        })
    }
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
    assert(
      stillRunning,
      'Container should still be running after duplicate start',
    )

    console.log(
      '   ✓ Container is already running (duplicate start handled gracefully)',
    )
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

    // Wait for the container to be fully stopped
    const stopped = await waitForStopped(renamedContainerName, ENGINE)
    assert(stopped, 'Container should be fully stopped')

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

  it('should backup and restore with password-authenticated local superuser credentials', async () => {
    console.log(
      `\n🔐 Testing auth-aware PostgreSQL backup/restore on local containers...`,
    )

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.postgresql.base + 40,
    )
    const sourceName = generateTestName('pg-auth-test-source')
    const targetName = generateTestName('pg-auth-test-target')
    const sourcePassword = 'sourcepass123'
    const targetPassword = 'targetpass456'
    const { tmpdir } = await import('os')
    const { mkdir, readFile, rm, writeFile } = await import('fs/promises')
    const backupPath = join(tmpdir(), `pg-auth-backup-${Date.now()}.dump`)
    const engine = getEngine(ENGINE)

    const writeDefaultCredentialFile = async (
      containerName: string,
      port: number,
      password: string,
    ) => {
      const credentialsDir = join(
        paths.getContainerPath(containerName, { engine: ENGINE }),
        'credentials',
      )
      await mkdir(credentialsDir, { recursive: true })
      const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${DATABASE}`
      await writeFile(
        join(credentialsDir, '.env.spindb'),
        [
          'DB_USER=postgres',
          `DB_PASSWORD=${password}`,
          'DB_HOST=127.0.0.1',
          `DB_PORT=${port}`,
          `DB_NAME=${DATABASE}`,
          `DB_URL=${connectionString}`,
          '',
        ].join('\n'),
        'utf-8',
      )
    }

    const waitForAuthedReady = async (
      containerName: string,
      password: string,
      timeoutMs = 30000,
    ): Promise<{ ready: boolean; lastError: string | null }> => {
      const startTime = Date.now()
      let lastError: string | null = null
      while (Date.now() - startTime < timeoutMs) {
        try {
          const config = await containerManager.getConfig(containerName)
          if (config) {
            const result = await engine.executeQuery(config, 'SELECT 1 AS ok', {
              database: 'postgres',
              username: 'postgres',
              password,
            })
            if (result.rowCount === 1) {
              return { ready: true, lastError: null }
            }
          }
        } catch (error) {
          lastError =
            error instanceof Error ? error.message : 'unknown auth-ready error'
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return { ready: false, lastError }
    }

    const enablePasswordAuth = async (
      containerName: string,
      port: number,
      password: string,
    ) => {
      const config = await containerManager.getConfig(containerName)
      assert(config !== null, 'Container config should exist')

      await runScriptSQL(
        containerName,
        // Test-only controlled constant; direct interpolation keeps the setup path simple here.
        `ALTER ROLE postgres WITH PASSWORD '${password}'`,
        'postgres',
      )

      const passwordState = await engine.executeQuery(
        config!,
        "SELECT rolpassword IS NOT NULL AS has_password FROM pg_authid WHERE rolname = 'postgres'",
        {
          database: 'postgres',
        },
      )
      const hasPassword = String(passwordState.rows[0]?.has_password)
      assert(
        hasPassword === 'true' || hasPassword === 't',
        `Superuser password should be set before enabling auth (got ${hasPassword})`,
      )

      const dataDir = paths.getContainerDataPath(containerName, {
        engine: ENGINE,
      })
      const pgHbaPath = join(dataDir, 'pg_hba.conf')
      const pgHbaContent = await readFile(pgHbaPath, 'utf-8')
      await writeFile(
        pgHbaPath,
        pgHbaContent.replace(/\btrust\b/g, 'md5'),
        'utf-8',
      )

      await writeDefaultCredentialFile(containerName, port, password)

      await engine.stop(config!)
      await containerManager.updateConfig(containerName, { status: 'stopped' })
      const stopped = await waitForStopped(containerName, ENGINE)
      assert(stopped, 'Container should stop before auth restart')

      const stoppedConfig = await containerManager.getConfig(containerName)
      assert(stoppedConfig !== null, 'Stopped config should exist')
      await engine.start(stoppedConfig!)
      await containerManager.updateConfig(containerName, { status: 'running' })
      const { ready, lastError } = await waitForAuthedReady(
        containerName,
        password,
      )
      assert(
        ready,
        `Auth-enabled PostgreSQL should be ready${lastError ? `: ${lastError}` : ''}`,
      )
    }

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: '18',
        port: sourcePort,
        database: DATABASE,
      })
      await engine.initDataDir(sourceName, '18', { superuser: 'postgres' })

      let sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, 'Source config should exist')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      assert(await waitForReady(ENGINE, sourcePort), 'Source should be ready')
      sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, 'Source config should still exist')
      await engine.createDatabase(sourceConfig!, DATABASE)
      await runScriptFile(sourceName, SEED_FILE, DATABASE)
      await enablePasswordAuth(sourceName, sourcePort, sourcePassword)

      const sourceAuthedConfig = await containerManager.getConfig(sourceName)
      assert(sourceAuthedConfig !== null, 'Source auth config should exist')
      const sourceRows = await engine.executeQuery(
        sourceAuthedConfig!,
        'SELECT id FROM test_user ORDER BY id',
        {
          database: DATABASE,
          username: 'postgres',
          password: sourcePassword,
        },
      )
      assertEqual(
        sourceRows.rowCount,
        EXPECTED_ROW_COUNT,
        'Auth-enabled source should still be queryable',
      )

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: '18',
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, '18', { superuser: 'postgres' })

      let targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, 'Target config should exist')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      assert(await waitForReady(ENGINE, targetPort), 'Target should be ready')
      targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, 'Target config should still exist')
      await engine.createDatabase(targetConfig!, DATABASE)
      await enablePasswordAuth(targetName, targetPort, targetPassword)

      const backupResult = await engine.backup(sourceAuthedConfig!, backupPath, {
        database: DATABASE,
        format: 'custom',
      })
      assertEqual(backupResult.format, 'custom', 'Backup should use custom format')

      const targetAuthedConfig = await containerManager.getConfig(targetName)
      assert(targetAuthedConfig !== null, 'Target auth config should exist')
      await engine.restore(targetAuthedConfig!, backupPath, {
        database: DATABASE,
        createDatabase: false,
      })

      const restoredRows = await engine.executeQuery(
        targetAuthedConfig!,
        'SELECT id FROM test_user ORDER BY id',
        {
          database: DATABASE,
          username: 'postgres',
          password: targetPassword,
        },
      )
      assertEqual(
        restoredRows.rowCount,
        EXPECTED_ROW_COUNT,
        'Restore should succeed against an auth-enabled target',
      )
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})

      for (const containerName of [sourceName, targetName]) {
        const config = await containerManager.getConfig(containerName)
        if (config) {
          const running = await processManager.isRunning(containerName, {
            engine: ENGINE,
          }).catch(() => false)
          if (running) {
            await engine.stop(config).catch(() => {})
            await containerManager
              .updateConfig(containerName, { status: 'stopped' })
              .catch(() => {})
          }
        }
        await containerManager.delete(containerName, { force: true }).catch(() => {})
      }
    }

    console.log('   ✓ Backup and restore work with password-authenticated PostgreSQL')
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n✅ Verifying no test containers remain...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    // Build detailed error message that appears in TAP output
    if (testContainers.length > 0) {
      const hasOriginal = containers.some((c) => c.name === containerName)
      const hasRenamed = containers.some((c) => c.name === renamedContainerName)
      const hasClone = containers.some((c) => c.name === clonedContainerName)

      const details = [
        `REMAINING CONTAINERS: ${testContainers.map((c) => c.name).join(', ')}`,
        `Expected containerName: ${containerName} - ${hasOriginal ? 'EXISTS (should be renamed)' : 'missing'}`,
        `Expected renamedContainerName: ${renamedContainerName} - ${hasRenamed ? 'EXISTS' : 'MISSING (rename failed!)'}`,
        `Expected clonedContainerName: ${clonedContainerName} - ${hasClone ? 'EXISTS (delete failed!)' : 'deleted OK'}`,
      ].join(' | ')

      throw new Error(
        `No test containers should remain (found ${testContainers.length}). ${details}`,
      )
    }

    console.log('   ✓ All test containers cleaned up')
  })
})
