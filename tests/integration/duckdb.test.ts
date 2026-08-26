/**
 * DuckDB Integration Tests
 *
 * Tests the full container lifecycle for DuckDB.
 * Like SQLite, DuckDB is file-based with no server process.
 */

import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, renameSync, statSync } from 'fs'
import { rm, mkdir } from 'fs/promises'
import { spawn } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { generateTestName, cleanupTestContainers } from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { branchManager } from '../../core/branch-manager'
import { getEngine } from '../../engines'
import { duckdbRegistry } from '../../engines/duckdb/registry'
import { configManager } from '../../core/config-manager'
import { Engine } from '../../types'

// Helper to get duckdb path from the engine
async function getDuckDBPath(): Promise<string> {
  const engine = getEngine(Engine.DuckDB)
  const path = await engine.getDuckDBPath()
  if (!path) {
    throw new Error('duckdb not found. Run: spindb engines download duckdb')
  }
  return path
}

// Verify we're using downloaded binaries, not system ones
async function verifyUsingDownloadedBinaries(): Promise<void> {
  const config = await configManager.getBinaryConfig('duckdb')
  if (!config) {
    throw new Error(
      'duckdb not configured. Run: spindb engines download duckdb',
    )
  }
  if (config.source === 'system') {
    throw new Error(
      'Tests are using system duckdb, not downloaded binaries. ' +
        'This makes tests unreliable for catching extraction bugs. ' +
        'Run: spindb engines download duckdb 1',
    )
  }
}

// Helper to check if DuckDB file exists
function duckdbFileExists(filePath: string): boolean {
  return existsSync(filePath)
}

// Helper to execute a SQL query against a DuckDB database file
async function queryDuckDB(dbPath: string, sql: string): Promise<string> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)
  const duckdb = await getDuckDBPath()

  const { stdout } = await execFileAsync(duckdb, [
    dbPath,
    '-noheader',
    '-list',
    '-c',
    sql,
  ])
  return stdout.trim()
}

const ENGINE = Engine.DuckDB
const SEED_FILE = join(__dirname, '../fixtures/duckdb/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5
const TEST_DIR_BASE = join(__dirname, '../.test-duckdb')

describe('DuckDB Integration Tests', () => {
  let testDir: string
  let containerName: string
  let backupContainerName: string
  let renamedContainerName: string
  let dbPath: string
  let backupDbPath: string

  before(async () => {
    // Ensure DuckDB binaries are downloaded first
    const engine = getEngine(ENGINE)
    console.log('   Ensuring DuckDB binaries are available...')
    await engine.ensureBinaries('1', ({ message }) => {
      console.log(`   ${message}`)
    })

    // Verify we're using downloaded binaries, not system ones
    // This ensures tests actually validate the binary extraction pipeline
    await verifyUsingDownloadedBinaries()

    console.log('\n Cleaning up any existing test containers...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    // Create unique test directory per run to avoid conflicts
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testDir = `${TEST_DIR_BASE}-${runId}`
    await mkdir(testDir, { recursive: true })

    containerName = generateTestName('duckdb-test')
    backupContainerName = generateTestName('duckdb-test-backup')
    renamedContainerName = generateTestName('duckdb-test-renamed')
    dbPath = join(testDir, `${containerName}.duckdb`)
    backupDbPath = join(testDir, `${backupContainerName}.duckdb`)
  })

  after(async () => {
    console.log('\n Final cleanup...')
    const deleted = await cleanupTestContainers()
    if (deleted.length > 0) {
      console.log(`   Deleted: ${deleted.join(', ')}`)
    }

    // Clean up test directory
    if (testDir && existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('should create DuckDB database with --path option', async () => {
    console.log(`\n Creating DuckDB database "${containerName}"...`)

    await containerManager.create(containerName, {
      engine: ENGINE,
      version: '1',
      port: 0, // DuckDB doesn't use ports
      database: dbPath,
    })

    // Initialize the database (creates the file)
    const engine = getEngine(ENGINE)
    await engine.initDataDir(containerName, '1', { path: dbPath })

    // Verify container exists
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')
    assertEqual(config?.database, dbPath, 'Database path should match')

    // Verify file exists
    assert(duckdbFileExists(dbPath), 'DuckDB database file should exist')

    console.log(`   Database created at ${dbPath}`)
  })

  it('should list DuckDB container with "available" status', async () => {
    console.log(`\n Listing DuckDB containers...`)

    const containers = await containerManager.list()
    const duckdbContainers = containers.filter((c) => c.engine === ENGINE)

    assert(
      duckdbContainers.length > 0,
      'Should have at least one DuckDB container',
    )

    const ourContainer = duckdbContainers.find((c) => c.name === containerName)
    assert(ourContainer !== undefined, 'Should find our test container')

    // DuckDB uses 'running' status to indicate file exists
    assertEqual(
      ourContainer?.status,
      'running',
      'Status should be "running" (file exists)',
    )

    console.log(`   Found ${duckdbContainers.length} DuckDB container(s)`)
  })

  it('should seed database with test data using runScript', async () => {
    console.log(`\n Seeding database with test data...`)

    // Use engine.runScript to seed the database
    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    await engine.runScript(config!, { file: SEED_FILE })

    // Query row count directly via duckdb
    const rowCount = parseInt(
      await queryDuckDB(dbPath, 'SELECT COUNT(*) FROM test_user'),
      10,
    )

    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT,
      'Should have correct row count after seeding',
    )

    console.log(`   Seeded ${rowCount} rows`)
  })

  it('should run inline SQL using runScript', async () => {
    console.log(`\n Running inline SQL...`)

    const engine = getEngine(ENGINE)
    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    // Delete one row
    await engine.runScript(config!, {
      sql: "DELETE FROM test_user WHERE email = 'eve@example.com'",
    })

    // Verify deletion
    const rowCount = parseInt(
      await queryDuckDB(dbPath, 'SELECT COUNT(*) FROM test_user'),
      10,
    )

    assertEqual(rowCount, EXPECTED_ROW_COUNT - 1, 'Should have one less row')

    console.log(`   Row deleted, now have ${rowCount} rows`)
  })

  it('should backup database (binary format) and restore', async () => {
    console.log(`\n Creating binary backup and restoring...`)

    const config = await containerManager.getConfig(containerName)
    assert(config !== null, 'Container config should exist')

    const engine = getEngine(ENGINE)
    const backupPath = join(testDir, 'backup.duckdb')

    // Create binary backup
    const result = await engine.backup(config!, backupPath, {
      format: 'binary',
      database: config!.database,
    })
    assert(existsSync(result.path), 'Backup file should exist')

    // Create new container and restore
    await containerManager.create(backupContainerName, {
      engine: ENGINE,
      version: '1',
      port: 0,
      database: backupDbPath,
    })
    await engine.initDataDir(backupContainerName, '1', { path: backupDbPath })

    const backupConfig = await containerManager.getConfig(backupContainerName)
    assert(backupConfig !== null, 'Backup container config should exist')

    await engine.restore(backupConfig!, backupPath)

    // Verify restored data
    const rowCount = parseInt(
      await queryDuckDB(backupDbPath, 'SELECT COUNT(*) FROM test_user'),
      10,
    )

    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Restored data should match source',
    )

    // Clean up backup file
    await rm(backupPath, { force: true })

    console.log(`   Binary backup created and restored with ${rowCount} rows`)
  })

  it('should relocate database file and update registry', async () => {
    console.log(`\n Relocating database file...`)

    // Create a subdirectory for relocation
    const relocateDir = join(testDir, 'relocated')
    await mkdir(relocateDir, { recursive: true })

    const newDbPath = join(relocateDir, `${containerName}.duckdb`)

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
    await duckdbRegistry.update(containerName, { filePath: newDbPath })

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
    const registryEntry = await duckdbRegistry.get(containerName)
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
    const rowCount = parseInt(
      await queryDuckDB(newDbPath, 'SELECT COUNT(*) FROM test_user'),
      10,
    )
    assertEqual(
      rowCount,
      EXPECTED_ROW_COUNT - 1,
      'Data should be intact after relocation',
    )

    // Update dbPath for subsequent tests
    dbPath = newDbPath

    console.log(`   Relocated from ${originalPath} to ${newDbPath}`)
  })

  it('should rename container', async () => {
    console.log(`\n Renaming container...`)

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

    console.log(`   Renamed to "${renamedContainerName}"`)
  })

  it('should delete container and remove file', async () => {
    console.log(`\n Deleting containers...`)

    // Delete backup container first
    await containerManager.delete(backupContainerName, { force: true })
    assert(
      !duckdbFileExists(backupDbPath),
      'Backup database file should be deleted',
    )

    // Delete renamed container
    await containerManager.delete(renamedContainerName, { force: true })
    assert(
      !duckdbFileExists(dbPath),
      'Original database file should be deleted',
    )

    // Verify containers are removed from list
    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))
    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   Containers and files deleted')
  })

  it('should have no test containers remaining', async () => {
    console.log(`\n Verifying no test containers remain...`)

    const containers = await containerManager.list()
    const testContainers = containers.filter((c) => c.name.includes('-test'))

    assertEqual(testContainers.length, 0, 'No test containers should remain')

    console.log('   All test containers cleaned up')
  })
})

/**
 * C-142 regression: branching a DuckDB database whose recent writes are still
 * in the WAL.
 *
 * DuckDB parks committed-but-not-checkpointed writes in `<file>.wal`, so a
 * clone of the main file alone opens cleanly and answers
 * "Catalog Error: Table with name ... does not exist" - a working, empty
 * branch with no error anywhere. Reproduced on prod 2026-08-26 with a
 * 50,000-row table.
 *
 * Two shapes, and they take different code paths:
 *  - nobody holds the file: the branch CHECKPOINTs the source first, so the
 *    clone is complete on its own.
 *  - a writer holds it (a proxy serving the database, which is the cloud's
 *    normal state): DuckDB refuses the cross-process open with a lock error, so
 *    the WAL is copied alongside the file and the caller gets a warning.
 */
describe('DuckDB branch with a pending WAL (C-142)', () => {
  const walDir = join(TEST_DIR_BASE, 'wal-branch')
  let writer: ReturnType<typeof spawn> | null = null
  const created: string[] = []

  before(async () => {
    await mkdir(walDir, { recursive: true })
  })

  after(async () => {
    if (writer && !writer.killed) {
      writer.kill('SIGKILL')
      writer = null
    }
    for (const name of created) {
      await containerManager.delete(name, { force: true }).catch(() => {})
    }
    await cleanupTestContainers()
    await rm(walDir, { recursive: true, force: true }).catch(() => {})
  })

  it('checkpoints a quiesced source so the clone is complete', async () => {
    const sourceName = generateTestName('duckdb-wal-src')
    const branchName = generateTestName('duckdb-wal-branch')
    created.push(sourceName, branchName)
    const sourcePath = join(walDir, `${sourceName}.duckdb`)
    const branchPath = join(walDir, `${branchName}.duckdb`)

    await getEngine(ENGINE).initDataDir(sourceName, '1', { path: sourcePath })
    const duckdb = await getDuckDBPath()
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    await execFileAsync(duckdb, [
      sourcePath,
      '-c',
      'CREATE TABLE probe AS SELECT i AS id FROM range(1,100) t(i);',
    ])

    const result = await branchManager.createBranch({
      source: sourceName,
      name: branchName,
      path: branchPath,
    })
    assertEqual(result.warning, undefined, 'a quiesced source needs no warning')
    assertEqual(
      await queryDuckDB(branchPath, 'SELECT count(*) FROM probe;'),
      '99',
      'branch of a quiesced source must carry every row',
    )
  })

  it('carries rows that are still only in the write-ahead log', async () => {
    const sourceName = generateTestName('duckdb-wal-live-src')
    const branchName = generateTestName('duckdb-wal-live-branch')
    created.push(sourceName, branchName)
    const sourcePath = join(walDir, `${sourceName}.duckdb`)
    const branchPath = join(walDir, `${branchName}.duckdb`)

    await getEngine(ENGINE).initDataDir(sourceName, '1', { path: sourcePath })
    const duckdb = await getDuckDBPath()

    // A writer that stays connected, so the WAL is never folded into the file
    // and DuckDB's exclusive lock blocks any out-of-process CHECKPOINT.
    writer = spawn(duckdb, [sourcePath])
    writer.stdin!.write(
      'CREATE TABLE probe AS SELECT i AS id FROM range(1,100) t(i);\n',
    )
    writer.stdin!.write('SELECT count(*) FROM probe;\n')

    const walPath = `${sourcePath}.wal`
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (existsSync(walPath) && statSync(walPath).size > 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(
      existsSync(walPath) && statSync(walPath).size > 0,
      'the source must have a pending WAL for this regression to mean anything',
    )

    if (process.platform === 'win32') {
      // Windows locks an open DuckDB file exclusively, so the copy that carries
      // the WAL across cannot run at all (EBUSY) - POSIX allows copying an open
      // file, which is why the assertions below it are the real ones there. The
      // contract on Windows is a LOUD, actionable failure with nothing left
      // behind: an empty or half-made branch is the one outcome C-142 exists to
      // prevent, and it must not come back through the platform door.
      let failure: Error | null = null
      try {
        await branchManager.createBranch({
          source: sourceName,
          name: branchName,
          path: branchPath,
        })
      } catch (error) {
        failure = error as Error
      }
      assert(
        failure !== null,
        'branching a DuckDB database a writer still holds must fail on Windows, not produce an empty branch',
      )
      assert(
        /another process has/i.test(failure!.message) &&
          /Close every connection/i.test(failure!.message),
        `the failure must tell the user what to do, got: ${failure!.message}`,
      )
      assert(
        !existsSync(branchPath),
        'a failed branch must leave no partial database file behind',
      )
      assert(
        !existsSync(`${branchPath}.wal`),
        'a failed branch must leave no partial WAL behind',
      )
      assertEqual(
        await duckdbRegistry.get(branchName),
        null,
        'a failed branch must not be registered',
      )

      // ...and once the writer lets go, the very same branch succeeds and
      // carries the rows, so the failure above is a lock, not a dead end.
      writer.kill('SIGKILL')
      writer = null
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await branchManager.createBranch({
        source: sourceName,
        name: branchName,
        path: branchPath,
      })
      assertEqual(
        await queryDuckDB(branchPath, 'SELECT count(*) FROM probe;'),
        '99',
        'once unlocked, the branch must carry the rows that were only in the WAL',
      )
      return
    }

    const result = await branchManager.createBranch({
      source: sourceName,
      name: branchName,
      path: branchPath,
    })
    assert(
      typeof result.warning === 'string' && result.warning.length > 0,
      'a source that could not be checkpointed must say so',
    )
    assertEqual(
      await queryDuckDB(branchPath, 'SELECT count(*) FROM probe;'),
      '99',
      'branch must contain the rows the parent had at branch time, WAL included',
    )

    writer.kill('SIGKILL')
    writer = null
  })
})
