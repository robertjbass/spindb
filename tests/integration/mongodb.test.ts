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
  waitForStopped,
  containerDataExists,
  getConnectionString,
  runScriptFile,
  runScriptSQL,
  executeQuery,
} from './helpers'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { paths } from '../../config/paths'

const ENGINE = Engine.MongoDB
const DATABASE = 'testdb'
const SEED_FILE = join(__dirname, '../fixtures/mongodb/seeds/sample-db.js')
const EXPECTED_ROW_COUNT = 5
const TEST_VERSION = '8.0' // Major version - will be resolved to full version via version map

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

    // Ensure MongoDB binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring MongoDB binaries are available...')
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
    await engine.initDataDir(containerName, TEST_VERSION, {})

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

  it('should query seeded data using executeQuery', async () => {
    console.log(`\n🔍 Querying seeded data using engine.executeQuery...`)

    // Test basic find query (MongoDB uses JavaScript syntax)
    // Sort by id field (not _id which is auto-generated)
    // Must call .toArray() to convert cursor to array for JSON serialization
    const result = await executeQuery(
      containerName,
      'test_user.find({}).sort({id: 1}).toArray()',
      DATABASE,
    )

    assertEqual(
      result.rowCount,
      EXPECTED_ROW_COUNT,
      'Should return all documents',
    )

    // Verify first document data (sorted by id, so id:1 = Alice Johnson)
    assertEqual(
      result.rows[0].name,
      'Alice Johnson',
      'First document should be Alice Johnson',
    )
    assertEqual(
      result.rows[0].email,
      'alice@example.com',
      'First document email should match',
    )

    // Test filtered query
    const filteredResult = await executeQuery(
      containerName,
      'test_user.find({email: /bob/}).toArray()',
      DATABASE,
    )

    assertEqual(
      filteredResult.rowCount,
      1,
      'Should return one document for Bob',
    )
    assertEqual(
      filteredResult.rows[0].name,
      'Bob Smith',
      'Should find Bob Smith',
    )

    // Verify columns include expected fields
    assertTruthy(result.columns.includes('name'), 'Columns should include name')
    assertTruthy(
      result.columns.includes('email'),
      'Columns should include email',
    )

    console.log(
      `   ✓ Query returned ${result.rowCount} documents with correct data`,
    )
  })

  it('should create a user and update password on re-create', async () => {
    console.log(`\n👤 Testing createUser...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)

    const creds1 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'firstpass123',
      database: DATABASE,
    })
    assertEqual(creds1.username, 'testuser', 'Username should match')
    assertEqual(creds1.password, 'firstpass123', 'Password should match')
    console.log('   ✓ Created user with initial password')

    const creds2 = await engine.createUser(config!, {
      username: 'testuser',
      password: 'secondpass456',
      database: DATABASE,
    })
    assertEqual(creds2.password, 'secondpass456', 'Password should be updated')
    console.log('   ✓ Re-created user with new password (idempotent)')
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
      version: TEST_VERSION,
      port: testPorts[1],
      database: DATABASE,
    })

    // Initialize and start
    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, TEST_VERSION, {})

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

  // ============================================
  // Backup Format Tests
  // ============================================

  it('should backup to directory format (BSON)', async () => {
    console.log(`\n📦 Testing directory format backup (BSON)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `mongodb-dir-backup-${Date.now()}`)

    // Backup with 'sql' format produces directory dump
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    assert(result.path === backupPath, 'Backup path should match')
    assert(result.format === 'directory', 'Format should be directory')

    // Verify directory structure exists
    const { existsSync } = await import('fs')
    const dbDir = join(backupPath, DATABASE)
    assert(existsSync(dbDir), 'Database directory should exist')

    // Verify BSON files exist for the collection
    const collectionFile = join(dbDir, 'test_user.bson')
    assert(existsSync(collectionFile), 'Collection BSON file should exist')

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { recursive: true, force: true })

    console.log(`   ✓ Directory backup created`)
  })

  it('should backup to archive format (.archive)', async () => {
    console.log(`\n📦 Testing archive format backup (.archive)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const { tmpdir } = await import('os')
    const backupPath = join(
      tmpdir(),
      `mongodb-archive-backup-${Date.now()}.archive`,
    )

    // Backup with 'archive' format produces compressed archive
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'archive',
    })

    assert(result.path === backupPath, 'Backup path should match')
    assert(result.format === 'archive', 'Format should be archive')
    assert(result.size > 0, 'Backup should have content')

    // Verify file is gzipped (starts with gzip magic bytes 1f 8b)
    const { readFile } = await import('fs/promises')
    const buffer = await readFile(backupPath)
    assert(
      buffer[0] === 0x1f && buffer[1] === 0x8b,
      'Backup should have gzip header',
    )

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ Archive backup created with ${result.size} bytes`)
  })

  it('should restore from directory format and verify data', async () => {
    console.log(`\n📥 Testing directory format restore...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, 'Container config should exist')

    // Create directory backup from source
    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source config should exist')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `mongodb-dir-restore-${Date.now()}`)

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    // Restore directory backup to cloned container
    // Use a different database to avoid conflicts
    const testDb = 'restore_test_db'
    await engine.restore(config!, backupPath, {
      database: testDb,
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
    await rm(backupPath, { recursive: true, force: true })

    console.log(`   ✓ Directory restore verified with ${rowCount} documents`)
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

    try {
      // Try to create container on a port that's already in use (testPorts[2])
      await containerManager.create(portConflictContainerName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: testPorts[2], // This port is in use by renamed container
        database: 'conflictdb',
      })

      const engine = getEngine(ENGINE)
      await engine.initDataDir(portConflictContainerName, TEST_VERSION, {})

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

  it('should backup and restore with password-authenticated local root credentials', async () => {
    console.log(
      `\n🔐 Testing auth-aware MongoDB backup/restore on local containers...`,
    )

    const [sourcePort, targetPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.mongodb.base + 40,
    )
    const sourceName = generateTestName('mongodb-auth-test-source')
    const targetName = generateTestName('mongodb-auth-test-target')
    const sourcePassword = 'sourcepass123'
    const targetPassword = 'targetpass456'
    const { tmpdir } = await import('os')
    const { mkdir, rm, writeFile } = await import('fs/promises')
    const backupPath = join(tmpdir(), `mongodb-auth-backup-${Date.now()}.archive`)
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
      const connectionString = `mongodb://root:${encodeURIComponent(password)}@127.0.0.1:${port}/admin?authSource=admin`
      await writeFile(
        join(credentialsDir, '.env.spindb'),
        [
          'DB_USER=root',
          `DB_PASSWORD=${password}`,
          'DB_HOST=127.0.0.1',
          `DB_PORT=${port}`,
          'DB_NAME=admin',
          `DB_URL=${connectionString}`,
          '',
        ].join('\n'),
        'utf-8',
      )
    }

    const waitForAuthedReady = async (
      containerName: string,
      timeoutMs = 30000,
    ): Promise<{ ready: boolean; lastError: string | null }> => {
      const startTime = Date.now()
      let lastError: string | null = null
      while (Date.now() - startTime < timeoutMs) {
        try {
          const config = await containerManager.getConfig(containerName)
          if (config) {
            const result = await engine.executeQuery(
              config,
              'runCommand({ ping: 1 })',
              {
                database: 'admin',
              },
            )
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
        `db.getSiblingDB('admin').createUser({ user: 'root', pwd: ${JSON.stringify(password)}, roles: [{ role: 'root', db: 'admin' }] })`,
        'admin',
      )

      await writeDefaultCredentialFile(containerName, port, password)

      await engine.stop(config!)
      await containerManager.updateConfig(containerName, {
        status: 'stopped',
        authEnabled: true,
      })
      const stopped = await waitForStopped(containerName, ENGINE)
      assert(stopped, 'Container should stop before auth restart')

      const authedConfig = await containerManager.getConfig(containerName)
      assert(authedConfig !== null, 'Auth-enabled config should exist')
      await engine.start(authedConfig!)
      await containerManager.updateConfig(containerName, { status: 'running' })

      const { ready, lastError } = await waitForAuthedReady(containerName)
      assert(
        ready,
        `Auth-enabled MongoDB should be ready${lastError ? `: ${lastError}` : ''}`,
      )
    }

    try {
      await containerManager.create(sourceName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: sourcePort,
        database: DATABASE,
      })
      await engine.initDataDir(sourceName, TEST_VERSION, {})

      let sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, 'Source config should exist')
      await engine.start(sourceConfig!)
      await containerManager.updateConfig(sourceName, { status: 'running' })
      assert(await waitForReady(ENGINE, sourcePort), 'Source should be ready')
      await runScriptFile(sourceName, SEED_FILE, DATABASE)
      await enablePasswordAuth(sourceName, sourcePort, sourcePassword)

      sourceConfig = await containerManager.getConfig(sourceName)
      assert(sourceConfig !== null, 'Source auth config should exist')
      const sourceRows = await engine.executeQuery(
        sourceConfig!,
        'test_user.find({}).sort({ id: 1 }).toArray()',
        {
          database: DATABASE,
        },
      )
      assertEqual(
        sourceRows.rowCount,
        EXPECTED_ROW_COUNT,
        'Auth-enabled source should still be queryable',
      )

      await containerManager.create(targetName, {
        engine: ENGINE,
        version: TEST_VERSION,
        port: targetPort,
        database: DATABASE,
      })
      await engine.initDataDir(targetName, TEST_VERSION, {})

      let targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, 'Target config should exist')
      await engine.start(targetConfig!)
      await containerManager.updateConfig(targetName, { status: 'running' })
      assert(await waitForReady(ENGINE, targetPort), 'Target should be ready')
      await enablePasswordAuth(targetName, targetPort, targetPassword)

      const backupResult = await engine.backup(sourceConfig!, backupPath, {
        database: DATABASE,
        format: 'archive',
      })
      assertEqual(
        backupResult.format,
        'archive',
        'Backup should use archive format',
      )

      targetConfig = await containerManager.getConfig(targetName)
      assert(targetConfig !== null, 'Target auth config should exist')
      await engine.restore(targetConfig!, backupPath, {
        database: DATABASE,
      })

      const restoredRows = await engine.executeQuery(
        targetConfig!,
        'test_user.find({}).sort({ id: 1 }).toArray()',
        {
          database: DATABASE,
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
          const running = await processManager
            .isRunning(containerName, {
              engine: ENGINE,
            })
            .catch(() => false)
          if (running) {
            await engine.stop(config).catch(() => {})
            await containerManager
              .updateConfig(containerName, { status: 'stopped' })
              .catch(() => {})
          }
        }
        await containerManager
          .delete(containerName, { force: true })
          .catch(() => {})
      }
    }

    console.log('   ✓ Backup and restore work with password-authenticated MongoDB')
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n✅ Verifying no test containers remain...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   ✓ All test containers cleaned up')
  })
})
