/**
 * SQLite System Integration Tests
 *
 * Tests the full container lifecycle for SQLite.
 * Unlike PostgreSQL/MySQL, SQLite is file-based with no server process.
 */

import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, renameSync } from 'fs'
import { rm, mkdir } from 'fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
import {
  generateTestName,
  cleanupTestContainers,
  runScriptFile,
  runScriptSQL,
  sqliteFileExists,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { branchManager } from '../../core/branch-manager'
import { getEngine } from '../../engines'
import { sqliteRegistry } from '../../engines/sqlite/registry'
import { configManager } from '../../core/config-manager'
import { Engine } from '../../types'

// Helper to get sqlite3 path from the engine
async function getSqlite3Path(): Promise<string> {
  const engine = getEngine(Engine.SQLite)
  const path = await engine.getSqlite3Path()
  if (!path) {
    throw new Error('sqlite3 not found. Run: spindb engines download sqlite')
  }
  return path
}

// Verify we're using downloaded binaries, not system ones
async function verifyUsingDownloadedBinaries(): Promise<void> {
  const config = await configManager.getBinaryConfig('sqlite3')
  if (!config) {
    throw new Error(
      'sqlite3 not configured. Run: spindb engines download sqlite',
    )
  }
  if (config.source === 'system') {
    throw new Error(
      'Tests are using system sqlite3, not downloaded binaries. ' +
        'This makes tests unreliable for catching extraction bugs. ' +
        'Run: spindb engines download sqlite 3',
    )
  }
}

const ENGINE = Engine.SQLite
const SEED_FILE = join(__dirname, '../fixtures/sqlite/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5
const TEST_DIR = join(__dirname, '../.test-sqlite')

describe('SQLite Integration Tests', () => {
  let containerName: string
  let backupContainerName: string
  let renamedContainerName: string
  let dbPath: string
  let backupDbPath: string

  before(async () => {
    // Ensure SQLite binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring SQLite binaries are available...')
    await engine.ensureBinaries('3', ({ message }) => {
      console.log(`   ${message}`)
    })

    // Verify we're using downloaded binaries, not system ones
    // This ensures tests actually validate the binary extraction pipeline
    await verifyUsingDownloadedBinaries()

    console.log('\n🧹 Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    // Create test directory
    await mkdir(TEST_DIR, { recursive: true })

    containerName = generateTestName('sqlite-test')
    backupContainerName = generateTestName('sqlite-test-backup')
    renamedContainerName = generateTestName('sqlite-test-renamed')
    dbPath = join(TEST_DIR, `${containerName}.sqlite`)
    backupDbPath = join(TEST_DIR, `${backupContainerName}.sqlite`)
  })

  after(async () => {
    console.log('\n🧹 Final cleanup...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })

  it('should create SQLite database with --path option', async () => {
    console.log(`\n📦 Creating SQLite database "${containerName}"...`)

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: '3',
      port: 0, // SQLite doesn't use ports
      database: dbPath,
    })

    // Initialize the database (creates the file)
    const engine = getEngine(ENGINE)
    await engine.initDataDir(containerName, '3', { path: dbPath })

    // Verify container exists
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')
    assertEqual(config?.database, dbPath, 'Database path should match')

    // Verify file exists
    assert(sqliteFileExists(dbPath), 'SQLite database file should exist')

    console.log(`   ✓ Database created at ${dbPath}`)
  })

  it('should list SQLite container with "available" status', async () => {
    console.log(`\n📋 Listing SQLite containers...`)

    const containers = await containerManager.list()
    const sqliteContainers = containers.filter((c) => c.engine === ENGINE)

    assert(
      sqliteContainers.length > 0,
      'Should have at least one SQLite container',
    )

    const ourContainer = sqliteContainers.find((c) => c.name === containerName)
    assert(ourContainer !== undefined, 'Should find our test container')

    // SQLite uses 'running' status to indicate file exists
    assertEqual(
      ourContainer?.status,
      'running',
      'Status should be "running" (file exists)',
    )

    console.log(`   ✓ Found ${sqliteContainers.length} SQLite container(s)`)
  })

  it('should seed database with test data using runScript', async () => {
    console.log(`\n🌱 Seeding database with test data...`)

    // Use runScriptFile which internally calls engine.runScript
    await runScriptFile(containerName, SEED_FILE)

    // Query row count directly via sqlite3
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const sqlite3 = await getSqlite3Path()

    const { stdout } = await execFileAsync(sqlite3, [
      dbPath,
      'SELECT COUNT(*) FROM test_user',
    ])
    const rowCount = parseInt(stdout.trim(), 10)

    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Should have correct row count after seeding',
    )

    console.log(`   ✓ Seeded ${rowCount} rows`)
  })

  it('should run inline SQL using runScript', async () => {
    console.log(`\n✏️  Running inline SQL...`)

    // Delete one row
    await runScriptSQL(
      containerName,
      "DELETE FROM test_user WHERE email = 'eve@example.com'",
    )

    // Verify deletion
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const sqlite3 = await getSqlite3Path()

    const { stdout } = await execFileAsync(sqlite3, [
      dbPath,
      'SELECT COUNT(*) FROM test_user',
    ])
    const rowCount = parseInt(stdout.trim(), 10)

    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, 'Should have one less row')

    console.log(`   ✓ Row deleted, now have ${rowCount} rows`)
  })

  it('should branch to an explicit --path (placement + lineage + data)', async () => {
    console.log(`\n🌿 Branching to an explicit --path...`)

    const branchName = generateTestName('sqlite-test-branch')
    // A nested, not-yet-existing dir: proves dirname() is created and the branch
    // file lands exactly where the caller asks. layerbase-cloud relies on this
    // to put the file where pgsqlite/duckgres looks; the old behavior always
    // wrote to the container dir (which failed in the cloud's root-owned tree).
    const branchPath = join(TEST_DIR, 'branch-out', `${branchName}.sqlite`)

    await branchManager.createBranch({
      source: containerName,
      name: branchName,
      path: branchPath,
    })

    // 1) The branch file is written exactly at --path (not the container dir).
    assert(
      existsSync(branchPath),
      `Branch file should exist at the requested --path: ${branchPath}`,
    )

    // 2) Registry records the explicit path + the lineage.
    const entry = await sqliteRegistry.get(branchName)
    assert(entry !== null, 'Branch should be registered')
    assertEqual(
      entry?.filePath,
      branchPath,
      'Registry filePath should equal the --path',
    )
    assertEqual(
      entry?.branchParent,
      containerName,
      'Branch should record its parent for lineage',
    )

    // 3) The branch carries the source's rows as an independent copy.
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const sqlite3 = await getSqlite3Path()
    const { stdout } = await execFileAsync(sqlite3, [
      branchPath,
      'SELECT COUNT(*) FROM test_user',
    ])
    assertEqual(
      parseInt(stdout.trim(), 10),
      EXPECTED_ROW_COUNT - 1,
      'Branch should carry the source rows present at branch time',
    )

    // 4) Deleting the branch removes only the file we wrote (never the dir).
    await branchManager.deleteBranch(branchName)
    assert(
      !existsSync(branchPath),
      'Branch file should be removed when the branch is deleted',
    )
    assert(
      existsSync(dirname(branchPath)),
      'Explicit-path parent directory should be preserved after deleting the branch',
    )

    console.log(`   ✓ Branched to ${branchPath} — lineage + data + cleanup verified`)
  })

  it('should backup database (SQL format)', async () => {
    console.log(`\n💾 Creating SQL backup...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    const backupPath = join(TEST_DIR, 'backup.sql')

    const result = await engine.backup(config!, backupPath, {
      format: 'sql',
      database: config!.database,
    })

    assert(existsSync(result.path), 'Backup file should exist')
    assertEqual(result.format, 'sql', 'Backup format should be SQL')

    // Clean up
    await rm(backupPath, { force: true })

    console.log(`   ✓ SQL backup created (${result.size} bytes)`)
  })

  it('should backup database (binary format) and restore', async () => {
    console.log(`\n💾 Creating binary backup and restoring...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    const backupPath = join(TEST_DIR, 'backup.sqlite')

    // Create binary backup
    const result = await engine.backup(config!, backupPath, {
      format: 'binary',
      database: config!.database,
    })
    assert(existsSync(result.path), 'Backup file should exist')

    // Create new container and restore
    await containerManager.create(backupContainerName, {
      engine: ENGINE,
      version: '3',
      port: 0,
      database: backupDbPath,
    })
    await engine.initDataDir(backupContainerName, '3', { path: backupDbPath })

    const backupConfig = await containerManager.getConfig(backupContainerName)
    assert(backupConfig !== null, 'Backup container config should exist')

    await engine.restore(backupConfig!, backupPath)

    // Verify restored data
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const sqlite3 = await getSqlite3Path()

    const { stdout } = await execFileAsync(sqlite3, [
      backupDbPath,
      'SELECT COUNT(*) FROM test_user',
    ])
    const rowCount = parseInt(stdout.trim(), 10)

    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Restored data should match source',
    )

    // Clean up backup file
    await rm(backupPath, { force: true })

    console.log(`   ✓ Binary backup created and restored with ${rowCount} rows`)
  })

  it('should relocate database file and update registry', async () => {
    console.log(`\n📍 Relocating database file...`)

    // Create a subdirectory for relocation
    const relocateDir = join(TEST_DIR, 'relocated')
    await mkdir(relocateDir, { recursive: true })

    const newDbPath = join(relocateDir, `${containerName}.sqlite`)

    // Get current config
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')
    const originalPath = config!.database

    // Verify file exists at original location
    assert(existsSync(originalPath), 'File should exist at original location')

    // Move the file (simulating what the UI does)
    renameSync(originalPath, newDbPath)

    // Update container config and registry (what container-handlers.ts does)
    await containerManager.updateConfig(containerName, { database: newDbPath })
    await sqliteRegistry.update(containerName, { filePath: newDbPath })

    // Verify file exists at new location
    assert(existsSync(newDbPath), 'File should exist at new location')
    assert(
      !existsSync(originalPath),
      'File should not exist at original location',
    )

    // Verify container config is updated
    const updatedConfig = await containerManager.getConfig(containerName)
    assertEqual(
      updatedConfig?.database,
      newDbPath,
      'Container config should have new path',
    )

    // Verify registry is updated
    const registryEntry = await sqliteRegistry.get(containerName)
    assertEqual(
      registryEntry?.filePath,
      newDbPath,
      'Registry should have new path',
    )

    // Verify container still shows as available (not missing)
    const containers = await containerManager.list()
    const ourContainer = containers.find((c) => c.name === containerName)
    assertEqual(
      ourContainer?.status,
      'running',
      'Container should still be available after relocation',
    )

    // Verify data is intact
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const sqlite3 = await getSqlite3Path()

    const { stdout } = await execFileAsync(sqlite3, [
      newDbPath,
      'SELECT COUNT(*) FROM test_user',
    ])
    const rowCount = parseInt(stdout.trim(), 10)
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Data should be intact after relocation',
    )

    // Update dbPath for subsequent tests
    dbPath = newDbPath

    console.log(`   ✓ Relocated from ${originalPath} to ${newDbPath}`)
  })

  it('should rename container', async () => {
    console.log(`\n📝 Renaming container...`)

    // Rename container
    await containerManager.rename(containerName, renamedContainerName)

    // Verify rename
    const oldConfig = await containerManager.getConfig(containerName)
    assert(oldConfig === null, 'Old container name should not exist')

    const newConfig = await containerManager.getConfig(renamedContainerName)
    assert(newConfig !== null, 'Renamed container should exist')
    assertEqual(
      newConfig?.database,
      dbPath,
      'Database path should be unchanged',
    )

    console.log(`   ✓ Renamed to "${renamedContainerName}"`)
  })

  it('should delete container and remove file', async () => {
    console.log(`\n🗑️  Deleting containers...`)

    // Delete backup container first
    await containerManager.delete(backupContainerName, { force: true })
    assert(
      !sqliteFileExists(backupDbPath),
      'Backup database file should be deleted',
    )

    // Delete renamed container
    await containerManager.delete(renamedContainerName, { force: true })
    assert(
      !sqliteFileExists(dbPath),
      'Original database file should be deleted',
    )

    // Verify containers are removed from list
    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))
    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   ✓ Containers and files deleted')
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n✅ Verifying no test containers remain...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   ✓ All test containers cleaned up')
  })
})
