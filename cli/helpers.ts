import { existsSync } from 'fs'
import { readdir, lstat } from 'fs/promises'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { paths } from '../config/paths'
import { platformService } from '../core/platform-service'

const execFileAsync = promisify(execFile)

// Parsed engine directory info
type ParsedEngineDir = {
  version: string
  platform: string
  arch: string
  path: string
}

// Parse engine directory name into components
// Format: {engine}-{version}-{platform}-{arch}
// Handles versions with dashes (e.g., 17.0.0-rc1) by splitting from the end
function parseEngineDirectory(
  entryName: string,
  enginePrefix: string,
  binDir: string,
): ParsedEngineDir | null {
  const rest = entryName.slice(enginePrefix.length)
  const parts = rest.split('-')
  if (parts.length < 3) return null

  const arch = parts.pop()!
  const platform = parts.pop()!
  const version = parts.join('-')

  if (!version || !platform || !arch) return null

  return {
    version,
    platform,
    arch,
    path: join(binDir, entryName),
  }
}

// Calculate the total size of all files in a directory (recursive)
async function calculateDirectorySize(dirPath: string): Promise<number> {
  let sizeBytes = 0
  try {
    const files = await readdir(dirPath, { recursive: true })
    for (const file of files) {
      try {
        const filePath = join(dirPath, file.toString())
        const fileStat = await lstat(filePath)
        if (fileStat.isFile()) {
          sizeBytes += fileStat.size
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return sizeBytes
}

export type InstalledPostgresEngine = {
  engine: 'postgresql'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledMariadbEngine = {
  engine: 'mariadb'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledMysqlEngine = {
  engine: 'mysql'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledSqliteEngine = {
  engine: 'sqlite'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledDuckDBEngine = {
  engine: 'duckdb'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledMongodbEngine = {
  engine: 'mongodb'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledRedisEngine = {
  engine: 'redis'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledValkeyEngine = {
  engine: 'valkey'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledClickHouseEngine = {
  engine: 'clickhouse'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledQdrantEngine = {
  engine: 'qdrant'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledMeilisearchEngine = {
  engine: 'meilisearch'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledFerretDBEngine = {
  engine: 'ferretdb'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledCouchDBEngine = {
  engine: 'couchdb'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledCockroachDBEngine = {
  engine: 'cockroachdb'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledSurrealDBEngine = {
  engine: 'surrealdb'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledQuestDBEngine = {
  engine: 'questdb'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledTypeDBEngine = {
  engine: 'typedb'
  version: string
  platform: string
  arch: string
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export type InstalledEngine =
  | InstalledPostgresEngine
  | InstalledMariadbEngine
  | InstalledMysqlEngine
  | InstalledSqliteEngine
  | InstalledDuckDBEngine
  | InstalledMongodbEngine
  | InstalledFerretDBEngine
  | InstalledRedisEngine
  | InstalledValkeyEngine
  | InstalledClickHouseEngine
  | InstalledQdrantEngine
  | InstalledMeilisearchEngine
  | InstalledCouchDBEngine
  | InstalledCockroachDBEngine
  | InstalledSurrealDBEngine
  | InstalledQuestDBEngine
  | InstalledTypeDBEngine

async function getPostgresVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const postgresPath = join(binPath, 'bin', `postgres${ext}`)
  if (!existsSync(postgresPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(postgresPath, ['--version'])
    const match = stdout.match(/\(PostgreSQL\)\s+([\d.]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

export async function getInstalledPostgresEngines(): Promise<
  InstalledPostgresEngine[]
> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledPostgresEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('postgresql-')) continue

    const parsed = parseEngineDirectory(entry.name, 'postgresql-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getPostgresVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'postgresql',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

async function getMariadbVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  // Try mariadbd first, then mysqld
  let serverPath = join(binPath, 'bin', `mariadbd${ext}`)
  if (!existsSync(serverPath)) {
    serverPath = join(binPath, 'bin', `mysqld${ext}`)
  }
  if (!existsSync(serverPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(serverPath, ['--version'])
    // Parse output like "mariadbd  Ver 11.8.5-MariaDB"
    const match = stdout.match(/Ver\s+([\d.]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

export async function getInstalledMariadbEngines(): Promise<
  InstalledMariadbEngine[]
> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledMariadbEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('mariadb-')) continue

    const parsed = parseEngineDirectory(entry.name, 'mariadb-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getMariadbVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'mariadb',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

async function getMysqlVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const serverPath = join(binPath, 'bin', `mysqld${ext}`)
  if (!existsSync(serverPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(serverPath, ['--version'])
    // Parse output like "mysqld  Ver 8.0.40 for Linux on x86_64"
    const match = stdout.match(/Ver\s+([\d.]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed MySQL engines from downloaded binaries
async function getInstalledMysqlEngines(): Promise<InstalledMysqlEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledMysqlEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('mysql-')) continue

    const parsed = parseEngineDirectory(entry.name, 'mysql-', binDir)
    if (!parsed) continue

    const actualVersion = (await getMysqlVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'mysql',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get SQLite version from binary path
async function getSqliteVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const sqlite3Path = join(binPath, 'bin', `sqlite3${ext}`)
  if (!existsSync(sqlite3Path)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(sqlite3Path, ['--version'])
    // sqlite3 --version outputs: "3.51.2 2025-01-08 12:00:00 ..."
    const match = stdout.match(/^(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed SQLite engines from downloaded binaries
async function getInstalledSqliteEngines(): Promise<InstalledSqliteEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledSqliteEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('sqlite-')) continue

    const parsed = parseEngineDirectory(entry.name, 'sqlite-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getSqliteVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'sqlite',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get DuckDB version from binary path
async function getDuckDBVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const duckdbPath = join(binPath, 'bin', `duckdb${ext}`)
  if (!existsSync(duckdbPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(duckdbPath, ['--version'])
    // duckdb --version outputs: "v1.4.3 abcdef123" or just "1.4.3"
    const match = stdout.match(/v?(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed DuckDB engines from downloaded binaries
async function getInstalledDuckDBEngines(): Promise<InstalledDuckDBEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledDuckDBEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('duckdb-')) continue

    const parsed = parseEngineDirectory(entry.name, 'duckdb-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getDuckDBVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'duckdb',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get MongoDB version from binary path
async function getMongodbVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const serverPath = join(binPath, 'bin', `mongod${ext}`)
  if (!existsSync(serverPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(serverPath, ['--version'])
    // Parse output like "db version v7.0.28"
    const match = stdout.match(/v([\d.]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed MongoDB engines from downloaded binaries
async function getInstalledMongodbEngines(): Promise<InstalledMongodbEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledMongodbEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('mongodb-')) continue

    const parsed = parseEngineDirectory(entry.name, 'mongodb-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getMongodbVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'mongodb',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get Redis version from binary path
async function getRedisVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const serverPath = join(binPath, 'bin', `redis-server${ext}`)
  if (!existsSync(serverPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(serverPath, ['--version'])
    // Parse output like "Redis server v=7.4.7 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=..."
    const match = stdout.match(/v=([\d.]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed Redis engines from downloaded binaries
async function getInstalledRedisEngines(): Promise<InstalledRedisEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledRedisEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('redis-')) continue

    const parsed = parseEngineDirectory(entry.name, 'redis-', binDir)
    if (!parsed) continue

    const actualVersion = (await getRedisVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'redis',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get Valkey version from binary path
async function getValkeyVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const serverPath = join(binPath, 'bin', `valkey-server${ext}`)
  if (!existsSync(serverPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(serverPath, ['--version'])
    // Parse output like "Valkey server v=8.0.6 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=..."
    const match = stdout.match(/v=([\d.]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed Valkey engines from downloaded binaries
async function getInstalledValkeyEngines(): Promise<InstalledValkeyEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledValkeyEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('valkey-')) continue

    const parsed = parseEngineDirectory(entry.name, 'valkey-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getValkeyVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'valkey',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get ClickHouse version from binary path
async function getClickHouseVersion(binPath: string): Promise<string | null> {
  const clickhousePath = join(binPath, 'bin', 'clickhouse')
  if (!existsSync(clickhousePath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(clickhousePath, [
      'client',
      '--version',
    ])
    // Parse output like "ClickHouse client version 25.12.3.21 (official build)"
    const match = stdout.match(/version\s+([\d.]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed ClickHouse engines from downloaded binaries
async function getInstalledClickHouseEngines(): Promise<
  InstalledClickHouseEngine[]
> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledClickHouseEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('clickhouse-')) continue

    const parsed = parseEngineDirectory(entry.name, 'clickhouse-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getClickHouseVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'clickhouse',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get Qdrant version from binary path
async function getQdrantVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const qdrantPath = join(binPath, 'bin', `qdrant${ext}`)
  if (!existsSync(qdrantPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(qdrantPath, ['--version'])
    // Parse output like "qdrant 1.16.3" or "v1.16.3"
    const match = stdout.match(/(?:qdrant\s+)?v?(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed Qdrant engines from downloaded binaries
async function getInstalledQdrantEngines(): Promise<InstalledQdrantEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledQdrantEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('qdrant-')) continue

    const parsed = parseEngineDirectory(entry.name, 'qdrant-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getQdrantVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'qdrant',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get Meilisearch version from binary path
async function getMeilisearchVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const meilisearchPath = join(binPath, 'bin', `meilisearch${ext}`)
  if (!existsSync(meilisearchPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(meilisearchPath, ['--version'])
    // Parse output like "meilisearch 1.33.1" or "v1.33.1"
    const match = stdout.match(/(?:meilisearch\s+)?v?(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed Meilisearch engines from downloaded binaries
async function getInstalledMeilisearchEngines(): Promise<
  InstalledMeilisearchEngine[]
> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledMeilisearchEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('meilisearch-')) continue

    const parsed = parseEngineDirectory(entry.name, 'meilisearch-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getMeilisearchVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'meilisearch',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get CouchDB version from binary path
// Note: CouchDB doesn't support --version flag, so we just verify the binary exists
// and return null to use the version from the directory name
async function getCouchDBVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const couchdbPath = join(binPath, 'bin', `couchdb${ext}`)
  if (!existsSync(couchdbPath)) {
    return null
  }
  // CouchDB is an Erlang app that tries to start when run with any args
  // Just return null to use directory-parsed version
  return null
}

// Get installed CouchDB engines from downloaded binaries
async function getInstalledCouchDBEngines(): Promise<InstalledCouchDBEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledCouchDBEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('couchdb-')) continue

    const parsed = parseEngineDirectory(entry.name, 'couchdb-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getCouchDBVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'couchdb',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get CockroachDB version from binary path
async function getCockroachDBVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const cockroachPath = join(binPath, 'bin', `cockroach${ext}`)
  if (!existsSync(cockroachPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(cockroachPath, ['version'])
    // Parse output like "Build Tag:        v25.4.2" or "CockroachDB CCL v25.4.2"
    const match = stdout.match(/v?(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed CockroachDB engines from downloaded binaries
async function getInstalledCockroachDBEngines(): Promise<
  InstalledCockroachDBEngine[]
> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledCockroachDBEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('cockroachdb-')) continue

    const parsed = parseEngineDirectory(entry.name, 'cockroachdb-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getCockroachDBVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'cockroachdb',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get SurrealDB version from binary path
async function getSurrealDBVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const surrealPath = join(binPath, 'bin', `surreal${ext}`)
  if (!existsSync(surrealPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(surrealPath, ['version'])
    // Parse output like "surreal 2.3.2 for linux on x86_64" or "2.3.2"
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed SurrealDB engines from downloaded binaries
async function getInstalledSurrealDBEngines(): Promise<
  InstalledSurrealDBEngine[]
> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledSurrealDBEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('surrealdb-')) continue

    const parsed = parseEngineDirectory(entry.name, 'surrealdb-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getSurrealDBVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'surrealdb',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get QuestDB version from directory path
// QuestDB doesn't have a simple --version flag, extract from directory name
async function getQuestDBVersion(binPath: string): Promise<string | null> {
  const platform = platformService.getPlatformInfo().platform
  // Check for questdb startup script
  if (platform === 'win32') {
    if (!existsSync(join(binPath, 'questdb.exe'))) {
      return null
    }
  } else {
    if (!existsSync(join(binPath, 'questdb.sh'))) {
      return null
    }
  }
  // Version is embedded in directory name, return null to use directory-parsed version
  return null
}

// Get installed QuestDB engines from downloaded binaries
async function getInstalledQuestDBEngines(): Promise<InstalledQuestDBEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledQuestDBEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('questdb-')) continue

    const parsed = parseEngineDirectory(entry.name, 'questdb-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getQuestDBVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'questdb',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get TypeDB version from binary path
// TypeDB is a Rust binary but uses a launcher script. Check for server binary existence.
async function getTypeDBVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const serverPath = join(binPath, 'bin', `typedb_server_bin${ext}`)
  if (!existsSync(serverPath)) {
    return null
  }
  // TypeDB server binary doesn't have a simple --version flag
  // Return null to use directory-parsed version
  return null
}

// Get installed TypeDB engines from downloaded binaries
async function getInstalledTypeDBEngines(): Promise<InstalledTypeDBEngine[]> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledTypeDBEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('typedb-')) continue

    const parsed = parseEngineDirectory(entry.name, 'typedb-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getTypeDBVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'typedb',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

// Get FerretDB version from binary path
async function getFerretDBVersion(binPath: string): Promise<string | null> {
  const ext = platformService.getExecutableExtension()
  const ferretdbPath = join(binPath, 'bin', `ferretdb${ext}`)
  if (!existsSync(ferretdbPath)) {
    return null
  }

  try {
    const { stdout } = await execFileAsync(ferretdbPath, ['--version'])
    // Parse output like "ferretdb version 2.7.0" or "v2.7.0"
    const match = stdout.match(
      /(?:ferretdb\s+)?(?:version\s+)?v?(\d+\.\d+\.\d+)/,
    )
    return match ? match[1] : null
  } catch {
    return null
  }
}

// Get installed FerretDB engines from downloaded binaries
async function getInstalledFerretDBEngines(): Promise<
  InstalledFerretDBEngine[]
> {
  const binDir = paths.bin

  if (!existsSync(binDir)) {
    return []
  }

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledFerretDBEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('ferretdb-')) continue

    const parsed = parseEngineDirectory(entry.name, 'ferretdb-', binDir)
    if (!parsed) continue

    const actualVersion =
      (await getFerretDBVersion(parsed.path)) || parsed.version
    const sizeBytes = await calculateDirectorySize(parsed.path)

    engines.push({
      engine: 'ferretdb',
      version: actualVersion,
      platform: parsed.platform,
      arch: parsed.arch,
      path: parsed.path,
      sizeBytes,
      source: 'downloaded',
    })
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((p) => parseInt(p, 10) || 0)
  const partsB = b.split('.').map((p) => parseInt(p, 10) || 0)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA !== numB) return numA - numB
  }
  return 0
}

/**
 * Known engine directory prefixes in the bin directory.
 * Directory names follow the pattern: {engine}-{version}-{platform}-{arch}
 */
const ENGINE_PREFIXES = [
  'postgresql-',
  'mysql-',
  'mariadb-',
  'sqlite-',
  'duckdb-',
  'mongodb-',
  'ferretdb-',
  'postgresql-documentdb-',
  'redis-',
  'valkey-',
  'clickhouse-',
  'qdrant-',
  'meilisearch-',
  'couchdb-',
  'cockroachdb-',
  'surrealdb-',
  'questdb-',
  'typedb-',
] as const

/**
 * Lightweight check to see if any engines are installed.
 * Only reads the bin directory - no subprocess spawning or size calculations.
 * Use this for UI decisions where you only need to know if engines exist.
 * Validates directory names against known engine prefixes to avoid false positives.
 */
export async function hasAnyInstalledEngines(): Promise<boolean> {
  const binDir = paths.bin
  if (!existsSync(binDir)) {
    return false
  }

  try {
    const entries = await readdir(binDir, { withFileTypes: true })
    return entries.some(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        ENGINE_PREFIXES.some((prefix) => entry.name.startsWith(prefix)),
    )
  } catch {
    return false
  }
}

export async function getInstalledEngines(): Promise<InstalledEngine[]> {
  // Parallelize all engine checks for faster startup
  const [
    pgEngines,
    mariadbEngines,
    mysqlEngines,
    sqliteEngines,
    duckdbEngines,
    mongodbEngines,
    ferretdbEngines,
    redisEngines,
    valkeyEngines,
    clickhouseEngines,
    qdrantEngines,
    meilisearchEngines,
    couchdbEngines,
    cockroachdbEngines,
    surrealdbEngines,
    questdbEngines,
    typedbEngines,
  ] = await Promise.all([
    getInstalledPostgresEngines(),
    getInstalledMariadbEngines(),
    getInstalledMysqlEngines(),
    getInstalledSqliteEngines(),
    getInstalledDuckDBEngines(),
    getInstalledMongodbEngines(),
    getInstalledFerretDBEngines(),
    getInstalledRedisEngines(),
    getInstalledValkeyEngines(),
    getInstalledClickHouseEngines(),
    getInstalledQdrantEngines(),
    getInstalledMeilisearchEngines(),
    getInstalledCouchDBEngines(),
    getInstalledCockroachDBEngines(),
    getInstalledSurrealDBEngines(),
    getInstalledQuestDBEngines(),
    getInstalledTypeDBEngines(),
  ])

  return [
    ...pgEngines,
    ...mariadbEngines,
    ...mysqlEngines,
    ...sqliteEngines,
    ...duckdbEngines,
    ...mongodbEngines,
    ...ferretdbEngines,
    ...redisEngines,
    ...valkeyEngines,
    ...clickhouseEngines,
    ...qdrantEngines,
    ...meilisearchEngines,
    ...couchdbEngines,
    ...cockroachdbEngines,
    ...surrealdbEngines,
    ...questdbEngines,
    ...typedbEngines,
  ]
}

// Export individual engine detection functions for use in other modules
export {
  getInstalledMysqlEngines,
  getInstalledSqliteEngines,
  getInstalledDuckDBEngines,
  getInstalledMongodbEngines,
  getInstalledFerretDBEngines,
  getInstalledRedisEngines,
  getInstalledValkeyEngines,
  getInstalledClickHouseEngines,
  getInstalledQdrantEngines,
  getInstalledMeilisearchEngines,
  getInstalledCouchDBEngines,
  getInstalledCockroachDBEngines,
  getInstalledSurrealDBEngines,
  getInstalledQuestDBEngines,
  getInstalledTypeDBEngines,
}
