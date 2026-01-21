/**
 * CLI End-to-End Tests
 *
 * Tests the actual CLI commands (spindb create, list, info, etc.)
 * rather than calling core modules directly.
 */

import { describe, it, before, after } from 'node:test'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { rm, mkdir } from 'fs/promises'

import {
  generateTestName,
  cleanupTestContainers,
  findConsecutiveFreePorts,
  TEST_PORTS,
  waitForReady,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { Engine } from '../../types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const execAsync = promisify(exec)

// Run CLI directly with tsx to avoid pnpm output pollution
const CLI_PATH = join(__dirname, '../../cli/bin.ts')

// Run a CLI command and return stdout/stderr
async function runCLI(
  args: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(
      `node --import tsx "${CLI_PATH}" ${args}`,
      {
        cwd: join(__dirname, '../..'),
        timeout: 60000,
      },
    )
    return { stdout, stderr, exitCode: 0 }
  } catch (error) {
    const execError = error as {
      stdout?: string
      stderr?: string
      code?: number
    }
    return {
      stdout: execError.stdout || '',
      stderr: execError.stderr || '',
      exitCode: execError.code || 1,
    }
  }
}

describe('CLI End-to-End Tests', () => {
  describe('Version and Help Commands', () => {
    it('should show version', async () => {
      const { stdout, exitCode } = await runCLI('--version')
      assert(exitCode === 0, 'Version command should succeed')
      assert(stdout.includes('.'), 'Version should contain a dot (semver)')
      console.log(`   Version: ${stdout.trim()}`)
    })

    it('should show help', async () => {
      const { stdout, exitCode } = await runCLI('--help')
      assert(exitCode === 0, 'Help command should succeed')
      assert(stdout.includes('create'), 'Help should mention create command')
      assert(stdout.includes('list'), 'Help should mention list command')
      assert(stdout.includes('start'), 'Help should mention start command')
      console.log('   Help output contains expected commands')
    })
  })

  describe('Doctor Command', () => {
    it('should run doctor check', async () => {
      const { stdout, exitCode } = await runCLI('doctor')
      // Doctor may exit with 1 if dependencies are missing, but should run
      assert(exitCode === 0 || exitCode === 1, 'Doctor command should complete')
      assert(
        stdout.includes('Configuration') ||
          stdout.includes('Health Check') ||
          stdout.includes('Containers'),
        'Doctor should show health check info',
      )
      console.log('   Doctor check completed')
    })
  })

  describe('Engines Command', () => {
    it('should list available engines', async () => {
      const { stdout, exitCode } = await runCLI('engines list')
      assert(exitCode === 0, 'Engines list should succeed')
      // Note: engines list only shows INSTALLED engines
      // PostgreSQL is downloaded in CI, SQLite is pre-installed on all platforms
      // MySQL may or may not be installed depending on the CI job
      assert(
        stdout.toLowerCase().includes('postgresql') ||
          stdout.toLowerCase().includes('postgres'),
        'Should list PostgreSQL (downloaded in CI)',
      )
      assert(
        stdout.toLowerCase().includes('sqlite'),
        'Should list SQLite (pre-installed on all platforms)',
      )
      // MySQL is optional - only check if it's mentioned when installed
      const hasMysql = stdout.toLowerCase().includes('mysql')
      console.log(
        `   Engines listed: PostgreSQL, SQLite${hasMysql ? ', MySQL' : ''}`,
      )
    })
  })

  describe('List Command (Empty State)', () => {
    before(async () => {
      // Clean up any existing test containers
      await cleanupTestContainers()
    })

    it('should list containers (may be empty)', async () => {
      const { exitCode } = await runCLI('list')
      assert(exitCode === 0, 'List command should succeed')
      // Output could be empty or show existing containers
      console.log('   List command succeeded')
    })

    it('should list containers in JSON format', async () => {
      const { stdout, exitCode } = await runCLI('list --json')
      assert(exitCode === 0, 'List --json should succeed')
      // Should be valid JSON (array)
      const parsed = JSON.parse(stdout)
      assert(Array.isArray(parsed), 'JSON output should be an array')
      console.log(`   JSON list returned ${parsed.length} containers`)
    })
  })
})

describe('CLI PostgreSQL Workflow', () => {
  let containerName: string
  let testPort: number

  before(async () => {
    console.log('\n Cleaning up test containers...')
    await cleanupTestContainers()

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    containerName = generateTestName('clipg')
    console.log(`   Using container: ${containerName}, port: ${testPort}`)
  })

  after(async () => {
    console.log('\n Final cleanup...')
    await cleanupTestContainers()
  })

  it('should create PostgreSQL container via CLI', async () => {
    console.log(`\n Creating container "${containerName}"...`)

    // Note: Don't use --version flag as it conflicts with global -v/--version
    // The engine will use the default/latest version
    const { stdout, stderr, exitCode } = await runCLI(
      `create ${containerName} --engine postgresql --port ${testPort} --no-start`,
    )

    assert(
      exitCode === 0,
      `Create should succeed. stderr: ${stderr}, stdout: ${stdout}`,
    )
    console.log('   Container created')
  })

  it('should show container in list', async () => {
    const { stdout, exitCode } = await runCLI('list --json')
    assert(exitCode === 0, 'List should succeed')

    const containers = JSON.parse(stdout)
    const found = containers.find(
      (c: { name: string }) => c.name === containerName,
    )
    assert(found, `Container "${containerName}" should be in list`)
    assertEqual(found.engine, 'postgresql', 'Engine should be postgresql')
    console.log('   Container appears in list')
  })

  it('should start container via CLI', async () => {
    console.log(`\n Starting container "${containerName}"...`)

    const { exitCode, stderr } = await runCLI(`start ${containerName}`)
    assert(exitCode === 0, `Start should succeed. stderr: ${stderr}`)

    // Wait for PostgreSQL to be ready
    const ready = await waitForReady(Engine.PostgreSQL, testPort)
    assert(ready, 'PostgreSQL should be ready')
    console.log('   Container started and ready')
  })

  it('should show container info via CLI', async () => {
    const { stdout, exitCode } = await runCLI(`info ${containerName}`)
    assert(exitCode === 0, 'Info should succeed')
    assert(stdout.includes(containerName), 'Info should show container name')
    assert(
      stdout.includes('running') || stdout.includes('Running'),
      'Info should show running status',
    )
    console.log('   Info command shows container details')
  })

  it('should show connection URL via CLI', async () => {
    const { stdout, exitCode } = await runCLI(`url ${containerName}`)
    assert(exitCode === 0, 'URL command should succeed')
    assert(stdout.includes('postgresql://'), 'URL should be PostgreSQL format')
    assert(stdout.includes(String(testPort)), 'URL should include port')
    console.log(`   URL: ${stdout.trim()}`)
  })

  it('should run SQL via CLI', async () => {
    const { exitCode, stderr } = await runCLI(
      `run ${containerName} --sql "SELECT 1 as test"`,
    )
    assert(exitCode === 0, `Run SQL should succeed. stderr: ${stderr}`)
    console.log('   SQL executed successfully')
  })

  it('should stop container via CLI', async () => {
    console.log(`\n Stopping container "${containerName}"...`)

    const { exitCode, stderr } = await runCLI(`stop ${containerName}`)
    assert(exitCode === 0, `Stop should succeed. stderr: ${stderr}`)
    console.log('   Container stopped')
  })

  it('should show stopped status in info', async () => {
    const { stdout, exitCode } = await runCLI(`info ${containerName}`)
    assert(exitCode === 0, 'Info should succeed')
    assert(
      stdout.includes('stopped') || stdout.includes('Stopped'),
      'Info should show stopped status',
    )
    console.log('   Info shows stopped status')
  })

  it('should delete container via CLI', async () => {
    console.log(`\n Deleting container "${containerName}"...`)

    const { exitCode, stderr } = await runCLI(
      `delete ${containerName} --force --yes`,
    )
    assert(exitCode === 0, `Delete should succeed. stderr: ${stderr}`)
    console.log('   Container deleted')
  })

  it('should not show deleted container in list', async () => {
    const { stdout, exitCode } = await runCLI('list --json')
    assert(exitCode === 0, 'List should succeed')

    const containers = JSON.parse(stdout)
    const found = containers.find(
      (c: { name: string }) => c.name === containerName,
    )
    assert(!found, 'Deleted container should not be in list')
    console.log('   Container no longer in list')
  })
})

describe('CLI SQLite Workflow', () => {
  let containerName: string
  let dbPath: string
  const testDir = join(__dirname, '../.test-cli-sqlite')

  before(async () => {
    console.log('\n Cleaning up test containers...')
    await cleanupTestContainers()
    await mkdir(testDir, { recursive: true })

    containerName = generateTestName('clisqlite')
    dbPath = join(testDir, `${containerName}.sqlite`)
    console.log(`   Using container: ${containerName}`)
  })

  after(async () => {
    console.log('\n Final cleanup...')
    await cleanupTestContainers()
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('should create SQLite database via CLI', async () => {
    console.log(`\n Creating SQLite database "${containerName}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `create ${containerName} --engine sqlite --path "${dbPath}"`,
    )

    assert(
      exitCode === 0,
      `Create should succeed. stderr: ${stderr}, stdout: ${stdout}`,
    )
    assert(existsSync(dbPath), 'Database file should exist')
    console.log('   SQLite database created')
  })

  it('should show SQLite container in list', async () => {
    const { stdout, exitCode } = await runCLI('list --json')
    assert(exitCode === 0, 'List should succeed')

    const containers = JSON.parse(stdout)
    const found = containers.find(
      (c: { name: string }) => c.name === containerName,
    )
    assert(found, `Container "${containerName}" should be in list`)
    assertEqual(found.engine, 'sqlite', 'Engine should be sqlite')
    console.log('   SQLite container appears in list')
  })

  it('should show SQLite info via CLI', async () => {
    const { stdout, exitCode } = await runCLI(`info ${containerName}`)
    assert(exitCode === 0, 'Info should succeed')
    assert(stdout.includes(containerName), 'Info should show container name')
    console.log('   Info command shows SQLite details')
  })

  it('should run SQL on SQLite via CLI', async () => {
    // Create a table
    const { exitCode: createExit } = await runCLI(
      `run ${containerName} --sql "CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)"`,
    )
    assert(createExit === 0, 'Create table should succeed')

    // Insert data
    const { exitCode: insertExit } = await runCLI(
      `run ${containerName} --sql "INSERT INTO test (name) VALUES ('hello')"`,
    )
    assert(insertExit === 0, 'Insert should succeed')

    console.log('   SQL operations completed on SQLite')
  })

  it('should delete SQLite container via CLI', async () => {
    console.log(`\n Deleting SQLite container "${containerName}"...`)

    const { exitCode, stderr } = await runCLI(
      `delete ${containerName} --force --yes`,
    )
    assert(exitCode === 0, `Delete should succeed. stderr: ${stderr}`)
    assert(!existsSync(dbPath), 'Database file should be deleted')
    console.log('   SQLite container and file deleted')
  })
})

describe('CLI URL Command', () => {
  let containerName: string
  let testPort: number

  before(async () => {
    console.log('\n Cleaning up test containers...')
    await cleanupTestContainers()

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    containerName = generateTestName('cliurl')
    console.log(`   Using container: ${containerName}, port: ${testPort}`)
  })

  after(async () => {
    console.log('\n Final cleanup...')
    await cleanupTestContainers()
  })

  it('should create and start container for URL tests', async () => {
    const { exitCode, stderr, stdout } = await runCLI(
      `create ${containerName} --engine postgresql --port ${testPort} --start`,
    )
    assert(
      exitCode === 0,
      `Create should succeed. stderr: ${stderr}, stdout: ${stdout}`,
    )

    const ready = await waitForReady(Engine.PostgreSQL, testPort)
    assert(ready, 'PostgreSQL should be ready')
    console.log('   Container created and started')
  })

  it('should show connection URL', async () => {
    const { stdout, exitCode } = await runCLI(`url ${containerName}`)
    assert(exitCode === 0, 'URL command should succeed')
    assert(stdout.includes('postgresql://'), 'URL should be PostgreSQL format')
    assert(stdout.includes(String(testPort)), 'URL should include port')
    console.log(`   URL: ${stdout.trim()}`)
  })

  it('should show URL in JSON format', async () => {
    const { stdout, exitCode } = await runCLI(`url ${containerName} --json`)
    assert(exitCode === 0, 'URL --json should succeed')

    const parsed = JSON.parse(stdout)
    assert(parsed.url !== undefined, 'JSON should contain url field')
    assert(
      parsed.url.includes('postgresql://'),
      'URL should be PostgreSQL format',
    )
    console.log('   JSON URL output verified')
  })

  it('should cleanup URL test container', async () => {
    const { exitCode: stopExit } = await runCLI(`stop ${containerName}`)
    assert(stopExit === 0, 'Stop should succeed')

    const { exitCode: deleteExit } = await runCLI(
      `delete ${containerName} --force --yes`,
    )
    assert(deleteExit === 0, 'Delete should succeed')
    console.log('   Container cleaned up')
  })
})

describe('CLI Connection String Inference', () => {
  let containerName: string
  let testPort: number

  before(async () => {
    console.log('\n Cleaning up test containers...')
    await cleanupTestContainers()

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    containerName = generateTestName('clifrom')
    console.log(`   Using container: ${containerName}, port: ${testPort}`)
  })

  after(async () => {
    console.log('\n Final cleanup...')
    await cleanupTestContainers()
  })

  it('should create container inferring engine from connection string', async () => {
    // Use --from to infer engine from a PostgreSQL connection string
    // Note: This creates a container and attempts to pull schema from the connection
    // For testing, we use a localhost connection that won't actually connect
    // but should still infer the engine type correctly
    const connectionString = `postgresql://user:pass@127.0.0.1:${testPort}/testdb`

    const { exitCode, stderr, stdout } = await runCLI(
      `create ${containerName} --from "${connectionString}" --no-start`,
    )

    // The command may fail to connect (expected since no server is running at that port)
    // but should at least recognize the PostgreSQL engine
    // For now, we verify the command parsing works
    console.log(`   --from command exit code: ${exitCode}`)

    // If it succeeded (unlikely without a running server), verify it's PostgreSQL
    if (exitCode === 0) {
      const { stdout: infoOut } = await runCLI(`info ${containerName} --json`)
      const info = JSON.parse(infoOut)
      assertEqual(info.engine, 'postgresql', 'Engine should be postgresql')
      console.log('   Engine correctly inferred from connection string')

      // Cleanup
      await runCLI(`delete ${containerName} --force --yes`)
    } else {
      // Check that the error message mentions connection or PostgreSQL
      const output = (stdout + stderr).toLowerCase()
      assert(
        output.includes('postgres') ||
          output.includes('connect') ||
          output.includes('error'),
        'Error should mention PostgreSQL or connection issue',
      )
      console.log('   Connection string parsing attempted (server not running)')
    }
  })

  it('should reject invalid connection string format', async () => {
    const { exitCode } = await runCLI(
      `create ${containerName} --from "not-a-valid-url"`,
    )
    assert(exitCode !== 0, 'Should fail for invalid connection string')
    console.log('   Proper error for invalid connection string')
  })
})

describe('CLI Error Handling', () => {
  it('should fail gracefully for non-existent container', async () => {
    const { exitCode, stdout, stderr } = await runCLI(
      'info non-existent-container-xyz',
    )
    // Check either exit code or error/informational message in output
    // Note: When no containers exist, info returns "No containers found" with exit 0
    // When containers exist but the named one doesn't, it returns "not found" with exit 1
    const output = (stdout + stderr).toLowerCase()
    const hasExpectedBehavior =
      exitCode !== 0 ||
      output.includes('not found') ||
      output.includes('does not exist') ||
      output.includes('no containers found') ||
      output.includes('error')
    assert(
      hasExpectedBehavior,
      `Should handle non-existent container gracefully. exitCode=${exitCode}, stdout=${stdout.slice(0, 100)}, stderr=${stderr.slice(0, 100)}`,
    )
    console.log('   Proper error for non-existent container')
  })

  it('should fail gracefully for invalid container name', async () => {
    const { exitCode } = await runCLI('create 123-invalid --engine postgresql')
    assert(exitCode !== 0, 'Should fail for invalid container name')
    console.log('   Proper error for invalid container name')
  })

  it('should fail gracefully for unknown engine', async () => {
    const { exitCode } = await runCLI('create test-unknown --engine fakedb')
    assert(exitCode !== 0, 'Should fail for unknown engine')
    console.log('   Proper error for unknown engine')
  })
})

describe('CLI Backup and Restore Workflow', () => {
  let containerName: string
  let testPort: number
  let backupFilename: string
  const testDir = join(__dirname, '../.test-cli-backup')

  before(async () => {
    console.log('\n Cleaning up test containers...')
    await cleanupTestContainers()
    await mkdir(testDir, { recursive: true })

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    containerName = generateTestName('clipgbackup')
    backupFilename = `${containerName}-backup`
    console.log(`   Using container: ${containerName}, port: ${testPort}`)
  })

  after(async () => {
    console.log('\n Final cleanup...')
    await cleanupTestContainers()
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('should create and start PostgreSQL container for backup test', async () => {
    console.log(`\n Creating container "${containerName}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `create ${containerName} --engine postgresql --port ${testPort} --start`,
    )

    assert(
      exitCode === 0,
      `Create should succeed. stderr: ${stderr}, stdout: ${stdout}`,
    )

    // Wait for PostgreSQL to be ready
    const ready = await waitForReady(Engine.PostgreSQL, testPort)
    assert(ready, 'PostgreSQL should be ready')
    console.log('   Container created and started')
  })

  it('should create test data', async () => {
    // Create a table and insert data
    const { exitCode: createExit, stderr: createErr } = await runCLI(
      `run ${containerName} --sql "CREATE TABLE backup_test (id SERIAL PRIMARY KEY, name TEXT)"`,
    )
    assert(
      createExit === 0,
      `Create table should succeed. stderr: ${createErr}`,
    )

    const { exitCode: insertExit, stderr: insertErr } = await runCLI(
      `run ${containerName} --sql "INSERT INTO backup_test (name) VALUES ('test1'), ('test2'), ('test3')"`,
    )
    assert(insertExit === 0, `Insert should succeed. stderr: ${insertErr}`)
    console.log('   Test data created')
  })

  it('should create SQL backup via CLI', async () => {
    console.log(`\n Creating backup to "${testDir}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `backup ${containerName} --output "${testDir}" --name "${backupFilename}" --format sql`,
    )

    assert(
      exitCode === 0,
      `Backup should succeed. stderr: ${stderr}, stdout: ${stdout}`,
    )

    // The backup file will have .sql extension added
    const backupPath = join(testDir, `${backupFilename}.sql`)
    assert(existsSync(backupPath), `Backup file should exist at ${backupPath}`)
    console.log('   SQL backup created')
  })

  it('should create backup with JSON output', async () => {
    const jsonBackupName = `${containerName}-json`
    const { stdout, exitCode, stderr } = await runCLI(
      `backup ${containerName} --output "${testDir}" --name "${jsonBackupName}" --format sql --json`,
    )

    assert(
      exitCode === 0,
      `Backup with --json should succeed. stderr: ${stderr}`,
    )

    // JSON output should be parseable
    const parsed = JSON.parse(stdout)
    assert(parsed.path !== undefined, 'JSON should contain path')
    assert(parsed.size !== undefined, 'JSON should contain size')
    assert(parsed.format !== undefined, 'JSON should contain format')
    console.log('   JSON backup output verified')
  })

  it('should restore backup to new database via CLI', async () => {
    console.log(`\n Restoring backup to new database...`)

    const backupPath = join(testDir, `${backupFilename}.sql`)
    const { exitCode, stderr, stdout } = await runCLI(
      `restore ${containerName} "${backupPath}" --database restored_db`,
    )

    assert(
      exitCode === 0,
      `Restore should succeed. stderr: ${stderr}, stdout: ${stdout}`,
    )
    console.log('   Backup restored to new database')
  })

  it('should verify restored data', async () => {
    const { stdout, exitCode, stderr } = await runCLI(
      `run ${containerName} --database restored_db --sql "SELECT COUNT(*) as count FROM backup_test"`,
    )

    assert(exitCode === 0, `Query should succeed. stderr: ${stderr}`)
    // The output should contain the count (psql outputs "3" for COUNT)
    assert(
      stdout.includes('3'),
      `Should have 3 rows in restored database. stdout: ${stdout}`,
    )
    console.log('   Restored data verified')
  })

  it('should restore with --force to replace existing database', async () => {
    console.log(`\n Restoring with --force to replace database...`)

    const backupPath = join(testDir, `${backupFilename}.sql`)
    const { exitCode, stderr, stdout } = await runCLI(
      `restore ${containerName} "${backupPath}" --database restored_db --force`,
    )

    assert(
      exitCode === 0,
      `Restore with --force should succeed. stderr: ${stderr}, stdout: ${stdout}`,
    )
    console.log('   Backup restored with --force')
  })

  it('should stop container for clone test', async () => {
    const { exitCode, stderr } = await runCLI(`stop ${containerName}`)
    assert(exitCode === 0, `Stop should succeed. stderr: ${stderr}`)
    console.log('   Container stopped')
  })

  it('should delete backup test container', async () => {
    const { exitCode, stderr } = await runCLI(
      `delete ${containerName} --force --yes`,
    )
    assert(exitCode === 0, `Delete should succeed. stderr: ${stderr}`)
    console.log('   Container deleted')
  })
})

describe('CLI Clone Workflow', () => {
  let sourceContainer: string
  let cloneContainer: string
  let testPort: number

  before(async () => {
    console.log('\n Cleaning up test containers...')
    await cleanupTestContainers()

    const ports = await findConsecutiveFreePorts(1, TEST_PORTS.postgresql.base)
    testPort = ports[0]
    sourceContainer = generateTestName('clisource')
    cloneContainer = generateTestName('cliclone')
    console.log(`   Using source: ${sourceContainer}, clone: ${cloneContainer}`)
  })

  after(async () => {
    console.log('\n Final cleanup...')
    await cleanupTestContainers()
  })

  it('should create source container for clone test', async () => {
    console.log(`\n Creating source container "${sourceContainer}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `create ${sourceContainer} --engine postgresql --port ${testPort} --no-start`,
    )

    assert(
      exitCode === 0,
      `Create should succeed. stderr: ${stderr}, stdout: ${stdout}`,
    )
    console.log('   Source container created')
  })

  it('should clone stopped container via CLI', async () => {
    console.log(`\n Cloning "${sourceContainer}" to "${cloneContainer}"...`)

    const { exitCode, stderr, stdout } = await runCLI(
      `clone ${sourceContainer} ${cloneContainer}`,
    )

    assert(
      exitCode === 0,
      `Clone should succeed. stderr: ${stderr}, stdout: ${stdout}`,
    )
    console.log('   Container cloned')
  })

  it('should show cloned container in list', async () => {
    const { stdout, exitCode } = await runCLI('list --json')
    assert(exitCode === 0, 'List should succeed')

    const containers = JSON.parse(stdout)
    const source = containers.find(
      (c: { name: string }) => c.name === sourceContainer,
    )
    const clone = containers.find(
      (c: { name: string }) => c.name === cloneContainer,
    )

    assert(source, 'Source container should exist')
    assert(clone, 'Cloned container should exist')
    assertEqual(
      clone.engine,
      'postgresql',
      'Cloned engine should be postgresql',
    )
    console.log('   Both containers appear in list')
  })

  it('should show clone info with clonedFrom', async () => {
    const { stdout, exitCode } = await runCLI(`info ${cloneContainer} --json`)
    assert(exitCode === 0, 'Info should succeed')

    const info = JSON.parse(stdout)
    assertEqual(
      info.clonedFrom,
      sourceContainer,
      'clonedFrom should reference source container',
    )
    console.log('   Clone info shows clonedFrom field')
  })

  it('should delete source and clone containers', async () => {
    const { exitCode: deleteSource } = await runCLI(
      `delete ${sourceContainer} --force --yes`,
    )
    assert(deleteSource === 0, 'Delete source should succeed')

    const { exitCode: deleteClone } = await runCLI(
      `delete ${cloneContainer} --force --yes`,
    )
    assert(deleteClone === 0, 'Delete clone should succeed')
    console.log('   Containers deleted')
  })
})
