/**
 * SQLite Scanner
 *
 * Scans directories for unregistered SQLite database files.
 * Used to detect SQLite databases in the current working directory
 * that are not yet registered with SpinDB.
 */

import { readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { sqliteRegistry } from './registry'

export type UnregisteredFile = {
  fileName: string
  absolutePath: string
}

/**
 * Scan a directory for unregistered SQLite files
 * Returns files with .sqlite, .sqlite3, or .db extensions
 * that are not already in the registry
 *
 * @param directory Directory to scan (defaults to CWD)
 * @returns Array of unregistered SQLite files
 */
export async function scanForUnregisteredSqliteFiles(
  directory: string = process.cwd(),
): Promise<UnregisteredFile[]> {
  const absoluteDir = resolve(directory)

  // Check if folder is ignored
  if (await sqliteRegistry.isFolderIgnored(absoluteDir)) {
    return []
  }

  // Check if directory exists
  if (!existsSync(absoluteDir)) {
    return []
  }

  try {
    // Get all files in directory
    const entries = await readdir(absoluteDir, { withFileTypes: true })

    // Filter for SQLite files
    const sqliteFiles = entries
      .filter((e) => e.isFile())
      .filter((e) => /\.(sqlite3?|db)$/i.test(e.name))
      .map((e) => ({
        fileName: e.name,
        absolutePath: resolve(absoluteDir, e.name),
      }))

    // Filter out already registered files
    const unregistered: UnregisteredFile[] = []
    for (const file of sqliteFiles) {
      if (!(await sqliteRegistry.isPathRegistered(file.absolutePath))) {
        unregistered.push(file)
      }
    }

    return unregistered
  } catch {
    // If we can't read the directory, return empty
    return []
  }
}

/**
 * Derive a valid container name from a filename
 * Removes extension and converts to valid container name format:
 * - Must start with a letter
 * - Can contain letters, numbers, hyphens, underscores
 *
 * @param fileName The SQLite filename (e.g., "my-database.sqlite")
 * @returns A valid container name (e.g., "my-database")
 */
export function deriveContainerName(fileName: string): string {
  // Remove extension
  const base = fileName.replace(/\.(sqlite3?|db)$/i, '')

  // Convert to valid container name (alphanumeric, hyphens, underscores)
  // Replace invalid chars with hyphens
  let name = base.replace(/[^a-zA-Z0-9_-]/g, '-')

  // Ensure starts with letter
  if (!/^[a-zA-Z]/.test(name)) {
    name = 'db-' + name
  }

  // Remove consecutive hyphens
  name = name.replace(/-+/g, '-')

  // Trim leading/trailing hyphens
  name = name.replace(/^-+|-+$/g, '')

  return name || 'sqlite-db'
}
