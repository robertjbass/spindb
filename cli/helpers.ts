import { existsSync } from 'fs'
import { readdir, lstat } from 'fs/promises'
import { join } from 'path'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { paths } from '../config/paths'
import {
  getMysqldPath,
  getMysqlVersion,
  isMariaDB,
} from '../engines/mysql/binary-detection'

const execAsync = promisify(exec)
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

export type InstalledMysqlEngine = {
  engine: 'mysql'
  version: string
  path: string
  source: 'system'
  isMariaDB: boolean
}

export type InstalledSqliteEngine = {
  engine: 'sqlite'
  version: string
  path: string
  source: 'system'
}

export type InstalledEngine =
  | InstalledPostgresEngine
  | InstalledMysqlEngine
  | InstalledSqliteEngine

async function getPostgresVersion(binPath: string): Promise<string | null> {
  const postgresPath = join(binPath, 'bin', 'postgres')
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

async function getInstalledMysqlEngine(): Promise<InstalledMysqlEngine | null> {
  const mysqldPath = await getMysqldPath()
  if (!mysqldPath) {
    return null
  }

  const version = await getMysqlVersion(mysqldPath)
  if (!version) {
    return null
  }

  const mariadb = await isMariaDB()

  return {
    engine: 'mysql',
    version,
    path: mysqldPath,
    source: 'system',
    isMariaDB: mariadb,
  }
}

async function getInstalledSqliteEngine(): Promise<InstalledSqliteEngine | null> {
  try {
    // TODO: Use 'where sqlite3' on Windows when adding Windows support
    const { stdout: whichOutput } = await execAsync('which sqlite3')
    const sqlitePath = whichOutput.trim()
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

  const mysqlEngine = await getInstalledMysqlEngine()
  if (mysqlEngine) {
    engines.push(mysqlEngine)
  }

  const sqliteEngine = await getInstalledSqliteEngine()
  if (sqliteEngine) {
    engines.push(sqliteEngine)
  }

  return engines
}
