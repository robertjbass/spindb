import { existsSync } from 'fs'
import { readdir, lstat } from 'fs/promises'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { paths } from '../config/paths'
import { platformService } from '../core/platform-service'

const execFileAsync = promisify(execFile)

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
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('postgresql-')) continue

    // Split from end to handle versions with prerelease tags (e.g., 17.0.0-rc1)
    // Format: postgresql-{version}-{platform}-{arch}
    const rest = entry.name.slice('postgresql-'.length)
    const parts = rest.split('-')
    if (parts.length < 3) continue

    const arch = parts.pop()!
    const platform = parts.pop()!
    const dirVersion = parts.join('-')

    if (!dirVersion || !platform || !arch) continue

    const dirPath = join(binDir, entry.name)
    const actualVersion = (await getPostgresVersion(dirPath)) || dirVersion
    const sizeBytes = await calculateDirectorySize(dirPath)

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

    // Split from end to handle versions with prerelease tags
    // Format: mariadb-{version}-{platform}-{arch}
    const rest = entry.name.slice('mariadb-'.length)
    const parts = rest.split('-')
    if (parts.length < 3) continue

    const arch = parts.pop()!
    const platform = parts.pop()!
    const dirVersion = parts.join('-')

    if (!dirVersion || !platform || !arch) continue

    const dirPath = join(binDir, entry.name)
    const actualVersion = (await getMariadbVersion(dirPath)) || dirVersion
    const sizeBytes = await calculateDirectorySize(dirPath)

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

    // Split from end to handle versions with prerelease tags
    // Format: mysql-{version}-{platform}-{arch}
    const rest = entry.name.slice('mysql-'.length)
    const parts = rest.split('-')
    if (parts.length < 3) continue

    const arch = parts.pop()!
    const platform = parts.pop()!
    const dirVersion = parts.join('-')

    if (!dirVersion || !platform || !arch) continue

    const dirPath = join(binDir, entry.name)
    const actualVersion = (await getMysqlVersion(dirPath)) || dirVersion
    const sizeBytes = await calculateDirectorySize(dirPath)

    engines.push({
      engine: 'mysql',
      version: actualVersion,
      platform,
      arch,
      path: dirPath,
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
    const match = stdout.match(/^([\d.]+)/)
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

    // Split from end to handle versions with prerelease tags
    // Format: sqlite-{version}-{platform}-{arch}
    const rest = entry.name.slice('sqlite-'.length)
    const parts = rest.split('-')
    if (parts.length < 3) continue

    const arch = parts.pop()!
    const platform = parts.pop()!
    const dirVersion = parts.join('-')

    if (!dirVersion || !platform || !arch) continue

    const dirPath = join(binDir, entry.name)
    const actualVersion = (await getSqliteVersion(dirPath)) || dirVersion
    const sizeBytes = await calculateDirectorySize(dirPath)

    engines.push({
      engine: 'sqlite',
      version: actualVersion,
      platform,
      arch,
      path: dirPath,
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

    // Split from end to handle versions with prerelease tags
    // Format: mongodb-{version}-{platform}-{arch}
    const rest = entry.name.slice('mongodb-'.length)
    const parts = rest.split('-')
    if (parts.length < 3) continue

    const arch = parts.pop()!
    const platform = parts.pop()!
    const dirVersion = parts.join('-')

    if (!dirVersion || !platform || !arch) continue

    const dirPath = join(binDir, entry.name)
    const actualVersion = (await getMongodbVersion(dirPath)) || dirVersion
    const sizeBytes = await calculateDirectorySize(dirPath)

    engines.push({
      engine: 'mongodb',
      version: actualVersion,
      platform,
      arch,
      path: dirPath,
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

    // Split from end to handle versions with prerelease tags
    // Format: redis-{version}-{platform}-{arch}
    const rest = entry.name.slice('redis-'.length)
    const parts = rest.split('-')
    if (parts.length < 3) continue

    const arch = parts.pop()!
    const platform = parts.pop()!
    const dirVersion = parts.join('-')

    if (!dirVersion || !platform || !arch) continue

    const dirPath = join(binDir, entry.name)
    const actualVersion = (await getRedisVersion(dirPath)) || dirVersion
    const sizeBytes = await calculateDirectorySize(dirPath)

    engines.push({
      engine: 'redis',
      version: actualVersion,
      platform,
      arch,
      path: dirPath,
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

export async function getInstalledEngines(): Promise<InstalledEngine[]> {
  const engines: InstalledEngine[] = []

  const pgEngines = await getInstalledPostgresEngines()
  engines.push(...pgEngines)

  const mariadbEngines = await getInstalledMariadbEngines()
  engines.push(...mariadbEngines)

  const mysqlEngines = await getInstalledMysqlEngines()
  engines.push(...mysqlEngines)

  const sqliteEngines = await getInstalledSqliteEngines()
  engines.push(...sqliteEngines)

  const mongodbEngines = await getInstalledMongodbEngines()
  engines.push(...mongodbEngines)

  const redisEngines = await getInstalledRedisEngines()
  engines.push(...redisEngines)

  return engines
}

// Export individual engine detection functions for use in other modules
export {
  getInstalledMysqlEngines,
  getInstalledSqliteEngines,
  getInstalledMongodbEngines,
  getInstalledRedisEngines,
}
