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
import { cloneDirectory, type CopyMethod } from './cow-copy'
import { logDebug, UnsupportedOperationError } from './error-handler'
import { getEngineDefaults, getSupportedEngines } from '../config/defaults'
import { getEngine } from '../engines'
import { sqliteRegistry } from '../engines/sqlite/registry'
import { duckdbRegistry } from '../engines/duckdb/registry'

// File-based engines (SQLite, DuckDB) don't pin a specific binary version per
// container — the file format is library-managed and any matching-major
// version reads any file. But the ContainerConfig type requires a `version`
// string, so we report the hostdb-resolved full version for the engine's
// recommended major. This keeps the displayed version consistent with whatever
// binary spindb would currently use, instead of hardcoding shorthand `'3'` /
// `'1'` that drifts away from the actual binary.
function fileBasedEngineVersion(
  engine: Engine.SQLite | Engine.DuckDB,
): string {
  const major = getEngineDefaults(engine).defaultVersion
  const dbEngine = getEngine(engine)
  return dbEngine.resolveFullVersion(major)
}
import type {
  ContainerConfig,
  SQLiteRegistryEntry,
  DuckDBRegistryEntry,
} from '../types'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../types'

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

  // Convert a file-based registry entry to ContainerConfig format. Shared by
  // getConfig and list so branch lineage (branchParent/branchedAt/gitBranch) is
  // surfaced consistently. "running" status = the backing file exists.
  private fileBasedEntryToConfig(
    entry: SQLiteRegistryEntry | DuckDBRegistryEntry,
    engine: Engine.SQLite | Engine.DuckDB,
  ): ContainerConfig {
    const fileExists = existsSync(entry.filePath)
    return {
      name: entry.name,
      engine,
      version: fileBasedEngineVersion(engine),
      port: 0,
      database: entry.filePath, // file-based: database field stores file path
      databases: [entry.filePath],
      created: entry.created,
      status: fileExists ? 'running' : 'stopped',
      ...(entry.branchParent ? { branchParent: entry.branchParent } : {}),
      ...(entry.branchedAt ? { branchedAt: entry.branchedAt } : {}),
      ...(entry.gitBranch ? { gitBranch: entry.gitBranch } : {}),
    }
  }

  private async getSqliteConfig(name: string): Promise<ContainerConfig | null> {
    const entry = await sqliteRegistry.get(name)
    if (!entry) {
      return null
    }
    return this.fileBasedEntryToConfig(entry, Engine.SQLite)
  }

  private async getDuckDBConfig(name: string): Promise<ContainerConfig | null> {
    const entry = await duckdbRegistry.get(name)
    if (!entry) {
      return null
    }
    return this.fileBasedEntryToConfig(entry, Engine.DuckDB)
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
      containers.push(this.fileBasedEntryToConfig(entry, Engine.SQLite))
    }

    // List DuckDB containers from registry
    const duckdbEntries = await duckdbRegistry.list()
    for (const entry of duckdbEntries) {
      containers.push(this.fileBasedEntryToConfig(entry, Engine.DuckDB))
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
              // Remote containers keep their 'linked' status — no process check
              if (isRemoteContainer(config)) {
                return { ...config, status: 'linked' as const }
              }
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

    // Remote containers: only remove local metadata (no process to stop)
    if (isRemoteContainer(config)) {
      const containerPath = paths.getContainerPath(name, { engine })
      await this.safeRemoveDirectory(containerPath)
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

  /**
   * Duplicate a server-based container's data directory under a new name and
   * write a new container.json for it. Shared by `clone()` (full byte copy) and
   * the branch manager (copy-on-write reflink). The caller is responsible for
   * ensuring the source is in a copyable state (stopped, or a consistent
   * snapshot); this method does the mechanical copy + config rewrite only.
   *
   * File-based engines (SQLite/DuckDB) are NOT handled here — their data lives
   * in an external file tracked by a registry, so the branch manager copies the
   * file and registers a new entry directly.
   */
  async copyContainerData(options: {
    sourceName: string
    targetName: string
    /** 'cow' uses a copy-on-write reflink where the filesystem supports it; 'copy' is a full byte copy. */
    strategy: 'cow' | 'copy'
    /** Lineage to stamp on the new container (typically exactly one is set). */
    lineage: { clonedFrom?: string; branchParent?: string }
    /** Explicit port for the new container; when omitted, the next free port in the engine range is used. */
    port?: number
  }): Promise<{ config: ContainerConfig; method: CopyMethod }> {
    const { sourceName, targetName, strategy, lineage } = options

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

    // Duplicate the container directory: reflink for branches (instant where
    // the filesystem supports it), full byte copy for clones.
    const sourcePath = paths.getContainerPath(sourceName, { engine })
    const targetPath = paths.getContainerPath(targetName, { engine })

    // Copy the data directory, then write the new config. If anything fails —
    // the copy itself, reading the config back, or the engine fixup hook —
    // clean up the (possibly partial) target directory.
    try {
      let method: CopyMethod = 'copy'
      if (strategy === 'cow') {
        method = (await cloneDirectory(sourcePath, targetPath)).method
      } else {
        await cp(sourcePath, targetPath, { recursive: true })
      }

      // Update target config
      const config = await this.getConfig(targetName, { engine })
      if (!config) {
        throw new Error('Failed to read copied container config')
      }

      config.name = targetName
      config.created = new Date().toISOString()
      // A freshly copied container is not running yet, regardless of what the
      // source's persisted status said.
      config.status = 'stopped'

      // Reset lineage, then apply the requested lineage so branch and clone
      // metadata never leak into each other across repeated operations.
      delete config.clonedFrom
      delete config.branchParent
      delete config.branchedAt
      delete config.gitBranch
      if (lineage.clonedFrom) {
        config.clonedFrom = lineage.clonedFrom
      }
      if (lineage.branchParent) {
        config.branchParent = lineage.branchParent
        config.branchedAt = config.created
      }

      // Assign a port: an explicit one (stable-port git branches) or the next
      // free port in the engine's range (excluding ports used by containers).
      if (options.port !== undefined) {
        config.port = options.port
      } else {
        const engineDefaults = getEngineDefaults(engine)
        const { port } =
          await portManager.findAvailablePortExcludingContainers({
            portRange: engineDefaults.portRange,
          })
        config.port = port
      }

      await this.saveConfig(targetName, { engine }, config)

      // Let the engine fix up any identity/paths baked into the copied data
      // dir for the new name and port (e.g. ClickHouse regenerates config.xml).
      await getEngine(engine).prepareBranchedDataDir(config, { sourceName })

      return { config, method }
    } catch (error) {
      // Clean up the copied directory on failure
      await rm(targetPath, { recursive: true, force: true }).catch(() => {
        // Ignore cleanup errors
      })
      throw error
    }
  }

  async clone(
    sourceName: string,
    targetName: string,
  ): Promise<ContainerConfig> {
    // Get source config to determine the engine and verify it exists
    const sourceConfig = await this.getConfig(sourceName)
    if (!sourceConfig) {
      throw new Error(`Source container "${sourceName}" not found`)
    }

    // copyContainerData duplicates a server container's data directory.
    // File-based engines (SQLite/DuckDB) keep their data in an external file
    // tracked by a registry, which it doesn't handle — point users to branch,
    // which forks the backing file and registers a new entry.
    if (isFileBasedEngine(sourceConfig.engine)) {
      throw new Error(
        `Cloning file-based containers (${sourceConfig.engine}) is not supported. ` +
          `Use "spindb branch ${sourceName} ${targetName}" to fork it instead.`,
      )
    }

    // Clone requires a stopped source (use `spindb branch` for live sources).
    const running = await processManager.isRunning(sourceName, {
      engine: sourceConfig.engine,
    })
    if (running) {
      throw new Error(
        `Source container "${sourceName}" is running. Stop it first`,
      )
    }

    const { config } = await this.copyContainerData({
      sourceName,
      targetName,
      strategy: 'copy',
      lineage: { clonedFrom: sourceName },
    })
    return config
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

      // Now update registry - remove old entry and add new one with updated name.
      // Spread the existing entry so lineage fields (branchParent/branchedAt/
      // gitBranch) survive the rename instead of being dropped.
      await sqliteRegistry.remove(oldName)
      await sqliteRegistry.add({
        ...entry,
        name: newName,
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

      // Now update registry - remove old entry and add new one with updated name.
      // Spread the existing entry so lineage fields (branchParent/branchedAt/
      // gitBranch) survive the rename instead of being dropped.
      await duckdbRegistry.remove(oldName)
      await duckdbRegistry.add({
        ...entry,
        name: newName,
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

    // Remote containers: return current registry (no local process to query)
    if (isRemoteContainer(config)) {
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
      if (error instanceof UnsupportedOperationError) {
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

/**
 * Update tracking after a database rename.
 * Shared by CLI commands and interactive menu handlers.
 */
export async function updateRenameTracking(
  containerName: string,
  oldName: string,
  newName: string,
  options: { shouldDrop: boolean; isPrimaryRename: boolean },
): Promise<void> {
  const { shouldDrop, isPrimaryRename } = options

  await containerManager.addDatabase(containerName, newName)

  if (
    shouldDrop &&
    oldName !== (await containerManager.getConfig(containerName))?.database
  ) {
    await containerManager.removeDatabase(containerName, oldName)
  }

  if (isPrimaryRename) {
    await containerManager.updateConfig(containerName, { database: newName })
    if (shouldDrop) {
      const updatedConfig = await containerManager.getConfig(containerName)
      if (updatedConfig?.databases?.includes(oldName)) {
        await containerManager.removeDatabase(containerName, oldName)
      }
    }
  }
}
