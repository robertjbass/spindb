/**
 * DuckDB Registry Manager
 *
 * Unlike PostgreSQL/MySQL which store containers in ~/.spindb/containers/,
 * DuckDB databases are stored in user project directories. This registry
 * tracks the file paths of all DuckDB databases managed by SpinDB.
 *
 * The registry is stored in ~/.spindb/config.json under registry.duckdb
 *
 * Note: Mutation operations use file-based locking to prevent race conditions
 * when multiple processes access the registry concurrently.
 */

import { existsSync } from 'fs'
import { mkdir, writeFile, unlink, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { configManager } from '../../core/config-manager'
import { paths } from '../../config/paths'
import type { DuckDBEngineRegistry, DuckDBRegistryEntry } from '../../types'

// Lock file settings
const LOCK_STALE_MS = 10000 // Consider lock stale after 10 seconds
const LOCK_RETRY_MS = 50 // Retry interval when waiting for lock
const LOCK_TIMEOUT_MS = 5000 // Max time to wait for lock

/**
 * Simple file-based lock for registry mutations.
 * Uses atomic file creation to ensure exclusive access.
 */
class RegistryLock {
  private lockPath: string

  constructor() {
    this.lockPath = join(paths.root, '.duckdb-registry.lock')
  }

  /**
   * Acquire the lock, waiting if necessary.
   * Returns a release function that must be called when done.
   */
  async acquire(): Promise<() => Promise<void>> {
    const startTime = Date.now()

    while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
      try {
        // Check if existing lock is stale
        if (existsSync(this.lockPath)) {
          try {
            const lockStat = await stat(this.lockPath)
            const lockAge = Date.now() - lockStat.mtimeMs
            if (lockAge > LOCK_STALE_MS) {
              // Stale lock, remove it
              await unlink(this.lockPath).catch(() => {})
            }
          } catch {
            // Lock file disappeared, continue to acquire
          }
        }

        // Ensure parent directory exists
        await mkdir(dirname(this.lockPath), { recursive: true })

        // Try to create lock file exclusively
        // Using 'wx' flag: create exclusively, fail if exists
        await writeFile(this.lockPath, String(process.pid), { flag: 'wx' })

        // Successfully acquired lock
        return async () => {
          await unlink(this.lockPath).catch(() => {})
        }
      } catch (err) {
        const error = err as NodeJS.ErrnoException
        if (error.code === 'EEXIST') {
          // Lock exists, wait and retry
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
        } else {
          throw err
        }
      }
    }

    throw new Error(
      `Timeout acquiring DuckDB registry lock after ${LOCK_TIMEOUT_MS}ms`,
    )
  }
}

const registryLock = new RegistryLock()

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
    const release = await registryLock.acquire()
    try {
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
    } finally {
      await release()
    }
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
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      const index = registry.entries.findIndex((e) => e.name === name)

      if (index === -1) {
        return false
      }

      registry.entries.splice(index, 1)
      await this.save(registry)
      return true
    } finally {
      await release()
    }
  }

  /**
   * Update an existing entry
   * Returns true if the entry was found and updated, false otherwise
   */
  async update(
    name: string,
    updates: Partial<Omit<DuckDBRegistryEntry, 'name'>>,
  ): Promise<boolean> {
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      const entry = registry.entries.find((e) => e.name === name)

      if (!entry) {
        return false
      }

      Object.assign(entry, updates)
      await this.save(registry)
      return true
    } finally {
      await release()
    }
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
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      const originalCount = registry.entries.length

      registry.entries = registry.entries.filter((e) => existsSync(e.filePath))

      const removedCount = originalCount - registry.entries.length
      if (removedCount > 0) {
        await this.save(registry)
      }

      return removedCount
    } finally {
      await release()
    }
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
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      registry.ignoreFolders[folderPath] = true
      await this.save(registry)
    } finally {
      await release()
    }
  }

  /**
   * Remove a folder from the ignore list
   * Returns true if the folder was in the list and removed, false otherwise
   */
  async removeIgnoreFolder(folderPath: string): Promise<boolean> {
    const release = await registryLock.acquire()
    try {
      const registry = await this.load()
      if (folderPath in registry.ignoreFolders) {
        delete registry.ignoreFolders[folderPath]
        await this.save(registry)
        return true
      }
      return false
    } finally {
      await release()
    }
  }

  // List all ignored folders
  async listIgnoredFolders(): Promise<string[]> {
    const registry = await this.load()
    return Object.keys(registry.ignoreFolders)
  }
}

// Export singleton instance
export const duckdbRegistry = new DuckDBRegistryManager()
