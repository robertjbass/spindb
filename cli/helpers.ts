import { existsSync, realpathSync } from 'fs'
import { readdir, lstat } from 'fs/promises'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { paths } from '../config/paths'
import { platformService } from '../core/platform-service'
import {
  getMysqldPath,
  getMysqlVersion,
} from '../engines/mysql/binary-detection'
import {
  getMongodPath,
  getMongodVersion,
} from '../engines/mongodb/binary-detection'
import {
  getRedisServerPath,
  getRedisVersion,
} from '../engines/redis/binary-detection'

const execFileAsync = promisify(execFile)

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
  path: string
  source: 'system'
  isMariaDB: boolean
  formulaName: string // e.g., 'mysql', 'mysql@8.0', 'mariadb'
}

export type InstalledSqliteEngine = {
  engine: 'sqlite'
  version: string
  path: string
  source: 'system'
}

export type InstalledMongodbEngine = {
  engine: 'mongodb'
  version: string
  path: string
  source: 'system'
  formulaName: string // e.g., 'mongodb-community', 'mongodb-community@7.0'
}

export type InstalledRedisEngine = {
  engine: 'redis'
  version: string
  path: string
  source: 'system'
  formulaName: string // e.g., 'redis', 'redis@6.2', 'redis@7.0'
}

export type InstalledEngine =
  | InstalledPostgresEngine
  | InstalledMariadbEngine
  | InstalledMysqlEngine
  | InstalledSqliteEngine
  | InstalledMongodbEngine
  | InstalledRedisEngine

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
    if (entry.isDirectory()) {
      const match = entry.name.match(/^(\w+)-(.+)-(\w+)-(\w+)$/)
      if (match && match[1] === 'postgresql') {
        const [, , majorVersion, platform, arch] = match
        const dirPath = join(binDir, entry.name)

        const actualVersion =
          (await getPostgresVersion(dirPath)) || majorVersion

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

        engines.push({
          engine: 'postgresql',
          version: actualVersion,
          platform,
          arch,
          path: dirPath,
          sizeBytes,
          source: 'downloaded',
        })
      }
    }
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
    if (entry.isDirectory()) {
      // Match mariadb-{version}-{platform}-{arch} directories
      const match = entry.name.match(/^(\w+)-([\d.]+)-(\w+)-(\w+)$/)
      if (match && match[1] === 'mariadb') {
        const [, , majorVersion, platform, arch] = match
        const dirPath = join(binDir, entry.name)

        const actualVersion =
          (await getMariadbVersion(dirPath)) || majorVersion

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

        engines.push({
          engine: 'mariadb',
          version: actualVersion,
          platform,
          arch,
          path: dirPath,
          sizeBytes,
          source: 'downloaded',
        })
      }
    }
  }

  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

/**
 * Extract Homebrew formula name from a binary path by resolving symlinks
 */
function extractHomebrewFormula(
  binaryPath: string,
  defaultName: string,
): string {
  let resolvedPath = binaryPath
  try {
    resolvedPath = realpathSync(binaryPath)
  } catch {
    // Use original path if resolution fails
  }

  // Try to extract from Cellar path first (most reliable after symlink resolution)
  // Format: /opt/homebrew/Cellar/<formula>/<version>/bin/binary
  const cellarMatch = resolvedPath.match(
    /\/(?:opt\/homebrew|usr\/local)\/Cellar\/([^/]+)\//,
  )
  if (cellarMatch) {
    return cellarMatch[1]
  }

  // Fall back to opt path pattern
  // Format: /opt/homebrew/opt/<formula>/bin/binary
  const optMatch = resolvedPath.match(
    /\/(?:opt\/homebrew|usr\/local)\/opt\/([^/]+)\//,
  )
  if (optMatch) {
    return optMatch[1]
  }

  return defaultName
}

/**
 * Check if a mysqld binary is MariaDB
 */
async function isMysqldMariaDB(mysqldPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(mysqldPath, ['--version'])
    return stdout.toLowerCase().includes('mariadb')
  } catch {
    return false
  }
}

/**
 * Homebrew paths to check for MySQL installations
 */
const HOMEBREW_MYSQL_PATHS = [
  // ARM64 (Apple Silicon) - versioned
  '/opt/homebrew/opt/mysql@5.7/bin/mysqld',
  '/opt/homebrew/opt/mysql@8.0/bin/mysqld',
  '/opt/homebrew/opt/mysql@8.4/bin/mysqld',
  '/opt/homebrew/opt/mysql@9.0/bin/mysqld',
  // ARM64 - unversioned (latest)
  '/opt/homebrew/opt/mysql/bin/mysqld',
  '/opt/homebrew/opt/mariadb/bin/mysqld',
  // Intel - versioned
  '/usr/local/opt/mysql@5.7/bin/mysqld',
  '/usr/local/opt/mysql@8.0/bin/mysqld',
  '/usr/local/opt/mysql@8.4/bin/mysqld',
  '/usr/local/opt/mysql@9.0/bin/mysqld',
  // Intel - unversioned
  '/usr/local/opt/mysql/bin/mysqld',
  '/usr/local/opt/mariadb/bin/mysqld',
]

async function getInstalledMysqlEngines(): Promise<InstalledMysqlEngine[]> {
  const engines: InstalledMysqlEngine[] = []
  const seenFormulas = new Set<string>()
  const { platform } = platformService.getPlatformInfo()

  // On macOS, check all Homebrew paths
  if (platform === 'darwin') {
    for (const mysqldPath of HOMEBREW_MYSQL_PATHS) {
      if (existsSync(mysqldPath)) {
        const formulaName = extractHomebrewFormula(mysqldPath, 'mysql')

        // Skip if we've already found this formula
        if (seenFormulas.has(formulaName)) continue
        seenFormulas.add(formulaName)

        const version = await getMysqlVersion(mysqldPath)
        if (version) {
          const isMariaDB = await isMysqldMariaDB(mysqldPath)
          engines.push({
            engine: 'mysql',
            version,
            path: mysqldPath,
            source: 'system',
            isMariaDB,
            formulaName,
          })
        }
      }
    }
  }

  // Also check system PATH (for Linux or non-Homebrew installs)
  const pathMysqld = await getMysqldPath()
  if (pathMysqld) {
    const formulaName = extractHomebrewFormula(
      pathMysqld,
      pathMysqld.toLowerCase().includes('mariadb') ? 'mariadb' : 'mysql',
    )

    // Only add if not already found via Homebrew paths
    if (!seenFormulas.has(formulaName)) {
      const version = await getMysqlVersion(pathMysqld)
      if (version) {
        const isMariaDB = await isMysqldMariaDB(pathMysqld)
        engines.push({
          engine: 'mysql',
          version,
          path: pathMysqld,
          source: 'system',
          isMariaDB,
          formulaName,
        })
      }
    }
  }

  // Sort by version descending
  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

async function getInstalledSqliteEngine(): Promise<InstalledSqliteEngine | null> {
  try {
    // Use platform service for cross-platform binary detection
    const sqlitePath = await platformService.findToolPath('sqlite3')
    if (!sqlitePath) {
      return null
    }

    const { stdout: versionOutput } = await execFileAsync(sqlitePath, [
      '--version',
    ])
    // sqlite3 --version outputs: "3.43.2 2023-10-10 12:14:04 ..."
    const versionMatch = versionOutput.match(/^([\d.]+)/)
    const version = versionMatch ? versionMatch[1] : 'unknown'

    return {
      engine: 'sqlite',
      version,
      path: sqlitePath,
      source: 'system',
    }
  } catch {
    return null
  }
}

/**
 * Homebrew paths to check for MongoDB installations
 */
const HOMEBREW_MONGODB_PATHS = [
  // ARM64 (Apple Silicon) - versioned
  '/opt/homebrew/opt/mongodb-community@6.0/bin/mongod',
  '/opt/homebrew/opt/mongodb-community@7.0/bin/mongod',
  '/opt/homebrew/opt/mongodb-community@8.0/bin/mongod',
  // ARM64 - unversioned (latest)
  '/opt/homebrew/opt/mongodb-community/bin/mongod',
  // Intel - versioned
  '/usr/local/opt/mongodb-community@6.0/bin/mongod',
  '/usr/local/opt/mongodb-community@7.0/bin/mongod',
  '/usr/local/opt/mongodb-community@8.0/bin/mongod',
  // Intel - unversioned
  '/usr/local/opt/mongodb-community/bin/mongod',
]

async function getInstalledMongodbEngines(): Promise<InstalledMongodbEngine[]> {
  const engines: InstalledMongodbEngine[] = []
  const seenFormulas = new Set<string>()
  const { platform } = platformService.getPlatformInfo()

  // On macOS, check all Homebrew paths
  if (platform === 'darwin') {
    for (const mongodPath of HOMEBREW_MONGODB_PATHS) {
      if (existsSync(mongodPath)) {
        const formulaName = extractHomebrewFormula(mongodPath, 'mongodb-community')

        // Skip if we've already found this formula
        if (seenFormulas.has(formulaName)) continue
        seenFormulas.add(formulaName)

        const version = await getMongodVersion(mongodPath)
        if (version) {
          engines.push({
            engine: 'mongodb',
            version,
            path: mongodPath,
            source: 'system',
            formulaName,
          })
        }
      }
    }
  }

  // Also check system PATH (for Linux or non-Homebrew installs)
  const pathMongod = await getMongodPath()
  if (pathMongod) {
    const formulaName = extractHomebrewFormula(pathMongod, 'mongodb-community')

    // Only add if not already found via Homebrew paths
    if (!seenFormulas.has(formulaName)) {
      const version = await getMongodVersion(pathMongod)
      if (version) {
        engines.push({
          engine: 'mongodb',
          version,
          path: pathMongod,
          source: 'system',
          formulaName,
        })
      }
    }
  }

  // Sort by version descending
  engines.sort((a, b) => compareVersions(b.version, a.version))

  return engines
}

/**
 * Homebrew paths to check for Redis installations
 */
const HOMEBREW_REDIS_PATHS = [
  // ARM64 (Apple Silicon) - versioned
  '/opt/homebrew/opt/redis@6.2/bin/redis-server',
  '/opt/homebrew/opt/redis@7.0/bin/redis-server',
  '/opt/homebrew/opt/redis@7.2/bin/redis-server',
  '/opt/homebrew/opt/redis@8.0/bin/redis-server',
  '/opt/homebrew/opt/redis@8.2/bin/redis-server',
  // ARM64 - unversioned (latest)
  '/opt/homebrew/opt/redis/bin/redis-server',
  // Intel - versioned
  '/usr/local/opt/redis@6.2/bin/redis-server',
  '/usr/local/opt/redis@7.0/bin/redis-server',
  '/usr/local/opt/redis@7.2/bin/redis-server',
  '/usr/local/opt/redis@8.0/bin/redis-server',
  '/usr/local/opt/redis@8.2/bin/redis-server',
  // Intel - unversioned
  '/usr/local/opt/redis/bin/redis-server',
]

async function getInstalledRedisEngines(): Promise<InstalledRedisEngine[]> {
  const engines: InstalledRedisEngine[] = []
  const seenFormulas = new Set<string>()
  const { platform } = platformService.getPlatformInfo()

  // On macOS, check all Homebrew paths
  if (platform === 'darwin') {
    for (const redisPath of HOMEBREW_REDIS_PATHS) {
      if (existsSync(redisPath)) {
        const formulaName = extractHomebrewFormula(redisPath, 'redis')

        // Skip if we've already found this formula
        if (seenFormulas.has(formulaName)) continue
        seenFormulas.add(formulaName)

        const version = await getRedisVersion(redisPath)
        if (version) {
          engines.push({
            engine: 'redis',
            version,
            path: redisPath,
            source: 'system',
            formulaName,
          })
        }
      }
    }
  }

  // Also check system PATH (for Linux or non-Homebrew installs)
  const pathRedis = await getRedisServerPath()
  if (pathRedis) {
    const formulaName = extractHomebrewFormula(pathRedis, 'redis')

    // Only add if not already found via Homebrew paths
    if (!seenFormulas.has(formulaName)) {
      const version = await getRedisVersion(pathRedis)
      if (version) {
        engines.push({
          engine: 'redis',
          version,
          path: pathRedis,
          source: 'system',
          formulaName,
        })
      }
    }
  }

  // Sort by version descending
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

export async function getInstalledEngines(): Promise<InstalledEngine[]> {
  const engines: InstalledEngine[] = []

  const pgEngines = await getInstalledPostgresEngines()
  engines.push(...pgEngines)

  const mariadbEngines = await getInstalledMariadbEngines()
  engines.push(...mariadbEngines)

  const mysqlEngines = await getInstalledMysqlEngines()
  engines.push(...mysqlEngines)

  const sqliteEngine = await getInstalledSqliteEngine()
  if (sqliteEngine) {
    engines.push(sqliteEngine)
  }

  const mongodbEngines = await getInstalledMongodbEngines()
  engines.push(...mongodbEngines)

  const redisEngines = await getInstalledRedisEngines()
  engines.push(...redisEngines)

  return engines
}

// Export individual engine detection functions for use in other modules
export { getInstalledMysqlEngines, getInstalledMongodbEngines, getInstalledRedisEngines }
