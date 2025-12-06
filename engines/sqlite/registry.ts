/**
 * SQLite Registry Manager
 *
 * Unlike PostgreSQL/MySQL which store containers in ~/.spindb/containers/,
 * SQLite databases are stored in user project directories. This registry
 * tracks the file paths of all SQLite databases managed by SpinDB.
 */

import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { paths } from '../../config/paths'
import type { SQLiteRegistry, SQLiteRegistryEntry } from '../../types'

/**
 * SQLite Registry Manager
 * Manages the JSON registry that tracks external SQLite database files
 */
class SQLiteRegistryManager {
  private registryPath: string

  constructor() {
    this.registryPath = paths.getSqliteRegistryPath()
  }

  /**
   * Load the registry from disk
   * Returns an empty registry if the file doesn't exist
   */
  async load(): Promise<SQLiteRegistry> {
    if (!existsSync(this.registryPath)) {
      return { version: 1, entries: [] }
    }
    try {
      const content = await readFile(this.registryPath, 'utf8')
      return JSON.parse(content) as SQLiteRegistry
    } catch {
      // If file is corrupted, return empty registry
      return { version: 1, entries: [] }
    }
  }

  /**
   * Save the registry to disk
   * Creates the parent directory if it doesn't exist
   */
  async save(registry: SQLiteRegistry): Promise<void> {
    const dir = dirname(this.registryPath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
    await writeFile(this.registryPath, JSON.stringify(registry, null, 2))
  }

  /**
   * Add a new entry to the registry
   * @throws Error if a container with the same name already exists
   */
  async add(entry: SQLiteRegistryEntry): Promise<void> {
    const registry = await this.load()

    // Check for duplicate name
    if (registry.entries.some((e) => e.name === entry.name)) {
      throw new Error(`SQLite container "${entry.name}" already exists`)
    }

    registry.entries.push(entry)
    await this.save(registry)
  }

  /**
   * Get an entry by name
   * Returns null if not found
   */
  async get(name: string): Promise<SQLiteRegistryEntry | null> {
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
    updates: Partial<Omit<SQLiteRegistryEntry, 'name'>>,
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

  /**
   * List all entries in the registry
   */
  async list(): Promise<SQLiteRegistryEntry[]> {
    const registry = await this.load()
    return registry.entries
  }

  /**
   * Check if a container with the given name exists
   */
  async exists(name: string): Promise<boolean> {
    const entry = await this.get(name)
    return entry !== null
  }

  /**
   * Find orphaned entries (where the file no longer exists)
   */
  async findOrphans(): Promise<SQLiteRegistryEntry[]> {
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

  /**
   * Update the lastVerified timestamp for an entry
   */
  async updateVerified(name: string): Promise<void> {
    await this.update(name, { lastVerified: new Date().toISOString() })
  }

  /**
   * Check if a file path is already registered (by any container)
   */
  async isPathRegistered(filePath: string): Promise<boolean> {
    const registry = await this.load()
    return registry.entries.some((e) => e.filePath === filePath)
  }

  /**
   * Get the container name for a given file path
   * Returns null if not found
   */
  async getByPath(filePath: string): Promise<SQLiteRegistryEntry | null> {
    const registry = await this.load()
    return registry.entries.find((e) => e.filePath === filePath) || null
  }
}

// Export singleton instance
export const sqliteRegistry = new SQLiteRegistryManager()
