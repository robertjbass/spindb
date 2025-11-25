import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { dirname } from 'path'
import { paths } from '@/config/paths'
import type {
  SpinDBConfig,
  BinaryConfig,
  BinaryTool,
  BinarySource,
} from '@/types'

const execAsync = promisify(exec)

const DEFAULT_CONFIG: SpinDBConfig = {
  binaries: {},
}

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
    } catch {
      // If config is corrupted, reset to default
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
    } catch {
      // Version detection failed, that's ok
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
   */
  async detectSystemBinary(tool: BinaryTool): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`which ${tool}`)
      const path = stdout.trim()
      if (path && existsSync(path)) {
        return path
      }
    } catch {
      // which failed, binary not found
    }

    // Check common locations
    const commonPaths = this.getCommonBinaryPaths(tool)
    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path
      }
    }

    return null
  }

  /**
   * Get common installation paths for PostgreSQL client tools
   */
  private getCommonBinaryPaths(tool: BinaryTool): string[] {
    const paths: string[] = []

    // Homebrew (macOS)
    paths.push(`/opt/homebrew/bin/${tool}`)
    paths.push(`/opt/homebrew/opt/libpq/bin/${tool}`)
    paths.push(`/usr/local/bin/${tool}`)
    paths.push(`/usr/local/opt/libpq/bin/${tool}`)

    // Postgres.app (macOS)
    paths.push(
      `/Applications/Postgres.app/Contents/Versions/latest/bin/${tool}`,
    )

    // Linux common paths
    paths.push(`/usr/bin/${tool}`)
    paths.push(`/usr/lib/postgresql/16/bin/${tool}`)
    paths.push(`/usr/lib/postgresql/15/bin/${tool}`)
    paths.push(`/usr/lib/postgresql/14/bin/${tool}`)

    return paths
  }

  /**
   * Detect all available client tools on the system
   */
  async detectAllTools(): Promise<Map<BinaryTool, string>> {
    const tools: BinaryTool[] = [
      'psql',
      'pg_dump',
      'pg_restore',
      'pg_basebackup',
    ]
    const found = new Map<BinaryTool, string>()

    for (const tool of tools) {
      const path = await this.detectSystemBinary(tool)
      if (path) {
        found.set(tool, path)
      }
    }

    return found
  }

  /**
   * Initialize config by detecting all available tools
   */
  async initialize(): Promise<{ found: BinaryTool[]; missing: BinaryTool[] }> {
    const tools: BinaryTool[] = [
      'psql',
      'pg_dump',
      'pg_restore',
      'pg_basebackup',
    ]
    const found: BinaryTool[] = []
    const missing: BinaryTool[] = []

    for (const tool of tools) {
      const path = await this.getBinaryPath(tool)
      if (path) {
        found.push(tool)
      } else {
        missing.push(tool)
      }
    }

    return { found, missing }
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
}

export const configManager = new ConfigManager()
