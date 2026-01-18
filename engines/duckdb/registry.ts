/**
 * DuckDB Registry Manager
 *
 * Unlike PostgreSQL/MySQL which store containers in ~/.spindb/containers/,
 * DuckDB databases are stored in user project directories. This registry
 * tracks the file paths of all DuckDB databases managed by SpinDB.
 *
 * The registry is stored in ~/.spindb/config.json under registry.duckdb
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import type { DuckDBEngineRegistry, DuckDBRegistryEntry } from '../../types'

/**
 * DuckDB Registry Manager
 * Manages the registry that tracks external DuckDB database files
 * Data is stored in config.json under registry.duckdb
 */
class DuckDBRegistryManager {
  /**
   * Load the registry from config.json
   * Returns an empty registry if none exists
   */
  async load(): Promise<DuckDBEngineRegistry> {
    return configManager.getDuckDBRegistry()
  }

  // Save the registry to config.json
  async save(registry: DuckDBEngineRegistry): Promise<void> {
    await configManager.saveDuckDBRegistry(registry)
  }

  /**
   * Add a new entry to the registry
   * @throws Error if a container with the same name or file path already exists
   */
  async add(entry: DuckDBRegistryEntry): Promise<void> {
    const registry = await this.load()

    // Check for duplicate name
    if (registry.entries.some((e) => e.name === entry.name)) {
      throw new Error(`DuckDB container "${entry.name}" already exists`)
    }

    // Check for duplicate file path
    if (registry.entries.some((e) => e.filePath === entry.filePath)) {
      throw new Error(
        `DuckDB container for path "${entry.filePath}" already exists`,
      )
    }

    registry.entries.push(entry)
    await this.save(registry)
  }

  /**
   * Get an entry by name
   * Returns null if not found
   */
  async get(name: string): Promise<DuckDBRegistryEntry | null> {
    const registry = await this.load()
    return registry.entries.find((e) => e.name === name) || null
  }

  /**
   * Remove an entry by name
   * Returns true if the entry was found and removed, false otherwise
   */
  async remove(name: string): Promise<boolean> {
    const registry = await this.load()
    const index = registry.entries.findIndex((e) => e.name === name)

    if (index === -1) {
      return false
    }

    registry.entries.splice(index, 1)
    await this.save(registry)
    return true
  }

  /**
   * Update an existing entry
   * Returns true if the entry was found and updated, false otherwise
   */
  async update(
    name: string,
    updates: Partial<Omit<DuckDBRegistryEntry, 'name'>>,
  ): Promise<boolean> {
    const registry = await this.load()
    const entry = registry.entries.find((e) => e.name === name)

    if (!entry) {
      return false
    }

    Object.assign(entry, updates)
    await this.save(registry)
    return true
  }

  // List all entries in the registry
  async list(): Promise<DuckDBRegistryEntry[]> {
    const registry = await this.load()
    return registry.entries
  }

  // Check if a container with the given name exists
  async exists(name: string): Promise<boolean> {
    const entry = await this.get(name)
    return entry !== null
  }

  // Find orphaned entries (where the file no longer exists)
  async findOrphans(): Promise<DuckDBRegistryEntry[]> {
    const registry = await this.load()
    return registry.entries.filter((e) => !existsSync(e.filePath))
  }

  /**
   * Remove all orphaned entries from the registry
   * Returns the number of entries removed
   */
  async removeOrphans(): Promise<number> {
    const registry = await this.load()
    const originalCount = registry.entries.length

    registry.entries = registry.entries.filter((e) => existsSync(e.filePath))

    const removedCount = originalCount - registry.entries.length
    if (removedCount > 0) {
      await this.save(registry)
    }

    return removedCount
  }

  // Update the lastVerified timestamp for an entry
  async updateVerified(name: string): Promise<void> {
    await this.update(name, { lastVerified: new Date().toISOString() })
  }

  // Check if a file path is already registered (by any container)
  async isPathRegistered(filePath: string): Promise<boolean> {
    const registry = await this.load()
    return registry.entries.some((e) => e.filePath === filePath)
  }

  /**
   * Get the container name for a given file path
   * Returns null if not found
   */
  async getByPath(filePath: string): Promise<DuckDBRegistryEntry | null> {
    const registry = await this.load()
    return registry.entries.find((e) => e.filePath === filePath) || null
  }

  // ============================================================
  // Folder Ignore Methods
  // ============================================================

  // Check if a folder is in the ignore list
  async isFolderIgnored(folderPath: string): Promise<boolean> {
    const registry = await this.load()
    return folderPath in registry.ignoreFolders
  }

  // Add a folder to the ignore list
  async addIgnoreFolder(folderPath: string): Promise<void> {
    const registry = await this.load()
    registry.ignoreFolders[folderPath] = true
    await this.save(registry)
  }

  /**
   * Remove a folder from the ignore list
   * Returns true if the folder was in the list and removed, false otherwise
   */
  async removeIgnoreFolder(folderPath: string): Promise<boolean> {
    const registry = await this.load()
    if (folderPath in registry.ignoreFolders) {
      delete registry.ignoreFolders[folderPath]
      await this.save(registry)
      return true
    }
    return false
  }

  // List all ignored folders
  async listIgnoredFolders(): Promise<string[]> {
    const registry = await this.load()
    return Object.keys(registry.ignoreFolders)
  }
}

// Export singleton instance
export const duckdbRegistry = new DuckDBRegistryManager()
