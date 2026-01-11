import { existsSync } from 'fs'
import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { join, dirname } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { paths } from '../config/paths'
import { logDebug, logWarning } from './error-handler'
import { platformService } from './platform-service'
import {
  Engine,
  type SpinDBConfig,
  type BinaryConfig,
  type BinaryTool,
  type BinarySource,
  type SQLiteEngineRegistry,
} from '../types'

const execAsync = promisify(exec)

const DEFAULT_CONFIG: SpinDBConfig = {
  binaries: {},
}

// Cache staleness threshold (7 days in milliseconds)
const CACHE_STALENESS_MS = 7 * 24 * 60 * 60 * 1000

// All tools organized by engine and category
const POSTGRESQL_SERVER_TOOLS: BinaryTool[] = ['postgres', 'pg_ctl', 'initdb']
const POSTGRESQL_CLIENT_TOOLS: BinaryTool[] = [
  'psql',
  'pg_dump',
  'pg_restore',
  'pg_basebackup',
]
const POSTGRESQL_TOOLS: BinaryTool[] = [
  ...POSTGRESQL_SERVER_TOOLS,
  ...POSTGRESQL_CLIENT_TOOLS,
]

const MYSQL_SERVER_TOOLS: BinaryTool[] = ['mysqld', 'mysqladmin']
const MYSQL_CLIENT_TOOLS: BinaryTool[] = ['mysql', 'mysqldump']
const MYSQL_TOOLS: BinaryTool[] = [...MYSQL_SERVER_TOOLS, ...MYSQL_CLIENT_TOOLS]

const MARIADB_SERVER_TOOLS: BinaryTool[] = ['mariadbd', 'mariadb-admin']
const MARIADB_CLIENT_TOOLS: BinaryTool[] = ['mariadb', 'mariadb-dump']
const MARIADB_TOOLS: BinaryTool[] = [
  ...MARIADB_SERVER_TOOLS,
  ...MARIADB_CLIENT_TOOLS,
]

const MONGODB_TOOLS: BinaryTool[] = [
  'mongod',
  'mongosh',
  'mongodump',
  'mongorestore',
]

const REDIS_TOOLS: BinaryTool[] = ['redis-server', 'redis-cli']

const SQLITE_TOOLS: BinaryTool[] = ['sqlite3']

const ENHANCED_SHELLS: BinaryTool[] = [
  'pgcli',
  'mycli',
  'litecli',
  'iredis',
  'usql',
]

const ALL_TOOLS: BinaryTool[] = [
  ...POSTGRESQL_TOOLS,
  ...MYSQL_TOOLS,
  ...MARIADB_TOOLS,
  ...MONGODB_TOOLS,
  ...REDIS_TOOLS,
  ...SQLITE_TOOLS,
  ...ENHANCED_SHELLS,
]

// Map engine names to their binary tools (for scanning ~/.spindb/bin/)
// SQLite is excluded because it uses system binaries, not hostdb downloads
const ENGINE_BINARY_MAP: Partial<Record<Engine, BinaryTool[]>> = {
  [Engine.PostgreSQL]: POSTGRESQL_TOOLS,
  [Engine.MySQL]: MYSQL_TOOLS,
  [Engine.MariaDB]: MARIADB_TOOLS,
  [Engine.MongoDB]: MONGODB_TOOLS,
  [Engine.Redis]: REDIS_TOOLS,
}

export class ConfigManager {
  private config: SpinDBConfig | null = null

  async load(): Promise<SpinDBConfig> {
    if (this.config) {
      return this.config
    }

    const configPath = paths.config

    if (!existsSync(configPath)) {
      // Create default config
      this.config = { ...DEFAULT_CONFIG }
      await this.save()
      return this.config
    }

    try {
      const content = await readFile(configPath, 'utf8')
      this.config = JSON.parse(content) as SpinDBConfig
      return this.config
    } catch (error) {
      // If config is corrupted, reset to default
      logWarning('Config file corrupted, resetting to default', {
        configPath,
        error: error instanceof Error ? error.message : String(error),
      })
      this.config = { ...DEFAULT_CONFIG }
      await this.save()
      return this.config
    }
  }

  async save(): Promise<void> {
    const configPath = paths.config
    await mkdir(dirname(configPath), { recursive: true })

    if (this.config) {
      this.config.updatedAt = new Date().toISOString()
      await writeFile(configPath, JSON.stringify(this.config, null, 2))
    }
  }

  async getBinaryPath(tool: BinaryTool): Promise<string | null> {
    const config = await this.load()

    const binaryConfig = config.binaries[tool]
    if (binaryConfig?.path) {
      if (existsSync(binaryConfig.path)) {
        return binaryConfig.path
      }
      // Path no longer valid, clear it
      delete config.binaries[tool]
      await this.save()
    }

    // Try to detect from system
    const systemPath = await this.detectSystemBinary(tool)
    if (systemPath) {
      await this.setBinaryPath(tool, systemPath, 'system')
      return systemPath
    }

    return null
  }

  /**
   * Get binary path with version validation
   *
   * Unlike getBinaryPath(), this also verifies the cached version matches
   * the actual binary version. Use this for version-sensitive operations
   * like dump/restore where using the wrong version can cause failures.
   */
  async getBinaryPathWithVersionCheck(tool: BinaryTool): Promise<{
    path: string | null
    versionMismatch: boolean
    cachedVersion?: string
    actualVersion?: string
  }> {
    const config = await this.load()
    const binaryConfig = config.binaries[tool]

    if (!binaryConfig?.path) {
      // No cached path, try to detect
      const systemPath = await this.detectSystemBinary(tool)
      if (systemPath) {
        await this.setBinaryPath(tool, systemPath, 'system')
        return { path: systemPath, versionMismatch: false }
      }
      return { path: null, versionMismatch: false }
    }

    // Check if file exists
    if (!existsSync(binaryConfig.path)) {
      delete config.binaries[tool]
      await this.save()
      return { path: null, versionMismatch: false }
    }

    // Validate version matches cached version
    if (binaryConfig.version) {
      try {
        const { stdout } = await execAsync(`"${binaryConfig.path}" --version`)
        const match = stdout.match(/(\d+\.\d+)/)
        const actualVersion = match ? match[1] : undefined

        if (actualVersion && actualVersion !== binaryConfig.version) {
          logWarning('Binary version mismatch detected', {
            tool,
            path: binaryConfig.path,
            cachedVersion: binaryConfig.version,
            actualVersion,
          })

          const cachedVersion = binaryConfig.version

          // Update cache with actual version
          binaryConfig.version = actualVersion
          await this.save()

          return {
            path: binaryConfig.path,
            versionMismatch: true,
            cachedVersion,
            actualVersion,
          }
        }
      } catch (error) {
        logDebug('Version check failed', {
          tool,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { path: binaryConfig.path, versionMismatch: false }
  }

  /**
   * Force refresh a specific binary's path and version
   *
   * Clears the existing cache entry and re-detects from system.
   * Use after package manager operations that may have changed binary versions.
   */
  async refreshBinaryWithVersion(
    tool: BinaryTool,
  ): Promise<BinaryConfig | null> {
    // Clear existing cache for this tool
    await this.clearBinaryPath(tool)

    // Re-detect from system
    const systemPath = await this.detectSystemBinary(tool)
    if (systemPath) {
      await this.setBinaryPath(tool, systemPath, 'system')
      const config = await this.load()
      return config.binaries[tool] || null
    }

    return null
  }

  async setBinaryPath(
    tool: BinaryTool,
    path: string,
    source: BinarySource,
  ): Promise<void> {
    const config = await this.load()

    // Get version if possible
    let version: string | undefined
    try {
      const { stdout } = await execAsync(`"${path}" --version`)
      const match = stdout.match(/\d+\.\d+/)
      if (match) {
        version = match[0]
      }
    } catch (error) {
      logDebug('Version detection failed', {
        tool,
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    config.binaries[tool] = {
      tool,
      path,
      source,
      version,
    }

    await this.save()
  }

  async getBinaryConfig(tool: BinaryTool): Promise<BinaryConfig | null> {
    const config = await this.load()
    return config.binaries[tool] || null
  }

  async detectSystemBinary(tool: BinaryTool): Promise<string | null> {
    // Use platformService which handles cross-platform differences
    // (which vs where, .exe extension, platform-specific search paths)
    return platformService.findToolPath(tool)
  }

  async detectAllTools(): Promise<Map<BinaryTool, string>> {
    const found = new Map<BinaryTool, string>()

    for (const tool of ALL_TOOLS) {
      const path = await this.detectSystemBinary(tool)
      if (path) {
        found.set(tool, path)
      }
    }

    return found
  }

  async initialize(): Promise<{
    found: BinaryTool[]
    missing: BinaryTool[]
    postgresql: { found: BinaryTool[]; missing: BinaryTool[] }
    mysql: { found: BinaryTool[]; missing: BinaryTool[] }
    mariadb: { found: BinaryTool[]; missing: BinaryTool[] }
    mongodb: { found: BinaryTool[]; missing: BinaryTool[] }
    redis: { found: BinaryTool[]; missing: BinaryTool[] }
    enhanced: { found: BinaryTool[]; missing: BinaryTool[] }
  }> {
    // First, scan ~/.spindb/bin/ for downloaded (bundled) binaries
    // This ensures bundled binaries are registered before system detection
    await this.scanInstalledBinaries()

    const found: BinaryTool[] = []
    const missing: BinaryTool[] = []

    for (const tool of ALL_TOOLS) {
      const path = await this.getBinaryPath(tool)
      if (path) {
        found.push(tool)
      } else {
        missing.push(tool)
      }
    }

    return {
      found,
      missing,
      postgresql: {
        found: found.filter((t) => POSTGRESQL_TOOLS.includes(t)),
        missing: missing.filter((t) => POSTGRESQL_TOOLS.includes(t)),
      },
      mysql: {
        found: found.filter((t) => MYSQL_TOOLS.includes(t)),
        missing: missing.filter((t) => MYSQL_TOOLS.includes(t)),
      },
      mariadb: {
        found: found.filter((t) => MARIADB_TOOLS.includes(t)),
        missing: missing.filter((t) => MARIADB_TOOLS.includes(t)),
      },
      mongodb: {
        found: found.filter((t) => MONGODB_TOOLS.includes(t)),
        missing: missing.filter((t) => MONGODB_TOOLS.includes(t)),
      },
      redis: {
        found: found.filter((t) => REDIS_TOOLS.includes(t)),
        missing: missing.filter((t) => REDIS_TOOLS.includes(t)),
      },
      enhanced: {
        found: found.filter((t) => ENHANCED_SHELLS.includes(t)),
        missing: missing.filter((t) => ENHANCED_SHELLS.includes(t)),
      },
    }
  }

  async isStale(): Promise<boolean> {
    const config = await this.load()
    if (!config.updatedAt) {
      return true
    }

    const updatedAt = new Date(config.updatedAt).getTime()
    const now = Date.now()
    return now - updatedAt > CACHE_STALENESS_MS
  }

  async refreshIfStale(): Promise<boolean> {
    if (await this.isStale()) {
      await this.refreshAllBinaries()
      return true
    }
    return false
  }

  async refreshAllBinaries(): Promise<void> {
    await this.clearAllBinaries()
    await this.initialize()
  }

  async getConfig(): Promise<SpinDBConfig> {
    return this.load()
  }

  async clearBinaryPath(tool: BinaryTool): Promise<void> {
    const config = await this.load()
    delete config.binaries[tool]
    await this.save()
  }

  async clearAllBinaries(): Promise<void> {
    const config = await this.load()
    config.binaries = {}
    await this.save()
  }

  // SQLite Registry Methods

  async getSqliteRegistry(): Promise<SQLiteEngineRegistry> {
    const config = await this.load()
    return (
      config.registry?.sqlite ?? {
        version: 1,
        entries: [],
        ignoreFolders: {},
      }
    )
  }

  async saveSqliteRegistry(registry: SQLiteEngineRegistry): Promise<void> {
    const config = await this.load()
    if (!config.registry) {
      config.registry = {}
    }
    config.registry.sqlite = registry
    await this.save()
  }

  /**
   * Scan ~/.spindb/bin/ for installed engine binaries and register any missing ones.
   * This ensures that binaries downloaded previously are available in the config
   * even if the config was cleared or is on a new machine with the same home dir.
   *
   * Directory format: {engine}-{version}-{platform}-{arch}
   * Example: postgresql-18.1.0-darwin-arm64
   */
  async scanInstalledBinaries(): Promise<{
    scanned: number
    registered: number
    engines: string[]
  }> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return { scanned: 0, registered: 0, engines: [] }
    }

    const config = await this.load()
    let scanned = 0
    let registered = 0
    const enginesFound: string[] = []

    try {
      const entries = await readdir(binDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        // Parse directory name: {engine}-{version}-{platform}-{arch}
        // e.g., postgresql-18.1.0-darwin-arm64, mysql-9.1.0-darwin-arm64
        const match = entry.name.match(/^(\w+)-(\d+\.\d+\.\d+)-(\w+)-(\w+)$/)
        if (!match) continue

        const [, engineName] = match
        const engine = engineName as Engine
        const engineTools = ENGINE_BINARY_MAP[engine]
        if (!engineTools) continue

        scanned++
        if (!enginesFound.includes(engine)) {
          enginesFound.push(engine)
        }

        const engineBinPath = join(binDir, entry.name, 'bin')
        if (!existsSync(engineBinPath)) continue

        const ext = platformService.getExecutableExtension()

        for (const tool of engineTools) {
          // Skip if already registered as bundled
          const existing = config.binaries[tool]
          if (existing?.source === 'bundled' && existsSync(existing.path)) {
            continue
          }

          const toolPath = join(engineBinPath, `${tool}${ext}`)
          if (existsSync(toolPath)) {
            await this.setBinaryPath(tool, toolPath, 'bundled')
            registered++
            logDebug(`Registered binary from scan: ${tool}`, { path: toolPath })
          }
        }
      }
    } catch (error) {
      logWarning('Failed to scan installed binaries', {
        binDir,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return { scanned, registered, engines: enginesFound }
  }
}

export const configManager = new ConfigManager()

// Export tool categories for use in commands
export {
  POSTGRESQL_TOOLS,
  POSTGRESQL_SERVER_TOOLS,
  POSTGRESQL_CLIENT_TOOLS,
  MYSQL_TOOLS,
  MYSQL_SERVER_TOOLS,
  MYSQL_CLIENT_TOOLS,
  MARIADB_TOOLS,
  MARIADB_SERVER_TOOLS,
  MARIADB_CLIENT_TOOLS,
  MONGODB_TOOLS,
  REDIS_TOOLS,
  SQLITE_TOOLS,
  ENHANCED_SHELLS,
  ALL_TOOLS,
  ENGINE_BINARY_MAP,
}
