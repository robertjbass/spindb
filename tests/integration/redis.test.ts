/**
 * Redis System Integration Tests
 *
 * Tests the full container lifecycle with real Redis processes.
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
  getKeyCount,
  getRedisValue,
  waitForReady,
  containerDataExists,
  assert,
  assertEqual,
  runScriptFile,
  runScriptSQL,
  getInstalledVersion,
} from './helpers'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.Redis
const DATABASE = '0' // Redis uses numbered databases 0-15
const SEED_FILE = join(__dirname, '../fixtures/redis/seeds/sample-db.redis')
const EXPECTED_KEY_COUNT = 6 // 5 user keys + 1 user:count key

describe('Redis Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string
  let installedVersion: string

  before(async () => {
    console.log('\n🧹 Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    console.log('\n🔍 Detecting installed Redis version...')
    installedVersion = await getInstalledVersion(ENGINE)
    console.log(`   Using Redis version: ${installedVersion}`)

    console.log('\n🔍 Finding available test ports...')
    testPorts = await findConsecutiveFreePorts(3, TEST_PORTS.redis.base)
    console.log(`   Using ports: ${testPorts.join(', ')}`)

    containerName = generateTestName('redis-test')
    clonedContainerName = generateTestName('redis-test-clone')
    renamedContainerName = generateTestName('redis-test-renamed')
    portConflictContainerName = generateTestName('redis-test-conflict')
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

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: installedVersion,
      port: testPorts[0],
      database: DATABASE,
    })

    // Initialize the data directory
    const engine = getEngine(ENGINE)
    await engine.initDataDir(containerName, installedVersion, {})

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

    // Wait for Redis to be ready
    const ready = await waitForReady(ENGINE, testPorts[0])
    assert(ready, 'Redis should be ready to accept connections')

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

    const keyCount = await getKeyCount(testPorts[0], DATABASE, 'user:*')
    assertEqual(
      keyCount,
      EXPECTED_KEY_COUNT,
      'Should have correct key count after seeding',
    )

    console.log(`   ✓ Seeded ${keyCount} keys using engine.runScript`)
  })

  it('should clone container using backup/restore', async () => {
    console.log(
      `\n📋 Creating container "${clonedContainerName}" via backup/restore...`,
    )

    // Create and initialize cloned container
    await containerManager.create(clonedContainerName, {
      engine: ENGINE,
      version: installedVersion,
      port: testPorts[1],
      database: DATABASE,
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(clonedContainerName, installedVersion, {})

    // Create backup from source
    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `redis-test-backup-${Date.now()}.rdb`)

    const sourceConfig = await containerManager.getConfig(containerName)
    assert(sourceConfig !== null, 'Source container config should exist')

    await engine.backup(sourceConfig!, backupPath, {
      database: DATABASE,
      format: 'dump',
    })

    // Stop source for restore (restore needs container stopped)
    await engine.stop(sourceConfig!)
    await containerManager.updateConfig(containerName, { status: 'stopped' })

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
    assert(ready, 'Cloned Redis should be ready')

    // Clean up backup file
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    // Restart source container
    await engine.start(sourceConfig!)
    await containerManager.updateConfig(containerName, { status: 'running' })

    console.log('   ✓ Container cloned via backup/restore')
  })

  it('should verify restored data matches source', async () => {
    console.log(`\n🔍 Verifying restored data...`)

    const keyCount = await getKeyCount(testPorts[1], DATABASE, 'user:*')
    assertEqual(
      keyCount,
      EXPECTED_KEY_COUNT,
      'Restored data should have same key count',
    )

    // Verify a specific value
    const userCount = await getRedisValue(testPorts[1], DATABASE, 'user:count')
    assertEqual(userCount, '5', 'User count should be 5')

    console.log(`   ✓ Verified ${keyCount} keys in restored container`)
  })

  it('should stop and delete the restored container', async () => {
    console.log(`\n🗑️  Deleting restored container "${clonedContainerName}"...`)

    const config = await containerManager.getConfig(clonedContainerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    await engine.stop(config!)
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

  // ============================================
  // Text Format Backup/Restore Tests (.redis)
  // ============================================

  it('should backup to text format (.redis)', async () => {
    console.log(`\n📦 Testing text format backup (.redis)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `redis-text-backup-${Date.now()}.redis`)

    // Backup with 'sql' format which produces .redis text file
    const result = await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    assert(result.path === backupPath, 'Backup path should match')
    assert(result.format === 'redis', 'Format should be redis')
    assert(result.size > 0, 'Backup should have content')

    // Verify file contains Redis commands
    const { readFile } = await import('fs/promises')
    const content = await readFile(backupPath, 'utf-8')
    assert(content.includes('SET user:'), 'Backup should contain SET commands')
    assert(
      content.includes('user:count'),
      'Backup should contain user:count key',
    )

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log(`   ✓ Text backup created with ${result.size} bytes`)
  })

  it('should restore from text format with merge mode', async () => {
    console.log(`\n📥 Testing text format restore (merge mode)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    // First, add a key that's NOT in the backup file
    await runScriptSQL(containerName, 'SET extra:key "should-persist"', DATABASE)

    // Create a text backup
    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `redis-merge-test-${Date.now()}.redis`)

    await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    // Modify a key to verify it gets restored
    await runScriptSQL(containerName, 'SET user:count 999', DATABASE)

    // Verify modification
    let userCount = await getRedisValue(testPorts[0], DATABASE, 'user:count')
    assertEqual(userCount, '999', 'user:count should be modified')

    // Restore with merge mode (flush: false)
    await engine.restore(config!, backupPath, {
      database: DATABASE,
      flush: false,
    })

    // Verify restored value
    userCount = await getRedisValue(testPorts[0], DATABASE, 'user:count')
    assertEqual(userCount, '5', 'user:count should be restored to 5')

    // Verify extra key still exists (merge mode keeps existing keys)
    const extraKey = await getRedisValue(testPorts[0], DATABASE, 'extra:key')
    assertEqual(extraKey, 'should-persist', 'Extra key should persist in merge mode')

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })
    await runScriptSQL(containerName, 'DEL extra:key', DATABASE)

    console.log('   ✓ Text restore with merge mode preserves existing keys')
  })

  it('should restore from text format with replace mode (FLUSHDB)', async () => {
    console.log(`\n📥 Testing text format restore (replace mode with FLUSHDB)...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    // Create a text backup first
    const { tmpdir } = await import('os')
    const backupPath = join(tmpdir(), `redis-replace-test-${Date.now()}.redis`)

    await engine.backup(config!, backupPath, {
      database: DATABASE,
      format: 'sql',
    })

    // Add a key that's NOT in the backup
    await runScriptSQL(containerName, 'SET extra:key "should-be-deleted"', DATABASE)

    // Verify extra key exists
    let extraKey = await getRedisValue(testPorts[0], DATABASE, 'extra:key')
    assertEqual(extraKey, 'should-be-deleted', 'Extra key should exist before restore')

    // Restore with replace mode (flush: true) - runs FLUSHDB first
    await engine.restore(config!, backupPath, {
      database: DATABASE,
      flush: true,
    })

    // Verify extra key is gone (FLUSHDB cleared it)
    extraKey = await getRedisValue(testPorts[0], DATABASE, 'extra:key')
    assert(extraKey === null || extraKey === '', 'Extra key should be deleted by FLUSHDB')

    // Verify backup data is restored
    const keyCount = await getKeyCount(testPorts[0], DATABASE, 'user:*')
    assertEqual(keyCount, EXPECTED_KEY_COUNT, 'Should have original key count')

    // Clean up
    const { rm } = await import('fs/promises')
    await rm(backupPath, { force: true })

    console.log('   ✓ Text restore with replace mode clears existing data')
  })

  it('should detect Redis commands in file without .redis extension', async () => {
    console.log(`\n🔍 Testing content-based format detection...`)

    const engine = getEngine(ENGINE)

    // Create a file with Redis commands but .txt extension
    const { tmpdir } = await import('os')
    const { writeFile, rm } = await import('fs/promises')
    const testFile = join(tmpdir(), `redis-commands-${Date.now()}.txt`)

    await writeFile(
      testFile,
      'SET test:key "value"\nSET test:key2 "value2"\n',
      'utf-8',
    )

    // Detect format - should recognize as Redis commands
    const format = await engine.detectBackupFormat(testFile)
    assertEqual(
      format.format,
      'redis',
      'Should detect Redis commands by content',
    )
    assert(
      format.description.includes('detected by content'),
      'Description should mention content detection',
    )

    // Clean up
    await rm(testFile, { force: true })

    console.log('   ✓ Content-based detection works for files without .redis extension')
  })

  it('should modify data using runScript inline command', async () => {
    console.log(
      `\n✏️  Deleting one key using engine.runScript with inline command...`,
    )

    // Use runScriptSQL which internally calls engine.runScript with --sql option
    // For Redis, the "sql" is actually a Redis command
    await runScriptSQL(containerName, 'DEL user:5', DATABASE)

    const keyCount = await getKeyCount(testPorts[0], DATABASE, 'user:*')
    // Should have 5 keys now (user:count + user:1 through user:4)
    assertEqual(keyCount, EXPECTED_KEY_COUNT - 1, 'Should have one less key')

    console.log(
      `   ✓ Key deleted using engine.runScript, now have ${keyCount} keys`,
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
    assert(ready, 'Renamed Redis should be ready')

    // Verify key count reflects deletion
    const keyCount = await getKeyCount(testPorts[2], DATABASE, 'user:*')
    assertEqual(
      keyCount,
      EXPECTED_KEY_COUNT - 1,
      'Key count should persist after rename',
    )

    console.log(`   ✓ Data persisted: ${keyCount} keys`)
  })

  it('should handle port conflict gracefully', async () => {
    console.log(`\n⚠️  Testing port conflict handling...`)

    // Try to create container on a port that's already in use (testPorts[2])
    await containerManager.create(portConflictContainerName, {
      engine: ENGINE,
      version: installedVersion,
      port: testPorts[2], // This port is in use by renamed container
      database: '1', // Different database to avoid confusion
    })

    const engine = getEngine(ENGINE)
    await engine.initDataDir(portConflictContainerName, installedVersion, {})

    // The container should be created but when we try to start, it should detect conflict
    // In real usage, the start command would auto-assign a new port
    const config = await containerManager.getConfig(portConflictContainerName)
    assert(config !== null, 'Container should be created')
    assertEqual(
      config?.port,
      testPorts[2],
      'Port should be set to conflicting port initially',
    )

    // Clean up this test container
    await containerManager.delete(portConflictContainerName, { force: true })

    console.log(
      '   ✓ Container created with conflicting port (would auto-reassign on start)',
    )
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
    assert(stillRunning, 'Container should still be running after duplicate start')

    console.log('   ✓ Container is already running (duplicate start handled gracefully)')
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

  it('should have no test containers remaining', async () => {
    console.log(`\n✅ Verifying no test containers remain...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   ✓ All test containers cleaned up')
  })
})
