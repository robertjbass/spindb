import { existsSync } from 'fs'
import { mkdir, readdir, readFile, writeFile, rm, cp } from 'fs/promises'
import { paths } from '../config/paths'
import { processManager } from './process-manager'
import { portManager } from './port-manager'
import { getEngineDefaults, getSupportedEngines } from '../config/defaults'
import { getEngine } from '../engines'
import type { ContainerConfig } from '../types'
import { Engine } from '../types'

export type CreateOptions = {
  engine: Engine
  version: string
  port: number
  database: string
}

export type DeleteOptions = {
  force?: boolean
}

export class ContainerManager {
  /**
   * Create a new container
   */
  async create(name: string, options: CreateOptions): Promise<ContainerConfig> {
    const { engine, version, port, database } = options

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
    }

    await this.saveConfig(name, { engine }, config)

    return config
  }

  /**
   * Get container configuration
   * If engine is not provided, searches all engine directories
   * Automatically migrates old schemas to include databases array
   */
  async getConfig(
    name: string,
    options?: { engine?: string },
  ): Promise<ContainerConfig | null> {
    const { engine } = options || {}

    if (engine) {
      // Look in specific engine directory
      const configPath = paths.getContainerConfigPath(name, { engine })
      if (!existsSync(configPath)) {
        return null
      }
      const content = await readFile(configPath, 'utf8')
      const config = JSON.parse(content) as ContainerConfig
      return this.migrateConfig(config)
    }

    // Search all engine directories
    const engines = getSupportedEngines()
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

  /**
   * Migrate old container configs to include databases array
   * Ensures primary database is always in the databases array
   */
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

  /**
   * Save container configuration
   */
  async saveConfig(
    name: string,
    options: { engine: string },
    config: ContainerConfig,
  ): Promise<void> {
    const { engine } = options
    const configPath = paths.getContainerConfigPath(name, { engine })
    await writeFile(configPath, JSON.stringify(config, null, 2))
  }

  /**
   * Update container configuration
   */
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

  /**
   * Check if a container exists
   * If engine is not provided, checks all engine directories
   */
  async exists(name: string, options?: { engine?: string }): Promise<boolean> {
    const { engine } = options || {}

    if (engine) {
      const configPath = paths.getContainerConfigPath(name, { engine })
      return existsSync(configPath)
    }

    // Check all engine directories
    const engines = getSupportedEngines()
    for (const eng of engines) {
      const configPath = paths.getContainerConfigPath(name, { engine: eng })
      if (existsSync(configPath)) {
        return true
      }
    }

    return false
  }

  /**
   * List all containers across all engines
   */
  async list(): Promise<ContainerConfig[]> {
    const containersDir = paths.containers

    if (!existsSync(containersDir)) {
      return []
    }

    const containers: ContainerConfig[] = []
    const engines = getSupportedEngines()

    for (const engine of engines) {
      const engineDir = paths.getEngineContainersPath(engine)
      if (!existsSync(engineDir)) {
        continue
      }

      const entries = await readdir(engineDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const config = await this.getConfig(entry.name, { engine })
          if (config) {
            // Check if actually running
            const running = await processManager.isRunning(entry.name, {
              engine,
            })
            containers.push({
              ...config,
              status: running ? 'running' : 'stopped',
            })
          }
        }
      }
    }

    return containers
  }

  /**
   * Delete a container
   */
  async delete(name: string, options: DeleteOptions = {}): Promise<void> {
    const { force = false } = options

    // Get container config to find engine
    const config = await this.getConfig(name)
    if (!config) {
      throw new Error(`Container "${name}" not found`)
    }

    const { engine } = config

    // Check if running
    const running = await processManager.isRunning(name, { engine })
    if (running && !force) {
      throw new Error(
        `Container "${name}" is running. Stop it first or use --force`,
      )
    }

    const containerPath = paths.getContainerPath(name, { engine })
    await rm(containerPath, { recursive: true, force: true })
  }

  /**
   * Clone a container
   */
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

    return config
  }

  /**
   * Rename a container
   */
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

    // Check container is not running
    const running = await processManager.isRunning(oldName, { engine })
    if (running) {
      throw new Error(`Container "${oldName}" is running. Stop it first`)
    }

    // Rename directory
    const oldPath = paths.getContainerPath(oldName, { engine })
    const newPath = paths.getContainerPath(newName, { engine })

    await cp(oldPath, newPath, { recursive: true })
    await rm(oldPath, { recursive: true, force: true })

    // Update config with new name
    const config = await this.getConfig(newName, { engine })
    if (!config) {
      throw new Error('Failed to read renamed container config')
    }

    config.name = newName
    await this.saveConfig(newName, { engine }, config)

    return config
  }

  /**
   * Validate container name
   */
  isValidName(name: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
  }

  /**
   * Add a database to the container's databases array
   */
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

  /**
   * Remove a database from the container's databases array
   */
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
   * Get connection string for a container
   * Delegates to the appropriate engine
   */
  getConnectionString(config: ContainerConfig, database?: string): string {
    const engine = getEngine(config.engine)
    return engine.getConnectionString(config, database)
  }
}

export const containerManager = new ContainerManager()
