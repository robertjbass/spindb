import { existsSync } from 'fs'
import { mkdir, readdir, readFile, writeFile, rm, cp } from 'fs/promises'
import { paths } from '@/config/paths'
import { processManager } from '@/core/process-manager'
import { portManager } from '@/core/port-manager'
import type { ContainerConfig } from '@/types'

export type CreateOptions = {
  engine: string
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

    // Check if container already exists
    if (await this.exists(name)) {
      throw new Error(`Container "${name}" already exists`)
    }

    // Create container directory
    const containerPath = paths.getContainerPath(name)
    const dataPath = paths.getContainerDataPath(name)

    await mkdir(containerPath, { recursive: true })
    await mkdir(dataPath, { recursive: true })

    // Create container config
    const config: ContainerConfig = {
      name,
      engine,
      version,
      port,
      database,
      created: new Date().toISOString(),
      status: 'created',
    }

    await this.saveConfig(name, config)

    return config
  }

  /**
   * Get container configuration
   */
  async getConfig(name: string): Promise<ContainerConfig | null> {
    const configPath = paths.getContainerConfigPath(name)

    if (!existsSync(configPath)) {
      return null
    }

    const content = await readFile(configPath, 'utf8')
    return JSON.parse(content) as ContainerConfig
  }

  /**
   * Save container configuration
   */
  async saveConfig(name: string, config: ContainerConfig): Promise<void> {
    const configPath = paths.getContainerConfigPath(name)
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
    await this.saveConfig(name, updatedConfig)
    return updatedConfig
  }

  /**
   * Check if a container exists
   */
  async exists(name: string): Promise<boolean> {
    const configPath = paths.getContainerConfigPath(name)
    return existsSync(configPath)
  }

  /**
   * List all containers
   */
  async list(): Promise<ContainerConfig[]> {
    const containersDir = paths.containers

    if (!existsSync(containersDir)) {
      return []
    }

    const entries = await readdir(containersDir, { withFileTypes: true })
    const containers: ContainerConfig[] = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const config = await this.getConfig(entry.name)
        if (config) {
          // Check if actually running
          const running = await processManager.isRunning(entry.name)
          containers.push({
            ...config,
            status: running ? 'running' : 'stopped',
          })
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

    if (!(await this.exists(name))) {
      throw new Error(`Container "${name}" not found`)
    }

    // Check if running
    const running = await processManager.isRunning(name)
    if (running && !force) {
      throw new Error(
        `Container "${name}" is running. Stop it first or use --force`,
      )
    }

    const containerPath = paths.getContainerPath(name)
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

    // Check source exists
    if (!(await this.exists(sourceName))) {
      throw new Error(`Source container "${sourceName}" not found`)
    }

    // Check target doesn't exist
    if (await this.exists(targetName)) {
      throw new Error(`Target container "${targetName}" already exists`)
    }

    // Check source is not running
    const running = await processManager.isRunning(sourceName)
    if (running) {
      throw new Error(
        `Source container "${sourceName}" is running. Stop it first`,
      )
    }

    // Copy container directory
    const sourcePath = paths.getContainerPath(sourceName)
    const targetPath = paths.getContainerPath(targetName)

    await cp(sourcePath, targetPath, { recursive: true })

    // Update target config
    const config = await this.getConfig(targetName)
    if (!config) {
      throw new Error('Failed to read cloned container config')
    }

    config.name = targetName
    config.created = new Date().toISOString()
    config.clonedFrom = sourceName

    // Assign new port (excluding ports already used by other containers)
    const { port } = await portManager.findAvailablePortExcludingContainers()
    config.port = port

    await this.saveConfig(targetName, config)

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

    // Check source exists
    if (!(await this.exists(oldName))) {
      throw new Error(`Container "${oldName}" not found`)
    }

    // Check target doesn't exist
    if (await this.exists(newName)) {
      throw new Error(`Container "${newName}" already exists`)
    }

    // Check container is not running
    const running = await processManager.isRunning(oldName)
    if (running) {
      throw new Error(`Container "${oldName}" is running. Stop it first`)
    }

    // Rename directory
    const oldPath = paths.getContainerPath(oldName)
    const newPath = paths.getContainerPath(newName)

    await cp(oldPath, newPath, { recursive: true })
    await rm(oldPath, { recursive: true, force: true })

    // Update config with new name
    const config = await this.getConfig(newName)
    if (!config) {
      throw new Error('Failed to read renamed container config')
    }

    config.name = newName
    await this.saveConfig(newName, config)

    return config
  }

  /**
   * Validate container name
   */
  isValidName(name: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
  }

  /**
   * Get connection string for a container
   */
  getConnectionString(
    config: ContainerConfig,
    database: string = 'postgres',
  ): string {
    const { port } = config
    return `postgresql://postgres@localhost:${port}/${database}`
  }
}

export const containerManager = new ContainerManager()
