import { existsSync } from 'fs'
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  cp,
  unlink,
  rename as fsRename,
} from 'fs/promises'
import { paths } from '../config/paths'
import { processManager } from './process-manager'
import { portManager } from './port-manager'
import { isWindows } from './platform-service'
import { logDebug } from './error-handler'
import { getEngineDefaults, getSupportedEngines } from '../config/defaults'
import { getEngine } from '../engines'
import { sqliteRegistry } from '../engines/sqlite/registry'
import { duckdbRegistry } from '../engines/duckdb/registry'
import type { ContainerConfig } from '../types'
import { Engine, isFileBasedEngine } from '../types'

export type CreateOptions = {
  engine: Engine
  version: string
  port: number
  database: string
  /** Path to the engine binary (for system-installed engines like MySQL, MongoDB, Redis) */
  binaryPath?: string
}

export type DeleteOptions = {
  force?: boolean
}

export class ContainerManager {
  async create(name: string, options: CreateOptions): Promise<ContainerConfig> {
    const { engine, version, port, database, binaryPath } = options

    // Validate container name
    if (!this.isValidName(name)) {
      throw new Error(
        'Container name must be alphanumeric with hyphens/underscores only',
      )
    }

    // Check if container already exists (for this engine)
    if (await this.exists(name, { engine })) {
      throw new Error(`Container "${name}" already exists for engine ${engine}`)
    }

    // Create container directory (engine-scoped)
    const containerPath = paths.getContainerPath(name, { engine })
    const dataPath = paths.getContainerDataPath(name, { engine })

    await mkdir(containerPath, { recursive: true })
    await mkdir(dataPath, { recursive: true })

    // Create container config
    const config: ContainerConfig = {
      name,
      engine,
      version,
      port,
      database,
      databases: [database],
      created: new Date().toISOString(),
      status: 'created',
      // Store binary path for system-installed engines (MySQL, MongoDB, Redis)
      // This ensures version consistency when starting the container
      ...(binaryPath && { binaryPath }),
    }

    await this.saveConfig(name, { engine }, config)

    return config
  }

  // If engine is not provided, searches all engine directories.
  // Automatically migrates old schemas to include databases array.
  async getConfig(
    name: string,
    options?: { engine?: string },
  ): Promise<ContainerConfig | null> {
    const { engine } = options || {}

    if (engine) {
      // SQLite uses registry instead of filesystem
      if (engine === Engine.SQLite) {
        return this.getSqliteConfig(name)
      }

      // Look in specific engine directory
      const configPath = paths.getContainerConfigPath(name, { engine })
      if (!existsSync(configPath)) {
        return null
      }
      const content = await readFile(configPath, 'utf8')
      const config = JSON.parse(content) as ContainerConfig
      return this.migrateConfig(config)
    }

    // Search SQLite registry first
    const sqliteConfig = await this.getSqliteConfig(name)
    if (sqliteConfig) {
      return sqliteConfig
    }

    // Search DuckDB registry
    const duckdbConfig = await this.getDuckDBConfig(name)
    if (duckdbConfig) {
      return duckdbConfig
    }

    // Search all engine directories (excluding file-based engines which use registries)
    const engines = getSupportedEngines().filter(
      (e) => e !== 'sqlite' && e !== 'duckdb',
    )
    for (const eng of engines) {
      const configPath = paths.getContainerConfigPath(name, { engine: eng })
      if (existsSync(configPath)) {
        const content = await readFile(configPath, 'utf8')
        const config = JSON.parse(content) as ContainerConfig
        return this.migrateConfig(config)
      }
    }

    return null
  }

  private async getSqliteConfig(name: string): Promise<ContainerConfig | null> {
    const entry = await sqliteRegistry.get(name)
    if (!entry) {
      return null
    }

    // Convert registry entry to ContainerConfig format
    const fileExists = existsSync(entry.filePath)
    return {
      name: entry.name,
      engine: Engine.SQLite,
      version: '3',
      port: 0,
      database: entry.filePath, // For SQLite, database field stores file path
      databases: [entry.filePath],
      created: entry.created,
      status: fileExists ? 'running' : 'stopped', // "running" = file exists
    }
  }

  private async getDuckDBConfig(name: string): Promise<ContainerConfig | null> {
    const entry = await duckdbRegistry.get(name)
    if (!entry) {
      return null
    }

    // Convert registry entry to ContainerConfig format
    const fileExists = existsSync(entry.filePath)
    return {
      name: entry.name,
      engine: Engine.DuckDB,
      version: '1',
      port: 0,
      database: entry.filePath, // For DuckDB, database field stores file path
      databases: [entry.filePath],
      created: entry.created,
      status: fileExists ? 'running' : 'stopped', // "running" = file exists
    }
  }

  // Migrates old container configs to include databases array.
  private async migrateConfig(
    config: ContainerConfig,
  ): Promise<ContainerConfig> {
    let needsSave = false

    // If databases array is missing, create it with the primary database
    if (!config.databases) {
      config.databases = [config.database]
      needsSave = true
    }

    // Ensure primary database is in the array
    if (!config.databases.includes(config.database)) {
      config.databases = [config.database, ...config.databases]
      needsSave = true
    }

    // Save if we made changes
    if (needsSave) {
      await this.saveConfig(config.name, { engine: config.engine }, config)
    }

    return config
  }

  async saveConfig(
    name: string,
    options: { engine: string },
    config: ContainerConfig,
  ): Promise<void> {
    const { engine } = options
    const configPath = paths.getContainerConfigPath(name, { engine })
    await writeFile(configPath, JSON.stringify(config, null, 2))
  }

  async updateConfig(
    name: string,
    updates: Partial<ContainerConfig>,
  ): Promise<ContainerConfig> {
    const config = await this.getConfig(name)
    if (!config) {
      throw new Error(`Container "${name}" not found`)
    }

    const updatedConfig = { ...config, ...updates }
    await this.saveConfig(name, { engine: config.engine }, updatedConfig)
    return updatedConfig
  }

  async exists(name: string, options?: { engine?: string }): Promise<boolean> {
    const { engine } = options || {}

    if (engine) {
      // SQLite uses registry
      if (engine === Engine.SQLite) {
        return sqliteRegistry.exists(name)
      }
      const configPath = paths.getContainerConfigPath(name, { engine })
      return existsSync(configPath)
    }

    // Check SQLite registry first
    if (await sqliteRegistry.exists(name)) {
      return true
    }

    // Check DuckDB registry
    if (await duckdbRegistry.exists(name)) {
      return true
    }

    // Check all engine directories (excluding file-based engines)
    const engines = getSupportedEngines().filter(
      (e) => e !== 'sqlite' && e !== 'duckdb',
    )
    for (const eng of engines) {
      const configPath = paths.getContainerConfigPath(name, { engine: eng })
      if (existsSync(configPath)) {
        return true
      }
    }

    return false
  }

  async list(): Promise<ContainerConfig[]> {
    const containers: ContainerConfig[] = []

    // List SQLite containers from registry
    const sqliteEntries = await sqliteRegistry.list()
    for (const entry of sqliteEntries) {
      const fileExists = existsSync(entry.filePath)
      containers.push({
        name: entry.name,
        engine: Engine.SQLite,
        version: '3',
        port: 0,
        database: entry.filePath,
        databases: [entry.filePath],
        created: entry.created,
        status: fileExists ? 'running' : 'stopped', // "running" = file exists
      })
    }

    // List DuckDB containers from registry
    const duckdbEntries = await duckdbRegistry.list()
    for (const entry of duckdbEntries) {
      const fileExists = existsSync(entry.filePath)
      containers.push({
        name: entry.name,
        engine: Engine.DuckDB,
        version: '1',
        port: 0,
        database: entry.filePath,
        databases: [entry.filePath],
        created: entry.created,
        status: fileExists ? 'running' : 'stopped', // "running" = file exists
      })
    }

    // List server-based containers (PostgreSQL, MySQL, etc.)
    const containersDir = paths.containers
    if (!existsSync(containersDir)) {
      return containers
    }

    const engines = getSupportedEngines().filter(
      (e) => e !== 'sqlite' && e !== 'duckdb',
    )

    // Collect all container check promises for parallel execution
    const containerChecks: Promise<ContainerConfig | null>[] = []

    for (const engine of engines) {
      const engineDir = paths.getEngineContainersPath(engine)
      if (!existsSync(engineDir)) {
        continue
      }

      const entries = await readdir(engineDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Push async check as promise (don't await yet)
          containerChecks.push(
            (async () => {
              const config = await this.getConfig(entry.name, { engine })
              if (!config) return null
              const running = await processManager.isRunning(entry.name, {
                engine,
              })
              return { ...config, status: running ? 'running' : 'stopped' }
            })(),
          )
        }
      }
    }

    // Execute all container checks in parallel
    const results = await Promise.all(containerChecks)
    containers.push(...results.filter((c): c is ContainerConfig => c !== null))

    return containers
  }

  async delete(name: string, options: DeleteOptions = {}): Promise<void> {
    const { force = false } = options

    // Get container config to find engine
    const config = await this.getConfig(name)
    if (!config) {
      throw new Error(`Container "${name}" not found`)
    }

    const { engine } = config

    // SQLite: delete file, remove from registry, and clean up container directory
    if (engine === Engine.SQLite) {
      const entry = await sqliteRegistry.get(name)
      if (entry && existsSync(entry.filePath)) {
        await unlink(entry.filePath)
      }
      await sqliteRegistry.remove(name)

      // Also remove the container directory (created by containerManager.create)
      const containerPath = paths.getContainerPath(name, { engine })
      if (existsSync(containerPath)) {
        await rm(containerPath, { recursive: true, force: true })
      }
      return
    }

    // DuckDB: delete file, remove from registry, and clean up container directory
    if (engine === Engine.DuckDB) {
      const entry = await duckdbRegistry.get(name)
      if (entry && existsSync(entry.filePath)) {
        await unlink(entry.filePath)
      }
      await duckdbRegistry.remove(name)

      // Also remove the container directory (created by containerManager.create)
      const containerPath = paths.getContainerPath(name, { engine })
      if (existsSync(containerPath)) {
        await rm(containerPath, { recursive: true, force: true })
      }
      return
    }

    // Server databases: check if running first
    const running = await processManager.isRunning(name, { engine })
    if (running && !force) {
      throw new Error(
        `Container "${name}" is running. Stop it first or use --force`,
      )
    }

    const containerPath = paths.getContainerPath(name, { engine })
    await this.safeRemoveDirectory(containerPath)
  }

  // Removes a directory with retry logic for Windows EBUSY errors.
  // Windows may hold file handles after process termination.
  // Windows can hold file locks for 120+ seconds due to:
  // - Antivirus software scanning
  // - Windows Search indexer
  // - Memory-mapped files (SurrealDB's SurrealKV, QuestDB's columnar storage)
  // - Java JVM file handle cleanup (QuestDB)
  private async safeRemoveDirectory(dirPath: string): Promise<void> {
    const maxRetries = isWindows() ? 90 : 1 // 90 retries × 2s = 180 seconds max
    const retryDelay = 2000 // 2 seconds between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await rm(dirPath, { recursive: true, force: true })
        return // Success
      } catch (error) {
        const e = error as NodeJS.ErrnoException
        if (e.code === 'EBUSY' && attempt < maxRetries) {
          logDebug(
            `EBUSY on rmdir attempt ${attempt}/${maxRetries}, retrying in ${retryDelay}ms...`,
          )
          await new Promise((resolve) => setTimeout(resolve, retryDelay))
        } else {
          throw error
        }
      }
    }
  }

  async clone(
    sourceName: string,
    targetName: string,
  ): Promise<ContainerConfig> {
    // Validate target name
    if (!this.isValidName(targetName)) {
      throw new Error(
        'Container name must be alphanumeric with hyphens/underscores only',
      )
    }

    // Get source config
    const sourceConfig = await this.getConfig(sourceName)
    if (!sourceConfig) {
      throw new Error(`Source container "${sourceName}" not found`)
    }

    const { engine } = sourceConfig

    // Check target doesn't exist (for this engine)
    if (await this.exists(targetName, { engine })) {
      throw new Error(`Target container "${targetName}" already exists`)
    }

    // Check source is not running
    const running = await processManager.isRunning(sourceName, { engine })
    if (running) {
      throw new Error(
        `Source container "${sourceName}" is running. Stop it first`,
      )
    }

    // Copy container directory
    const sourcePath = paths.getContainerPath(sourceName, { engine })
    const targetPath = paths.getContainerPath(targetName, { engine })

    await cp(sourcePath, targetPath, { recursive: true })

    // If anything fails after copy, clean up the target directory
    try {
      // Update target config
      const config = await this.getConfig(targetName, { engine })
      if (!config) {
        throw new Error('Failed to read cloned container config')
      }

      config.name = targetName
      config.created = new Date().toISOString()
      config.clonedFrom = sourceName

      // Assign new port (excluding ports already used by other containers)
      const engineDefaults = getEngineDefaults(engine)
      const { port } = await portManager.findAvailablePortExcludingContainers({
        portRange: engineDefaults.portRange,
      })
      config.port = port

      await this.saveConfig(targetName, { engine }, config)

      // ClickHouse stores absolute paths in config.xml - regenerate with new paths
      if (engine === Engine.ClickHouse) {
        const clickhouseEngine = getEngine(Engine.ClickHouse)
        if ('regenerateConfig' in clickhouseEngine) {
          await (
            clickhouseEngine as {
              regenerateConfig: (name: string, port: number) => Promise<void>
            }
          ).regenerateConfig(targetName, config.port)
        }
      }

      return config
    } catch (error) {
      // Clean up the copied directory on failure
      await rm(targetPath, { recursive: true, force: true }).catch(() => {
        // Ignore cleanup errors
      })
      throw error
    }
  }

  async rename(oldName: string, newName: string): Promise<ContainerConfig> {
    // Validate new name
    if (!this.isValidName(newName)) {
      throw new Error(
        'Container name must be alphanumeric with hyphens/underscores only',
      )
    }

    // Get source config
    const sourceConfig = await this.getConfig(oldName)
    if (!sourceConfig) {
      throw new Error(`Container "${oldName}" not found`)
    }

    const { engine } = sourceConfig

    // Check target doesn't exist
    if (await this.exists(newName, { engine })) {
      throw new Error(`Container "${newName}" already exists`)
    }

    // SQLite: rename in registry and handle container directory
    if (engine === Engine.SQLite) {
      const entry = await sqliteRegistry.get(oldName)
      if (!entry) {
        throw new Error(`SQLite container "${oldName}" not found in registry`)
      }

      // Move container directory first (if it exists) - do filesystem ops before registry
      // This way if the move fails, registry is unchanged
      const oldContainerPath = paths.getContainerPath(oldName, { engine })
      const newContainerPath = paths.getContainerPath(newName, { engine })
      if (existsSync(oldContainerPath)) {
        await this.atomicMoveDirectory(oldContainerPath, newContainerPath)
      }

      // Now update registry - remove old entry and add new one with updated name
      await sqliteRegistry.remove(oldName)
      await sqliteRegistry.add({
        name: newName,
        filePath: entry.filePath,
        created: entry.created,
        lastVerified: entry.lastVerified,
      })

      // Return updated config
      return {
        ...sourceConfig,
        name: newName,
      }
    }

    // DuckDB: rename in registry and handle container directory
    if (engine === Engine.DuckDB) {
      const entry = await duckdbRegistry.get(oldName)
      if (!entry) {
        throw new Error(`DuckDB container "${oldName}" not found in registry`)
      }

      // Move container directory first (if it exists) - do filesystem ops before registry
      // This way if the move fails, registry is unchanged
      const oldContainerPath = paths.getContainerPath(oldName, { engine })
      const newContainerPath = paths.getContainerPath(newName, { engine })
      if (existsSync(oldContainerPath)) {
        await this.atomicMoveDirectory(oldContainerPath, newContainerPath)
      }

      // Now update registry - remove old entry and add new one with updated name
      await duckdbRegistry.remove(oldName)
      await duckdbRegistry.add({
        name: newName,
        filePath: entry.filePath,
        created: entry.created,
        lastVerified: entry.lastVerified,
      })

      // Return updated config
      return {
        ...sourceConfig,
        name: newName,
      }
    }

    // Server databases: check container is not running
    const running = await processManager.isRunning(oldName, { engine })
    if (running) {
      throw new Error(`Container "${oldName}" is running. Stop it first`)
    }

    // Rename directory
    const oldPath = paths.getContainerPath(oldName, { engine })
    const newPath = paths.getContainerPath(newName, { engine })

    await this.atomicMoveDirectory(oldPath, newPath)

    // Update config with new name
    const config = await this.getConfig(newName, { engine })
    if (!config) {
      throw new Error('Failed to read renamed container config')
    }

    config.name = newName
    await this.saveConfig(newName, { engine }, config)

    // ClickHouse stores absolute paths in config.xml - regenerate with new paths
    if (engine === Engine.ClickHouse) {
      const clickhouseEngine = getEngine(Engine.ClickHouse)
      if ('regenerateConfig' in clickhouseEngine) {
        await (
          clickhouseEngine as {
            regenerateConfig: (name: string, port: number) => Promise<void>
          }
        ).regenerateConfig(newName, config.port)
      }
    }

    return config
  }

  // Moves a directory atomically when possible (same filesystem).
  // Falls back to copy+delete for cross-filesystem moves.
  // On Windows, retries on EBUSY errors (file handles held after process termination).
  // Windows can hold file locks for 120+ seconds due to:
  // - Antivirus software scanning
  // - Windows Search indexer
  // - Memory-mapped files (SurrealDB's SurrealKV, QuestDB's columnar storage)
  // - Java JVM file handle cleanup (QuestDB)
  private async atomicMoveDirectory(
    sourcePath: string,
    targetPath: string,
  ): Promise<void> {
    const maxRetries = isWindows() ? 90 : 1 // 90 retries × 2s = 180 seconds max
    const retryDelay = 2000 // 2 seconds between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Try atomic rename first (only works on same filesystem)
        await fsRename(sourcePath, targetPath)
        return // Success
      } catch (error) {
        const e = error as NodeJS.ErrnoException
        if (e.code === 'EXDEV') {
          // Cross-filesystem move - fall back to copy+delete
          await cp(sourcePath, targetPath, { recursive: true })
          try {
            await rm(sourcePath, { recursive: true, force: true })
          } catch {
            // If delete fails after copy, we have duplicates
            // Try to clean up the target to avoid inconsistency
            await rm(targetPath, { recursive: true, force: true }).catch(
              () => {},
            )
            throw new Error(
              `Failed to complete move: source and target may both exist. ` +
                `Please manually remove one of: ${sourcePath} or ${targetPath}`,
            )
          }
          return // Success
        } else if (e.code === 'EBUSY' && attempt < maxRetries) {
          // Windows: file handles may still be held - retry after delay
          logDebug(
            `EBUSY on rename attempt ${attempt}/${maxRetries}, retrying in ${retryDelay}ms...`,
          )
          await new Promise((resolve) => setTimeout(resolve, retryDelay))
        } else {
          throw error
        }
      }
    }
  }

  isValidName(name: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
  }

  async addDatabase(containerName: string, database: string): Promise<void> {
    const config = await this.getConfig(containerName)
    if (!config) {
      throw new Error(`Container "${containerName}" not found`)
    }

    // Ensure databases array exists
    if (!config.databases) {
      config.databases = [config.database]
    }

    // Add if not already present
    if (!config.databases.includes(database)) {
      config.databases.push(database)
      await this.saveConfig(containerName, { engine: config.engine }, config)
    }
  }

  async removeDatabase(containerName: string, database: string): Promise<void> {
    const config = await this.getConfig(containerName)
    if (!config) {
      throw new Error(`Container "${containerName}" not found`)
    }

    // Don't remove the primary database from the array
    if (database === config.database) {
      throw new Error(
        `Cannot remove primary database "${database}" from tracking`,
      )
    }

    if (config.databases) {
      config.databases = config.databases.filter((db) => db !== database)
      await this.saveConfig(containerName, { engine: config.engine }, config)
    }
  }

  /**
   * Sync the databases array with the actual databases on the server.
   * Queries the database server for all user databases and updates the registry.
   *
   * @param containerName - The container to sync
   * @returns The updated list of databases
   * @throws Error if the container is not running or doesn't support listing databases
   */
  async syncDatabases(containerName: string): Promise<string[]> {
    const config = await this.getConfig(containerName)
    if (!config) {
      throw new Error(`Container "${containerName}" not found`)
    }

    // File-based engines don't have multiple databases to sync
    if (isFileBasedEngine(config.engine)) {
      return config.databases || [config.database]
    }

    // Container must be running to query databases
    const running = await processManager.isRunning(containerName, {
      engine: config.engine,
    })
    if (!running) {
      throw new Error(
        `Container "${containerName}" is not running. Start it first to sync databases.`,
      )
    }

    const engine = getEngine(config.engine)

    // Query the actual database server for all databases
    let actualDatabases: string[]
    try {
      actualDatabases = await engine.listDatabases(config)
    } catch (error) {
      // If the engine doesn't support listDatabases, return current registry
      const err = error as Error
      if (err.message.includes('not supported')) {
        logDebug(
          `listDatabases not supported for ${config.engine}, skipping sync`,
        )
        return config.databases || [config.database]
      }
      throw error
    }

    // Ensure primary database is always included
    if (!actualDatabases.includes(config.database)) {
      actualDatabases = [config.database, ...actualDatabases]
    }

    // Sort for consistent ordering (primary database first, then alphabetical)
    const sortedDatabases = [
      config.database,
      ...actualDatabases
        .filter((db) => db !== config.database)
        .sort((a, b) => a.localeCompare(b)),
    ]

    // Update the registry
    config.databases = sortedDatabases
    await this.saveConfig(containerName, { engine: config.engine }, config)

    return sortedDatabases
  }

  getConnectionString(config: ContainerConfig, database?: string): string {
    const engine = getEngine(config.engine)
    return engine.getConnectionString(config, database)
  }
}

export const containerManager = new ContainerManager()
