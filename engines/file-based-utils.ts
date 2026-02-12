/**
 * Centralized utilities for file-based engines (SQLite, DuckDB)
 *
 * This module is the single source of truth for:
 * - Extension → engine mapping
 * - Engine → valid extensions
 * - Engine → registry
 * - Container name derivation from filenames
 * - Scanning for unregistered files
 *
 * All file-based engine behavior should go through this module
 * so that adding a new file-based engine only requires changes here.
 */

import { readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve, extname } from 'path'
import { Engine, isFileBasedEngine } from '../types'
import { sqliteRegistry } from './sqlite/registry'
import { duckdbRegistry } from './duckdb/registry'

// ============================================================
// Extension Mapping
// ============================================================

/**
 * Map of file extensions to their corresponding file-based engine.
 * This is the single source of truth for extension → engine detection.
 */
const EXTENSION_TO_ENGINE: Record<string, Engine> = {
  '.sqlite': Engine.SQLite,
  '.sqlite3': Engine.SQLite,
  '.db': Engine.SQLite,
  '.duckdb': Engine.DuckDB,
  '.ddb': Engine.DuckDB,
}

/**
 * Valid extensions per engine, derived from the extension map.
 * Used for validation (e.g., ensuring a SQLite container only relocates to a SQLite extension).
 */
const ENGINE_EXTENSIONS: Record<Engine.SQLite | Engine.DuckDB, string[]> = {
  [Engine.SQLite]: ['.sqlite', '.sqlite3', '.db'],
  [Engine.DuckDB]: ['.duckdb', '.ddb'],
}

/**
 * Extension regex per engine (for stripping extensions from filenames).
 */
const ENGINE_EXTENSION_REGEX: Record<Engine.SQLite | Engine.DuckDB, RegExp> = {
  [Engine.SQLite]: /\.(sqlite3?|db)$/i,
  [Engine.DuckDB]: /\.(duckdb|ddb)$/i,
}

/**
 * Combined regex matching any file-based engine extension.
 */
export const FILE_BASED_EXTENSION_REGEX = /\.(sqlite3?|db|duckdb|ddb)$/i

/**
 * Detect which file-based engine a file belongs to based on its extension.
 * Returns null if the extension is not recognized as a file-based database.
 */
export function detectEngineFromPath(filePath: string): Engine | null {
  const ext = extname(filePath).toLowerCase()
  return EXTENSION_TO_ENGINE[ext] ?? null
}

/**
 * Get the valid file extensions for a file-based engine.
 */
export function getExtensionsForEngine(
  engine: Engine.SQLite | Engine.DuckDB,
): string[] {
  return ENGINE_EXTENSIONS[engine]
}

/**
 * Get all valid file-based database extensions.
 */
export function getAllFileBasedExtensions(): string[] {
  return Object.keys(EXTENSION_TO_ENGINE)
}

/**
 * Check if a file path has a valid extension for the given engine.
 */
export function isValidExtensionForEngine(
  filePath: string,
  engine: Engine.SQLite | Engine.DuckDB,
): boolean {
  const ext = extname(filePath).toLowerCase()
  return ENGINE_EXTENSIONS[engine].includes(ext)
}

/**
 * Human-readable string of valid extensions for a file-based engine.
 */
export function formatExtensionsForEngine(
  engine: Engine.SQLite | Engine.DuckDB,
): string {
  return ENGINE_EXTENSIONS[engine].join(', ')
}

/**
 * Human-readable string of all valid file-based extensions.
 */
export function formatAllExtensions(): string {
  return Object.keys(EXTENSION_TO_ENGINE).join(', ')
}

// ============================================================
// Registry Access
// ============================================================

/**
 * Common interface for file-based engine registries.
 * Both SQLite and DuckDB registries implement this shape.
 */
export type FileBasedRegistry = {
  add(entry: { name: string; filePath: string; created: string }): Promise<void>
  get(name: string): Promise<{ name: string; filePath: string } | null>
  remove(name: string): Promise<boolean>
  update(
    name: string,
    updates: { filePath?: string; lastVerified?: string },
  ): Promise<boolean>
  exists(name: string): Promise<boolean>
  isPathRegistered(filePath: string): Promise<boolean>
  getByPath(
    filePath: string,
  ): Promise<{ name: string; filePath: string } | null>
  isFolderIgnored(folderPath: string): Promise<boolean>
  addIgnoreFolder(folderPath: string): Promise<void>
  removeIgnoreFolder(folderPath: string): Promise<boolean>
  listIgnoredFolders(): Promise<string[]>
}

/**
 * Get the registry for a file-based engine.
 * Throws if the engine is not file-based.
 */
export function getRegistryForEngine(engine: Engine): FileBasedRegistry {
  switch (engine) {
    case Engine.SQLite:
      return sqliteRegistry
    case Engine.DuckDB:
      return duckdbRegistry
    default:
      if (isFileBasedEngine(engine)) {
        throw new Error(
          `File-based engine "${engine}" has no registry configured in getRegistryForEngine()`,
        )
      }
      throw new Error(`"${engine}" is not a file-based engine`)
  }
}

// ============================================================
// Container Name Derivation
// ============================================================

/**
 * Derive a valid container name from a database filename.
 * Removes the engine-specific extension and sanitizes for use as a container name.
 *
 * - Must start with a letter
 * - Can contain letters, numbers, hyphens, underscores
 * - Falls back to engine-specific default if result is empty
 */
export function deriveContainerName(
  fileName: string,
  engine: Engine.SQLite | Engine.DuckDB,
): string {
  const extensionRegex = ENGINE_EXTENSION_REGEX[engine]
  const fallback = engine === Engine.SQLite ? 'sqlite-db' : 'duckdb-db'

  // Remove extension
  const base = fileName.replace(extensionRegex, '')

  // If nothing remains after extension removal, return engine-specific fallback
  const sanitizedBase = base
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!sanitizedBase) {
    return fallback
  }

  // Convert to valid container name (alphanumeric, hyphens, underscores)
  let name = base.replace(/[^a-zA-Z0-9_-]/g, '-')

  // Ensure starts with letter
  if (!/^[a-zA-Z]/.test(name)) {
    name = 'db-' + name
  }

  // Remove consecutive hyphens
  name = name.replace(/-+/g, '-')

  // Trim leading/trailing hyphens
  name = name.replace(/^-+|-+$/g, '')

  return name || fallback
}

// ============================================================
// File Scanning
// ============================================================

export type UnregisteredFile = {
  fileName: string
  absolutePath: string
}

/**
 * Scan a directory for unregistered file-based database files.
 *
 * @param engine The file-based engine to scan for
 * @param directory Directory to scan (defaults to CWD)
 * @returns Array of unregistered files
 */
export async function scanForUnregisteredFiles(
  engine: Engine.SQLite | Engine.DuckDB,
  directory: string = process.cwd(),
): Promise<UnregisteredFile[]> {
  const absoluteDir = resolve(directory)
  const registry = getRegistryForEngine(engine)
  const extensionRegex = ENGINE_EXTENSION_REGEX[engine]

  // Check if folder is ignored
  if (await registry.isFolderIgnored(absoluteDir)) {
    return []
  }

  // Check if directory exists
  if (!existsSync(absoluteDir)) {
    return []
  }

  try {
    const entries = await readdir(absoluteDir, { withFileTypes: true })

    const matchingFiles = entries
      .filter((e) => e.isFile())
      .filter((e) => extensionRegex.test(e.name))
      .map((e) => ({
        fileName: e.name,
        absolutePath: resolve(absoluteDir, e.name),
      }))

    const unregistered: UnregisteredFile[] = []
    for (const file of matchingFiles) {
      if (!(await registry.isPathRegistered(file.absolutePath))) {
        unregistered.push(file)
      }
    }

    return unregistered
  } catch {
    return []
  }
}
