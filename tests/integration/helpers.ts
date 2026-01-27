// Test helpers for system integration tests

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync } from 'fs'
import { rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import { containerManager } from '../../core/container-manager'
import { portManager } from '../../core/port-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { paths } from '../../config/paths'
import { isWindows } from '../../core/platform-service'
import { Engine } from '../../types'
import { compareVersions } from '../../core/version-utils'

const execAsync = promisify(exec)

/**
 * Build and execute a mongosh command for MongoDB-compatible engines (MongoDB, FerretDB)
 * Handles platform-specific shell escaping
 */
async function runMongoshCommand(
  engine: Engine,
  port: number,
  database: string,
  script: string,
): Promise<{ stdout: string; stderr: string }> {
  const engineImpl = getEngine(engine)
  const mongoshPath = await engineImpl.getMongoshPath().catch(() => 'mongosh')

  let cmd: string
  if (isWindows()) {
    const escaped = script.replace(/"/g, '\\"')
    cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database} --eval "${escaped}" --quiet`
  } else {
    const escaped = script.replace(/'/g, "'\\''")
    cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database} --eval '${escaped}' --quiet`
  }
  return execAsync(cmd)
}

/**
 * Execute a JavaScript file via mongosh for MongoDB-compatible engines (MongoDB, FerretDB)
 */
async function runMongoshFile(
  engine: Engine,
  port: number,
  database: string,
  filePath: string,
): Promise<{ stdout: string; stderr: string }> {
  const engineImpl = getEngine(engine)
  const mongoshPath = await engineImpl.getMongoshPath().catch(() => 'mongosh')
  const cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} ${database} --file "${filePath}"`
  return execAsync(cmd)
}

// Default test port configuration
export const TEST_PORTS = {
  postgresql: { base: 5454, clone: 5456, renamed: 5455 },
  mysql: { base: 3333, clone: 3335, renamed: 3334 },
  mariadb: { base: 3340, clone: 3342, renamed: 3341 },
  mongodb: { base: 27050, clone: 27052, renamed: 27051 },
  ferretdb: { base: 27060, clone: 27062, renamed: 27061 },
  redis: { base: 6399, clone: 6401, renamed: 6400 },
  valkey: { base: 6410, clone: 6412, renamed: 6411 },
  clickhouse: { base: 9050, clone: 9052, renamed: 9051 },
  qdrant: { base: 6350, clone: 6352, renamed: 6351 },
  meilisearch: { base: 7710, clone: 7712, renamed: 7711 },
  couchdb: { base: 5990, clone: 5992, renamed: 5991 },
  cockroachdb: { base: 26260, clone: 26262, renamed: 26261 },
  surrealdb: { base: 8010, clone: 8012, renamed: 8011 },
  questdb: { base: 8820, clone: 8822, renamed: 8821 },
}

// Default test versions for each engine
// Used by helper functions that need to call engine methods with a version
export const TEST_VERSIONS = {
  cockroachdb: '25',
  surrealdb: '2',
  questdb: '9',
}

/**
 * Generate a unique test container name
 * Container names must start with a letter.
 * Use underscores instead of hyphens for PostgreSQL compatibility
 * (PostgreSQL database names can't contain hyphens)
 */
export function generateTestName(prefix = 'test'): string {
  const uuid = randomUUID().slice(0, 8).replace(/-/g, '')
  return `${prefix}_${uuid}`
}

// Find N consecutive free ports starting from a base port
export async function findConsecutiveFreePorts(
  count: number,
  startPort: number,
): Promise<number[]> {
  const ports: number[] = []
  let currentPort = startPort

  while (ports.length < count) {
    const available = await portManager.isPortAvailable(currentPort)
    if (available) {
      // Check if we can get consecutive ports from here
      let consecutiveAvailable = true
      for (let i = 1; i < count - ports.length; i++) {
        if (!(await portManager.isPortAvailable(currentPort + i))) {
          consecutiveAvailable = false
          break
        }
      }

      if (consecutiveAvailable || ports.length === count - 1) {
        ports.push(currentPort)
        currentPort++
      } else {
        // Skip to next port and try again
        currentPort++
        ports.length = 0 // Reset and start over
      }
    } else {
      currentPort++
      ports.length = 0 // Reset if we hit a busy port
    }

    // Safety valve to prevent infinite loop
    if (currentPort > startPort + 100) {
      throw new Error(
        `Could not find ${count} consecutive free ports starting from ${startPort}`,
      )
    }
  }

  return ports
}

/**
 * Clean up all test containers
 * Matches containers with test prefixes (cli*, test*) followed by underscore and UUID
 */
export async function cleanupTestContainers(): Promise<string[]> {
  const containers = await containerManager.list()
  // Match test naming pattern: containers containing "-test" followed by _uuid
  // Examples: pg-test_12345678, mysql-test-clone_abcd1234, redis-test-renamed_12345678
  // Also matches legacy patterns: clipg_12345678, test_abcd1234
  const testPattern = /(-test|^cli|^test)[a-z-]*_[a-f0-9]+$/i
  let testContainers = containers.filter((c) => testPattern.test(c.name))

  // On Windows, skip CockroachDB and SurrealDB containers during cleanup
  // These engines use memory-mapped files (RocksDB/SurrealKV) that Windows holds
  // handles to for extended periods (100+ seconds), causing cleanup to hang
  if (isWindows()) {
    testContainers = testContainers.filter(
      (c) => c.engine !== Engine.CockroachDB && c.engine !== Engine.SurrealDB,
    )
  }

  const deleted: string[] = []
  for (const container of testContainers) {
    try {
      // Stop if running
      const running = await processManager.isRunning(container.name, {
        engine: container.engine,
      })
      if (running) {
        const engine = getEngine(container.engine)
        const config = await containerManager.getConfig(container.name)
        if (config) {
          await engine.stop(config)
          // Wait for the container to fully stop on Windows
          // Windows is slower to release ports and file handles
          if (isWindows()) {
            await new Promise((resolve) => setTimeout(resolve, 5000))
          }
        }
      }

      // Delete container with retry on Windows
      // Windows may hold file handles longer after process termination
      let deleteAttempts = isWindows() ? 3 : 1
      while (deleteAttempts > 0) {
        try {
          await containerManager.delete(container.name, { force: true })
          deleted.push(container.name)
          break
        } catch {
          deleteAttempts--
          if (deleteAttempts > 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000))
          }
          // If all attempts fail, silently continue (it's cleanup)
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  // Also clean up orphaned SQLite container directories
  // (directories that exist but aren't in the registry)
  const sqliteContainersDir = paths.getEngineContainersPath('sqlite')
  if (existsSync(sqliteContainersDir)) {
    const dirs = readdirSync(sqliteContainersDir, { withFileTypes: true })
    for (const dir of dirs) {
      if (dir.isDirectory() && testPattern.test(dir.name)) {
        try {
          const dirPath = `${sqliteContainersDir}/${dir.name}`
          await rm(dirPath, { recursive: true, force: true })
          if (!deleted.includes(dir.name)) {
            deleted.push(dir.name)
          }
        } catch {
          // Ignore errors during cleanup
        }
      }
    }
  }

  return deleted
}

/**
 * Execute SQL against a database and return the result
 * For SQLite, the database parameter is the file path
 * For MongoDB, sql is JavaScript code
 * For SurrealDB, options.namespace is required (derived from container name)
 */
export async function executeSQL(
  engine: Engine,
  port: number,
  database: string,
  sql: string,
  options?: { namespace?: string },
): Promise<{ stdout: string; stderr: string }> {
  if (engine === Engine.SQLite) {
    // For SQLite, database is the file path
    // Use configured/bundled sqlite3 if available
    const engineImpl = getEngine(engine)
    const sqlite3Path = await engineImpl.getSqlite3Path().catch(() => null)
    if (!sqlite3Path) {
      throw new Error('sqlite3 not found. Run: spindb engines download sqlite')
    }
    const cmd = `"${sqlite3Path}" "${database}" "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.MySQL) {
    const engineImpl = getEngine(engine)
    // Use configured/bundled mysql if available, otherwise fall back to `mysql` in PATH
    const mysqlPath = await engineImpl.getMysqlClientPath().catch(() => 'mysql')
    const cmd = `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u root ${database} -e "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.MariaDB) {
    const engineImpl = getEngine(engine)
    // Use configured/bundled mariadb if available, otherwise fall back to `mariadb` in PATH
    const mariadbPath = await engineImpl
      .getMariadbClientPath()
      .catch(() => 'mariadb')
    const cmd = `"${mariadbPath}" -h 127.0.0.1 -P ${port} -u root ${database} -e "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.MongoDB || engine === Engine.FerretDB) {
    // MongoDB and FerretDB use mongosh (FerretDB runs with --no-auth for local development)
    return runMongoshCommand(engine, port, database, sql)
  } else if (engine === Engine.Redis) {
    const engineImpl = getEngine(engine)
    // Use configured/bundled redis-cli if available
    const redisCliPath = await engineImpl
      .getRedisCliPath()
      .catch(() => 'redis-cli')
    // For Redis, sql is a Redis command
    const cmd = `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${database} ${sql}`
    return execAsync(cmd)
  } else if (engine === Engine.Valkey) {
    const engineImpl = getEngine(engine)
    // Use configured/bundled valkey-cli if available
    const valkeyCliPath = await engineImpl
      .getValkeyCliPath()
      .catch(() => 'valkey-cli')
    // For Valkey, sql is a Redis-compatible command
    const cmd = `"${valkeyCliPath}" -h 127.0.0.1 -p ${port} -n ${database} ${sql}`
    return execAsync(cmd)
  } else if (engine === Engine.ClickHouse) {
    const engineImpl = getEngine(engine)
    // Use configured/bundled clickhouse if available
    const clickhousePath = await engineImpl
      .getClickHouseClientPath()
      .catch(() => 'clickhouse')
    // For ClickHouse, use clickhouse client
    const cmd = `"${clickhousePath}" client --host 127.0.0.1 --port ${port} --database ${database} --query "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.CockroachDB) {
    const engineImpl = getEngine(engine)
    // Use configured/bundled cockroach if available
    const cockroachPath = await engineImpl
      .getCockroachPath(TEST_VERSIONS.cockroachdb)
      .catch(() => 'cockroach')
    // For CockroachDB, use cockroach sql --insecure
    const cmd = `"${cockroachPath}" sql --insecure --host 127.0.0.1:${port} --database ${database} --execute "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else if (engine === Engine.SurrealDB) {
    const engineImpl = getEngine(engine)
    // Use configured/bundled surreal if available
    const surrealPath = await engineImpl
      .getSurrealPath(TEST_VERSIONS.surrealdb)
      .catch(() => 'surreal')
    // For SurrealDB, use surreal sql with piped input
    // SurrealDB needs namespace - must be provided via options (derive from container name with .replace(/-/g, '_'))
    if (!options?.namespace) {
      throw new Error('SurrealDB requires options.namespace (derive from container name with .replace(/-/g, "_"))')
    }
    // Use spawn with stdin instead of echo pipe for cross-platform compatibility
    const { spawn } = await import('child_process')
    return new Promise((resolve, reject) => {
      const args = [
        'sql',
        '--endpoint', `ws://127.0.0.1:${port}`,
        '--user', 'root',
        '--pass', 'root',
        '--ns', options.namespace!,
        '--db', database,
        '--hide-welcome',
      ]
      const proc = spawn(surrealPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(stderr || `Exit code ${code}`))
      })
      proc.on('error', reject)
      proc.stdin.write(sql)
      proc.stdin.end()
    })
  } else if (engine === Engine.QuestDB) {
    // QuestDB uses PostgreSQL wire protocol with different credentials
    const connectionString = `postgresql://admin:quest@127.0.0.1:${port}/${database}`
    const engineImpl = getEngine(Engine.PostgreSQL)
    const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
    const cmd = `"${psqlPath}" "${connectionString}" -c "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else {
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/${database}`
    const engineImpl = getEngine(engine)
    // Use configured/bundled psql if available, otherwise fall back to `psql` in PATH
    const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
    const cmd = `"${psqlPath}" "${connectionString}" -c "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  }
}

/**
 * Execute a SQL file against a database
 * For SQLite, the database parameter is the file path
 * For MongoDB, the file should be a JavaScript file
 * For SurrealDB, options.namespace is required (derived from container name)
 */
export async function executeSQLFile(
  engine: Engine,
  port: number,
  database: string,
  filePath: string,
  options?: { namespace?: string },
): Promise<{ stdout: string; stderr: string }> {
  if (engine === Engine.SQLite) {
    // For SQLite, database is the file path
    // Use configured/bundled sqlite3 if available
    const engineImpl = getEngine(engine)
    const sqlite3Path = await engineImpl.getSqlite3Path().catch(() => null)
    if (!sqlite3Path) {
      throw new Error('sqlite3 not found. Run: spindb engines download sqlite')
    }
    const cmd = `"${sqlite3Path}" "${database}" < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.MySQL) {
    const engineImpl = getEngine(engine)
    const mysqlPath = await engineImpl.getMysqlClientPath().catch(() => 'mysql')
    const cmd = `"${mysqlPath}" -h 127.0.0.1 -P ${port} -u root ${database} < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.MariaDB) {
    const engineImpl = getEngine(engine)
    const mariadbPath = await engineImpl
      .getMariadbClientPath()
      .catch(() => 'mariadb')
    const cmd = `"${mariadbPath}" -h 127.0.0.1 -P ${port} -u root ${database} < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.MongoDB || engine === Engine.FerretDB) {
    // MongoDB and FerretDB use mongosh (FerretDB runs with --no-auth for local development)
    return runMongoshFile(engine, port, database, filePath)
  } else if (engine === Engine.Redis) {
    const engineImpl = getEngine(engine)
    const redisCliPath = await engineImpl
      .getRedisCliPath()
      .catch(() => 'redis-cli')
    // Redis uses pipe for file input: redis-cli -n <db> < file.redis
    const cmd = `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${database} < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.Valkey) {
    const engineImpl = getEngine(engine)
    const valkeyCliPath = await engineImpl
      .getValkeyCliPath()
      .catch(() => 'valkey-cli')
    // Valkey uses pipe for file input: valkey-cli -n <db> < file.valkey
    const cmd = `"${valkeyCliPath}" -h 127.0.0.1 -p ${port} -n ${database} < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.ClickHouse) {
    const engineImpl = getEngine(engine)
    const clickhousePath = await engineImpl
      .getClickHouseClientPath()
      .catch(() => 'clickhouse')
    // ClickHouse uses pipe for file input with --multiquery flag
    const cmd = `"${clickhousePath}" client --host 127.0.0.1 --port ${port} --database ${database} --multiquery < "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.CockroachDB) {
    const engineImpl = getEngine(engine)
    const cockroachPath = await engineImpl
      .getCockroachPath(TEST_VERSIONS.cockroachdb)
      .catch(() => 'cockroach')
    // CockroachDB uses --file flag for SQL files
    const cmd = `"${cockroachPath}" sql --insecure --host 127.0.0.1:${port} --database ${database} --file "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.SurrealDB) {
    const engineImpl = getEngine(engine)
    const surrealPath = await engineImpl
      .getSurrealPath(TEST_VERSIONS.surrealdb)
      .catch(() => 'surreal')
    // SurrealDB uses surreal import for file input
    // Namespace must be provided via options (derive from container name with .replace(/-/g, '_'))
    if (!options?.namespace) {
      throw new Error('SurrealDB requires options.namespace (derive from container name with .replace(/-/g, "_"))')
    }
    const cmd = `"${surrealPath}" import --endpoint http://127.0.0.1:${port} --user root --pass root --ns ${options.namespace} --db ${database} "${filePath}"`
    return execAsync(cmd)
  } else if (engine === Engine.QuestDB) {
    // QuestDB uses PostgreSQL wire protocol with different credentials
    const connectionString = `postgresql://admin:quest@127.0.0.1:${port}/${database}`
    const engineImpl = getEngine(Engine.PostgreSQL)
    const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
    const cmd = `"${psqlPath}" "${connectionString}" -f "${filePath}"`
    return execAsync(cmd)
  } else {
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/${database}`
    const engineImpl = getEngine(engine)
    const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
    const cmd = `"${psqlPath}" "${connectionString}" -f "${filePath}"`
    return execAsync(cmd)
  }
}

/**
 * Query row count from a table/collection
 * For MongoDB, table is the collection name
 */
export async function getRowCount(
  engine: Engine,
  port: number,
  database: string,
  table: string,
): Promise<number> {
  if (engine === Engine.MongoDB || engine === Engine.FerretDB) {
    // MongoDB/FerretDB uses countDocuments() for collections
    const { stdout } = await executeSQL(
      engine,
      port,
      database,
      `db.${table}.countDocuments()`,
    )
    const num = parseInt(stdout.trim(), 10)
    if (!isNaN(num)) {
      return num
    }
    throw new Error(`Could not parse document count from: ${stdout}`)
  }

  const { stdout } = await executeSQL(
    engine,
    port,
    database,
    `SELECT COUNT(*) as count FROM ${table}`,
  )

  // Parse the count from output
  // PostgreSQL: " count \n-------\n     5\n(1 row)\n"
  // MySQL: "count\n5\n"
  const lines = stdout.trim().split('\n')
  for (const line of lines) {
    const num = parseInt(line.trim(), 10)
    if (!isNaN(num)) {
      return num
    }
  }

  throw new Error(`Could not parse row count from: ${stdout}`)
}

/**
 * Get the count of keys matching a pattern in Redis
 * Uses DBSIZE for full DB count (O(1)), KEYS for filtered patterns (O(N))
 */
export async function getKeyCount(
  port: number,
  database: string,
  pattern: string,
  engine: Engine = Engine.Redis,
): Promise<number> {
  let cliPath: string
  if (engine === Engine.Valkey) {
    const engineImpl = getEngine(Engine.Valkey)
    cliPath = await engineImpl.getValkeyCliPath().catch(() => 'valkey-cli')
  } else {
    const engineImpl = getEngine(Engine.Redis)
    cliPath = await engineImpl.getRedisCliPath().catch(() => 'redis-cli')
  }

  // Use DBSIZE for full wildcard (O(1) vs O(N) for KEYS)
  if (pattern === '*' || pattern === '') {
    const { stdout } = await execAsync(
      `"${cliPath}" -h 127.0.0.1 -p ${port} -n ${database} DBSIZE`,
    )
    const count = parseInt(stdout.trim(), 10)
    if (isNaN(count)) {
      throw new Error(`Could not parse DBSIZE output: ${stdout}`)
    }
    return count
  }

  // Use KEYS for filtered patterns
  const { stdout } = await execAsync(
    `"${cliPath}" -h 127.0.0.1 -p ${port} -n ${database} KEYS "${pattern}"`,
  )
  const trimmed = stdout.trim()
  if (trimmed === '') {
    return 0
  }
  const lines = trimmed.split('\n').filter((line) => line.trim() !== '')
  return lines.length
}

// Get the value of a key in Redis or Valkey
export async function getRedisValue(
  port: number,
  database: string,
  key: string,
  engine: Engine = Engine.Redis,
): Promise<string> {
  let cliPath: string
  if (engine === Engine.Valkey) {
    const engineImpl = getEngine(Engine.Valkey)
    cliPath = await engineImpl.getValkeyCliPath().catch(() => 'valkey-cli')
  } else {
    const engineImpl = getEngine(Engine.Redis)
    cliPath = await engineImpl.getRedisCliPath().catch(() => 'redis-cli')
  }
  const { stdout } = await execAsync(
    `"${cliPath}" -h 127.0.0.1 -p ${port} -n ${database} GET "${key}"`,
  )
  return stdout.trim()
}

// Alias for Valkey value retrieval (uses same protocol)
export async function getValkeyValue(
  port: number,
  database: string,
  key: string,
): Promise<string> {
  return getRedisValue(port, database, key, Engine.Valkey)
}

// Alias for Valkey key count (uses same protocol)
export async function getValkeyKeyCount(
  port: number,
  database: string,
  pattern: string,
): Promise<number> {
  return getKeyCount(port, database, pattern, Engine.Valkey)
}

// Wait for a database to be ready to accept connections
export async function waitForReady(
  engine: Engine,
  port: number,
  timeoutMs = 30000,
): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 500

  while (Date.now() - startTime < timeoutMs) {
    try {
      if (engine === Engine.MySQL || engine === Engine.MariaDB) {
        // Prefer configured/bundled mysqladmin when available
        const engineImpl = getEngine(engine)
        const mysqladmin = await engineImpl
          .getMysqladminPath()
          .catch(() => 'mysqladmin')
        await execAsync(`"${mysqladmin}" -h 127.0.0.1 -P ${port} -u root ping`)
      } else if (engine === Engine.MongoDB || engine === Engine.FerretDB) {
        // Use mongosh to ping MongoDB/FerretDB (both use MongoDB wire protocol)
        const engineImpl = getEngine(engine)
        const mongoshPath = await engineImpl
          .getMongoshPath()
          .catch(() => 'mongosh')
        // Windows uses double quotes, Unix uses single quotes for shell escaping
        const pingScript = 'db.runCommand({ping:1})'
        let cmd: string
        if (isWindows()) {
          cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} --eval "${pingScript}" --quiet`
        } else {
          cmd = `"${mongoshPath}" --host 127.0.0.1 --port ${port} --eval '${pingScript}' --quiet`
        }
        await execAsync(cmd, { timeout: 5000 })
      } else if (engine === Engine.Redis) {
        // Use redis-cli to ping Redis
        const engineImpl = getEngine(engine)
        const redisCliPath = await engineImpl
          .getRedisCliPath()
          .catch(() => 'redis-cli')
        const { stdout } = await execAsync(
          `"${redisCliPath}" -h 127.0.0.1 -p ${port} PING`,
          { timeout: 5000 },
        )
        if (stdout.trim() === 'PONG') {
          return true
        }
      } else if (engine === Engine.Valkey) {
        // Use valkey-cli to ping Valkey
        const engineImpl = getEngine(engine)
        const valkeyCliPath = await engineImpl
          .getValkeyCliPath()
          .catch(() => 'valkey-cli')
        const { stdout } = await execAsync(
          `"${valkeyCliPath}" -h 127.0.0.1 -p ${port} PING`,
          { timeout: 5000 },
        )
        if (stdout.trim() === 'PONG') {
          return true
        }
      } else if (engine === Engine.ClickHouse) {
        // Use clickhouse client to ping ClickHouse
        const engineImpl = getEngine(engine)
        const clickhousePath = await engineImpl
          .getClickHouseClientPath()
          .catch(() => 'clickhouse')
        await execAsync(
          `"${clickhousePath}" client --host 127.0.0.1 --port ${port} --query "SELECT 1"`,
          { timeout: 5000 },
        )
      } else if (engine === Engine.CockroachDB) {
        // Use cockroach sql to ping CockroachDB
        const engineImpl = getEngine(engine)
        const cockroachPath = await engineImpl
          .getCockroachPath(TEST_VERSIONS.cockroachdb)
          .catch(() => 'cockroach')
        await execAsync(
          `"${cockroachPath}" sql --insecure --host 127.0.0.1:${port} --execute "SELECT 1"`,
          { timeout: 5000 },
        )
      } else if (engine === Engine.Qdrant) {
        // Use fetch to ping Qdrant REST API with timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          if (response.ok) {
            return true
          }
        } catch {
          clearTimeout(timeoutId)
          throw new Error('Qdrant health check failed or timed out')
        }
      } else if (engine === Engine.Meilisearch) {
        // Use fetch to ping Meilisearch REST API with timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          if (response.ok) {
            return true
          }
        } catch {
          clearTimeout(timeoutId)
          throw new Error('Meilisearch health check failed or timed out')
        }
      } else if (engine === Engine.CouchDB) {
        // Use fetch to ping CouchDB REST API with timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          if (response.ok) {
            return true
          }
        } catch {
          clearTimeout(timeoutId)
          throw new Error('CouchDB health check failed or timed out')
        }
      } else if (engine === Engine.SurrealDB) {
        // Use surreal isready to ping SurrealDB
        const engineImpl = getEngine(engine)
        const surrealPath = await engineImpl
          .getSurrealPath(TEST_VERSIONS.surrealdb)
          .catch(() => 'surreal')
        await execAsync(
          `"${surrealPath}" isready --endpoint http://127.0.0.1:${port}`,
          { timeout: 5000 },
        )
      } else if (engine === Engine.QuestDB) {
        // Use psql to ping QuestDB via PostgreSQL wire protocol
        const engineImpl = getEngine(Engine.PostgreSQL)
        const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
        await execAsync(
          `"${psqlPath}" "postgresql://admin:quest@127.0.0.1:${port}/qdb" -c "SELECT 1"`,
          { timeout: 5000 },
        )
      } else {
        // Use the engine-provided psql binary when available to avoid relying
        // on a psql in PATH (which may not exist on Windows)
        const engineImpl = getEngine(engine)
        const psqlPath = await engineImpl.getPsqlPath().catch(() => 'psql')
        await execAsync(
          `"${psqlPath}" "postgresql://postgres@127.0.0.1:${port}/postgres" -c "SELECT 1"`,
        )
      }
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }
  }

  return false
}

/**
 * Wait for a container to be fully stopped (process terminated, PID file removed).
 * This is important for operations like rename that require the container to be stopped.
 *
 * On Windows, also waits for ports to be released and adds extra delay for file handles.
 */
export async function waitForStopped(
  containerName: string,
  engine: Engine,
  timeoutMs = 30000,
): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 200

  // First wait for process to stop
  while (Date.now() - startTime < timeoutMs) {
    const running = await processManager.isRunning(containerName, { engine })
    if (!running) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval))
  }

  // Check if we timed out waiting for process
  const stillRunning = await processManager.isRunning(containerName, { engine })
  if (stillRunning) {
    console.log(
      `   ⚠️  waitForStopped: TIMEOUT - "${containerName}" still running after ${timeoutMs}ms`,
    )
    return false
  }

  // For Qdrant on Windows, also wait for ports to be released
  // Windows is slower to release ports after process termination (TIME_WAIT state)
  // Can take 30+ seconds for TCP ports to be fully released
  if (engine === Engine.Qdrant && isWindows()) {
    const config = await containerManager.getConfig(containerName)
    if (config) {
      const httpPort = config.port
      const grpcPort = config.port + 1

      // Wait for both HTTP and gRPC ports to be available
      // Use 60 seconds to match the engine's port wait timeout
      const portTimeoutMs = Math.min(60000, timeoutMs - (Date.now() - startTime))
      const portStartTime = Date.now()

      while (Date.now() - portStartTime < portTimeoutMs) {
        const httpAvailable = await portManager.isPortAvailable(httpPort)
        const grpcAvailable = await portManager.isPortAvailable(grpcPort)

        if (httpAvailable && grpcAvailable) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval))
      }

      // Verify ports are actually available after waiting
      const finalHttpAvailable = await portManager.isPortAvailable(httpPort)
      const finalGrpcAvailable = await portManager.isPortAvailable(grpcPort)
      if (!finalHttpAvailable || !finalGrpcAvailable) {
        console.log(
          `   ⚠️  waitForStopped: Ports still in use after ${portTimeoutMs}ms - ` +
            `HTTP:${httpPort}=${finalHttpAvailable}, gRPC:${grpcPort}=${finalGrpcAvailable}`,
        )
      }
    }
  }

  // On Windows, add extra delay for file handle release
  // Memory-mapped files and Windows antivirus/indexing can hold handles
  // This helps prevent EBUSY/EPERM errors during rename/delete operations
  if (isWindows()) {
    // SurrealDB uses memory-mapped files that take a very long time to release on Windows
    // Even after the process exits, the OS may hold handles for 30+ seconds
    // Qdrant also uses persistent storage but typically releases faster
    let extraDelay: number
    if (engine === Engine.SurrealDB) {
      extraDelay = 30000 // 30 seconds for SurrealDB
    } else if (engine === Engine.Qdrant) {
      extraDelay = 15000 // 15 seconds for Qdrant
    } else {
      extraDelay = 10000 // 10 seconds for other engines
    }
    await new Promise((resolve) => setTimeout(resolve, extraDelay))
  }

  return true
}

/**
 * Check if a container's data directory exists on the filesystem
 * For SQLite, checks the registry instead
 */
export function containerDataExists(
  containerName: string,
  engine: Engine,
): boolean {
  if (engine === Engine.SQLite) {
    // SQLite doesn't use container directories, just registry entries
    // This function should check if registry entry exists
    // For simplicity in tests, we return false for SQLite
    return false
  }
  const containerPath = paths.getContainerPath(containerName, { engine })
  return existsSync(containerPath)
}

// Check if a SQLite database file exists
export function sqliteFileExists(filePath: string): boolean {
  return existsSync(filePath)
}

// Get connection string for a container
export function getConnectionString(
  engine: Engine,
  port: number,
  database: string,
): string {
  if (engine === Engine.MySQL || engine === Engine.MariaDB) {
    return `mysql://root@127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.MongoDB) {
    return `mongodb://127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.FerretDB) {
    return `mongodb://127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.Redis || engine === Engine.Valkey) {
    return `redis://127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.ClickHouse) {
    return `clickhouse://default@127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.Qdrant) {
    return `http://127.0.0.1:${port}`
  }
  if (engine === Engine.Meilisearch) {
    return `http://127.0.0.1:${port}`
  }
  if (engine === Engine.CouchDB) {
    return `http://127.0.0.1:${port}/${database}`
  }
  if (engine === Engine.CockroachDB) {
    return `postgresql://root@127.0.0.1:${port}/${database}?sslmode=disable`
  }
  if (engine === Engine.SurrealDB) {
    return `ws://127.0.0.1:${port}/rpc`
  }
  return `postgresql://postgres@127.0.0.1:${port}/${database}`
}

// Qdrant helper functions

/**
 * Get the number of collections in Qdrant
 */
export async function getQdrantCollectionCount(port: number): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/collections`)
    const data = await response.json() as { result?: { collections?: unknown[] } }
    return data.result?.collections?.length || 0
  } catch {
    return 0
  }
}

/**
 * Create a collection in Qdrant
 */
export async function createQdrantCollection(
  port: number,
  name: string,
  vectorSize = 128,
): Promise<boolean> {
  try {
    const encodedName = encodeURIComponent(name)
    const response = await fetch(`http://127.0.0.1:${port}/collections/${encodedName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vectors: {
          size: vectorSize,
          distance: 'Cosine',
        },
      }),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Delete a collection in Qdrant
 */
export async function deleteQdrantCollection(
  port: number,
  name: string,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/collections/${name}`, {
      method: 'DELETE',
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Get the point count in a Qdrant collection
 */
export async function getQdrantPointCount(
  port: number,
  collection: string,
): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/collections/${collection}`)
    const data = await response.json() as { result?: { points_count?: number } }
    return data.result?.points_count || 0
  } catch {
    return 0
  }
}

/**
 * Insert points into a Qdrant collection
 */
export async function insertQdrantPoints(
  port: number,
  collection: string,
  points: Array<{ id: number; vector: number[]; payload?: Record<string, unknown> }>,
): Promise<boolean> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/collections/${collection}/points`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points }),
      },
    )
    return response.ok
  } catch {
    return false
  }
}

/**
 * Get the highest available version for an engine.
 * Fetches available versions from hostdb or the fallback version map.
 */
export async function getAvailableVersion(engine: Engine): Promise<string> {
  const engineImpl = getEngine(engine)
  const versions = await engineImpl.fetchAvailableVersions()
  const availableVersions = Object.keys(versions)

  if (availableVersions.length === 0) {
    throw new Error(`No available versions found for ${engine}`)
  }

  // Return the highest available semantic version
  return availableVersions.sort((a, b) => compareVersions(b, a))[0]
}

// Execute SQL file using engine.runScript (tests the run command functionality)
export async function runScriptFile(
  containerName: string,
  filePath: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    throw new Error(`Container "${containerName}" not found`)
  }

  const engine = getEngine(config.engine)
  await engine.runScript(config, {
    file: filePath,
    database,
  })
}

// Execute inline SQL using engine.runScript (tests the run command functionality)
export async function runScriptSQL(
  containerName: string,
  sql: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    throw new Error(`Container "${containerName}" not found`)
  }

  const engine = getEngine(config.engine)
  await engine.runScript(config, {
    sql,
    database,
  })
}

/**
 * Execute inline JavaScript using engine.runScript for MongoDB-compatible engines.
 * Alias for runScriptSQL - MongoDB/FerretDB use JavaScript instead of SQL.
 * Named separately for clarity when testing document databases.
 */
export async function runScriptJS(
  containerName: string,
  script: string,
  database?: string,
): Promise<void> {
  return runScriptSQL(containerName, script, database)
}

// Meilisearch helper functions

/**
 * Get the number of indexes in Meilisearch
 */
export async function getMeilisearchIndexCount(port: number): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/indexes`)
    const data = (await response.json()) as { results?: unknown[] }
    return data.results?.length || 0
  } catch {
    return 0
  }
}

/**
 * Create an index in Meilisearch
 */
export async function createMeilisearchIndex(
  port: number,
  uid: string,
  primaryKey = 'id',
): Promise<{ success: boolean; taskUid?: number }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/indexes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid,
        primaryKey,
      }),
    })
    // Meilisearch returns 202 Accepted for async tasks
    if (response.status === 202 || response.ok) {
      const data = (await response.json()) as { taskUid?: number }
      return { success: true, taskUid: data.taskUid }
    }
    return { success: false }
  } catch {
    return { success: false }
  }
}

/**
 * Wait for a Meilisearch task to complete
 */
export async function waitForMeilisearchTask(
  port: number,
  taskUid: number,
  timeoutMs = 30000,
): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 200

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/tasks/${taskUid}`)
      const task = (await response.json()) as { status?: string }
      if (task.status === 'succeeded') {
        return true
      }
      if (task.status === 'failed') {
        return false
      }
    } catch {
      // Ignore errors and keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, checkInterval))
  }
  return false
}

/**
 * Delete an index in Meilisearch
 */
export async function deleteMeilisearchIndex(
  port: number,
  uid: string,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/indexes/${uid}`, {
      method: 'DELETE',
    })
    return response.status === 202 || response.ok
  } catch {
    return false
  }
}

/**
 * Get the document count in a Meilisearch index
 */
export async function getMeilisearchDocumentCount(
  port: number,
  indexUid: string,
): Promise<number> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/indexes/${indexUid}/stats`,
    )
    const data = (await response.json()) as { numberOfDocuments?: number }
    return data.numberOfDocuments || 0
  } catch {
    return 0
  }
}

/**
 * Insert documents into a Meilisearch index
 */
export async function insertMeilisearchDocuments(
  port: number,
  indexUid: string,
  documents: Array<Record<string, unknown>>,
): Promise<{ success: boolean; taskUid?: number }> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/indexes/${indexUid}/documents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(documents),
      },
    )
    if (response.status === 202 || response.ok) {
      const data = (await response.json()) as { taskUid?: number }
      return { success: true, taskUid: data.taskUid }
    }
    return { success: false }
  } catch {
    return { success: false }
  }
}

// CouchDB helper functions
// CouchDB 3.x requires admin authentication for most operations
const COUCHDB_AUTH_HEADER = `Basic ${Buffer.from('admin:admin').toString('base64')}`

/**
 * Get the number of databases in CouchDB (excluding system databases)
 */
export async function getCouchDBDatabaseCount(port: number): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_all_dbs`, {
      headers: { Authorization: COUCHDB_AUTH_HEADER },
    })
    const data = (await response.json()) as string[]
    // Filter out system databases (starting with _)
    return data.filter((db) => !db.startsWith('_')).length
  } catch {
    return 0
  }
}

/**
 * Create a database in CouchDB
 */
export async function createCouchDBDatabase(
  port: number,
  name: string,
): Promise<boolean> {
  try {
    const encodedName = encodeURIComponent(name)
    const response = await fetch(`http://127.0.0.1:${port}/${encodedName}`, {
      method: 'PUT',
      headers: { Authorization: COUCHDB_AUTH_HEADER },
    })
    // 201 = created, 412 = already exists (both are acceptable)
    return response.status === 201 || response.status === 412
  } catch {
    return false
  }
}

/**
 * Delete a database in CouchDB
 */
export async function deleteCouchDBDatabase(
  port: number,
  name: string,
): Promise<boolean> {
  try {
    const encodedName = encodeURIComponent(name)
    const response = await fetch(`http://127.0.0.1:${port}/${encodedName}`, {
      method: 'DELETE',
      headers: { Authorization: COUCHDB_AUTH_HEADER },
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Get the document count in a CouchDB database
 */
export async function getCouchDBDocumentCount(
  port: number,
  database: string,
): Promise<number> {
  try {
    const encodedDb = encodeURIComponent(database)
    const response = await fetch(`http://127.0.0.1:${port}/${encodedDb}`, {
      headers: { Authorization: COUCHDB_AUTH_HEADER },
    })
    const data = (await response.json()) as { doc_count?: number }
    return data.doc_count || 0
  } catch {
    return 0
  }
}

/**
 * Insert documents into a CouchDB database using _bulk_docs
 */
export async function insertCouchDBDocuments(
  port: number,
  database: string,
  documents: Array<Record<string, unknown>>,
): Promise<boolean> {
  try {
    const encodedDb = encodeURIComponent(database)
    const response = await fetch(
      `http://127.0.0.1:${port}/${encodedDb}/_bulk_docs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: COUCHDB_AUTH_HEADER,
        },
        body: JSON.stringify({ docs: documents }),
      },
    )
    return response.status === 201
  } catch {
    return false
  }
}

/**
 * Get all documents from a CouchDB database
 */
export async function getCouchDBDocuments(
  port: number,
  database: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const encodedDb = encodeURIComponent(database)
    const response = await fetch(
      `http://127.0.0.1:${port}/${encodedDb}/_all_docs?include_docs=true`,
      { headers: { Authorization: COUCHDB_AUTH_HEADER } },
    )
    const data = (await response.json()) as {
      rows?: Array<{ doc?: Record<string, unknown> }>
    }
    return (
      data.rows
        ?.map((row) => row.doc)
        .filter((doc): doc is Record<string, unknown> => doc !== undefined) ||
      []
    )
  } catch {
    return []
  }
}
