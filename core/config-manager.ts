import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { dirname } from 'path'
import { paths } from '../config/paths'
import { logDebug, logWarning } from './error-handler'
import { platformService } from './platform-service'
import type {
  SpinDBConfig,
  BinaryConfig,
  BinaryTool,
  BinarySource,
  SQLiteEngineRegistry,
} from '../types'

const execAsync = promisify(exec)

const DEFAULT_CONFIG: SpinDBConfig = {
  binaries: {},
}

// Cache staleness threshold (7 days in milliseconds)
const CACHE_STALENESS_MS = 7 * 24 * 60 * 60 * 1000

// All tools organized by category
const POSTGRESQL_TOOLS: BinaryTool[] = [
  'psql',
  'pg_dump',
  'pg_restore',
  'pg_basebackup',
]

const MYSQL_TOOLS: BinaryTool[] = ['mysql', 'mysqldump', 'mysqladmin', 'mysqld']

const ENHANCED_SHELLS: BinaryTool[] = ['pgcli', 'mycli', 'usql']

const ALL_TOOLS: BinaryTool[] = [
  ...POSTGRESQL_TOOLS,
  ...MYSQL_TOOLS,
  ...ENHANCED_SHELLS,
]

export class ConfigManager {
  private config: SpinDBConfig | null = null

  /**
   * Load config from disk, creating default if it doesn't exist
   */
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

  /**
   * Save config to disk
   */
  async save(): Promise<void> {
    const configPath = paths.config

    // Ensure directory exists
    await mkdir(dirname(configPath), { recursive: true })

    if (this.config) {
      this.config.updatedAt = new Date().toISOString()
      await writeFile(configPath, JSON.stringify(this.config, null, 2))
    }
  }

  /**
   * Get the path for a binary tool, detecting from system if not configured
   */
  async getBinaryPath(tool: BinaryTool): Promise<string | null> {
    const config = await this.load()

    // Check if we have a configured path
    const binaryConfig = config.binaries[tool]
    if (binaryConfig?.path) {
      // Verify it still exists
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
   * Set the path for a binary tool
   */
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

  /**
   * Get configuration for a specific binary
   */
  async getBinaryConfig(tool: BinaryTool): Promise<BinaryConfig | null> {
    const config = await this.load()
    return config.binaries[tool] || null
  }

  /**
   * Detect a binary on the system PATH
   * Uses platformService for cross-platform detection (handles which/where and .exe extension)
   */
  async detectSystemBinary(tool: BinaryTool): Promise<string | null> {
    // Use platformService which handles cross-platform differences
    // (which vs where, .exe extension, platform-specific search paths)
    return platformService.findToolPath(tool)
  }

  /**
   * Detect all available client tools on the system
   */
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

  /**
   * Initialize config by detecting all available tools
   * Groups results by category for better display
   */
  async initialize(): Promise<{
    found: BinaryTool[]
    missing: BinaryTool[]
    postgresql: { found: BinaryTool[]; missing: BinaryTool[] }
    mysql: { found: BinaryTool[]; missing: BinaryTool[] }
    enhanced: { found: BinaryTool[]; missing: BinaryTool[] }
  }> {
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
      enhanced: {
        found: found.filter((t) => ENHANCED_SHELLS.includes(t)),
        missing: missing.filter((t) => ENHANCED_SHELLS.includes(t)),
      },
    }
  }

  /**
   * Check if the config cache is stale (older than 7 days)
   */
  async isStale(): Promise<boolean> {
    const config = await this.load()
    if (!config.updatedAt) {
      return true
    }

    const updatedAt = new Date(config.updatedAt).getTime()
    const now = Date.now()
    return now - updatedAt > CACHE_STALENESS_MS
  }

  /**
   * Refresh all tool paths if cache is stale
   * Returns true if refresh was performed
   */
  async refreshIfStale(): Promise<boolean> {
    if (await this.isStale()) {
      await this.refreshAllBinaries()
      return true
    }
    return false
  }

  /**
   * Force refresh all binary paths
   * Re-detects all tools and updates versions
   */
  async refreshAllBinaries(): Promise<void> {
    await this.clearAllBinaries()
    await this.initialize()
  }

  /**
   * Get the full config
   */
  async getConfig(): Promise<SpinDBConfig> {
    return this.load()
  }

  /**
   * Clear a binary configuration
   */
  async clearBinaryPath(tool: BinaryTool): Promise<void> {
    const config = await this.load()
    delete config.binaries[tool]
    await this.save()
  }

  /**
   * Clear all binary configurations (useful for re-detection)
   */
  async clearAllBinaries(): Promise<void> {
    const config = await this.load()
    config.binaries = {}
    await this.save()
  }

  // ============================================================
  // SQLite Registry Methods
  // ============================================================

  /**
   * Get the SQLite registry from config
   * Returns empty registry if none exists
   */
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

  /**
   * Save the SQLite registry to config
   */
  async saveSqliteRegistry(registry: SQLiteEngineRegistry): Promise<void> {
    const config = await this.load()
    if (!config.registry) {
      config.registry = {}
    }
    config.registry.sqlite = registry
    await this.save()
  }
}

export const configManager = new ConfigManager()

// Export tool categories for use in commands
export { POSTGRESQL_TOOLS, MYSQL_TOOLS, ENHANCED_SHELLS, ALL_TOOLS }
