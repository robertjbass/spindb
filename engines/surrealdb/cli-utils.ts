/**
 * SurrealDB CLI utilities
 *
 * Helper functions for working with SurrealDB command-line tools.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const SURREAL_NOT_FOUND_ERROR =
  'SurrealDB binary not found. Run: spindb engines download surrealdb <version>'

/**
 * Get the path to the surreal binary
 *
 * First checks the config cache, then looks in the downloaded binaries directory.
 * Returns null if not found.
 */
export async function getSurrealPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('surreal')
  if (cached && existsSync(cached)) {
    return cached
  }

  return null
}

/**
 * Get the surreal binary path for a specific version
 */
export async function getSurrealPathForVersion(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  const ext = platformService.getExecutableExtension()

  const binPath = paths.getBinaryPath({
    engine: 'surrealdb',
    version: fullVersion,
    platform,
    arch,
  })

  const surrealPath = join(binPath, 'bin', `surreal${ext}`)
  if (existsSync(surrealPath)) {
    return surrealPath
  }

  return null
}

/**
 * Require the surreal binary path, throwing if not found
 */
export async function requireSurrealPath(version?: string): Promise<string> {
  // If version provided, look for that specific version
  if (version) {
    const path = await getSurrealPathForVersion(version)
    if (path) {
      return path
    }
  }

  // Try config cache
  const cached = await getSurrealPath()
  if (cached) {
    return cached
  }

  throw new Error(SURREAL_NOT_FOUND_ERROR)
}

/**
 * Validate a SurrealDB identifier (namespace, database, table name)
 * SurrealDB identifiers follow specific rules
 *
 * Valid identifiers:
 * - Start with letter or underscore
 * - Contain letters, digits, underscores
 * - Max 63 characters
 *
 * @throws Error if identifier is invalid
 */
export function validateSurrealIdentifier(
  identifier: string,
  type: 'namespace' | 'database' | 'table' = 'database',
): void {
  if (!identifier) {
    throw new Error(`${type} name cannot be empty`)
  }

  if (identifier.length > 63) {
    throw new Error(`${type} name cannot exceed 63 characters`)
  }

  // SurrealDB identifier rules
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
  if (!validPattern.test(identifier)) {
    throw new Error(
      `Invalid ${type} name "${identifier}". ` +
        `Must start with a letter or underscore and contain only letters, digits, and underscores.`,
    )
  }

  // Check for reserved words
  const reserved = [
    'namespace',
    'database',
    'table',
    'field',
    'index',
    'event',
    'param',
    'function',
    'token',
    'scope',
    'true',
    'false',
    'null',
    'none',
    'and',
    'or',
    'not',
    'if',
    'then',
    'else',
    'for',
    'in',
    'where',
    'select',
    'from',
    'create',
    'update',
    'delete',
    'insert',
    'define',
    'remove',
    'begin',
    'commit',
    'cancel',
    'return',
    'let',
    'use',
    'info',
    'live',
    'kill',
    'sleep',
    'throw',
    'break',
    'continue',
  ]

  if (reserved.includes(identifier.toLowerCase())) {
    throw new Error(
      `"${identifier}" is a reserved word and cannot be used as a ${type} name`,
    )
  }
}

/**
 * Escape a SurrealDB identifier for use in SurrealQL
 * Uses backticks for quoting
 */
export function escapeSurrealIdentifier(identifier: string): string {
  // Escape any backticks and wrap in backticks
  return `\`${identifier.replace(/`/g, '\\`')}\``
}
