/**
 * TypeDB CLI utilities
 *
 * Helper functions for working with TypeDB command-line tools.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const TYPEDB_NOT_FOUND_ERROR =
  'TypeDB binary not found. Run: spindb engines download typedb <version>'

/** Default TypeDB credentials (TypeDB 3.x requires authentication) */
export const TYPEDB_DEFAULT_USERNAME = 'admin'
export const TYPEDB_DEFAULT_PASSWORD = 'password'

/**
 * Get standard TypeDB console connection arguments including authentication.
 * TypeDB 3.x requires --username and --password for all console operations.
 *
 * @param tlsDisabled - When true (the default for local dev), appends --tls-disabled.
 *   Pass false when connecting to a TLS-enabled TypeDB server.
 */
export function getConsoleBaseArgs(
  port: number,
  host = '127.0.0.1',
  tlsDisabled = true,
): string[] {
  const args = [
    '--address',
    `${host}:${port}`,
    ...(tlsDisabled ? ['--tls-disabled'] : []),
    '--username',
    TYPEDB_DEFAULT_USERNAME,
    '--password',
    TYPEDB_DEFAULT_PASSWORD,
  ]
  return args
}

/**
 * Get the path to the typedb launcher binary
 *
 * First checks the config cache, then scans the downloaded binaries directory.
 * Returns null if not found.
 */
export async function getTypeDBPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('typedb')
  if (cached && existsSync(cached)) {
    return cached
  }

  // Fall back to filesystem scan using the same logic as getTypeDBPathForVersion
  const { TYPEDB_VERSION_MAP } = await import('./version-maps')
  for (const version of Object.values(TYPEDB_VERSION_MAP)) {
    const found = await getTypeDBPathForVersion(version)
    if (found) {
      return found
    }
  }

  return null
}

/**
 * Get the typedb binary path for a specific version
 */
export async function getTypeDBPathForVersion(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  // TypeDB launcher is a .bat script on Windows, no extension on other platforms
  const batExt = platform === 'win32' ? '.bat' : ''

  const binPath = paths.getBinaryPath({
    engine: 'typedb',
    version: fullVersion,
    platform,
    arch,
  })

  const typedbPath = join(binPath, 'bin', `typedb${batExt}`)
  if (existsSync(typedbPath)) {
    return typedbPath
  }

  return null
}

/**
 * Get the typedb_console_bin path for a specific version
 */
export async function getTypeDBConsolePath(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  const ext = platformService.getExecutableExtension()

  const binPath = paths.getBinaryPath({
    engine: 'typedb',
    version: fullVersion,
    platform,
    arch,
  })

  const consolePath = join(
    binPath,
    'bin',
    'console',
    `typedb_console_bin${ext}`,
  )
  if (existsSync(consolePath)) {
    return consolePath
  }

  return null
}

/**
 * Require the typedb binary path, throwing if not found
 */
export async function requireTypeDBPath(version?: string): Promise<string> {
  // If version provided, look for that specific version
  if (version) {
    const path = await getTypeDBPathForVersion(version)
    if (path) {
      return path
    }
  }

  // Try config cache
  const cached = await getTypeDBPath()
  if (cached) {
    return cached
  }

  throw new Error(TYPEDB_NOT_FOUND_ERROR)
}

/**
 * Require the typedb_console_bin path, throwing if not found
 */
export async function requireTypeDBConsolePath(
  version?: string,
): Promise<string> {
  if (version) {
    const path = await getTypeDBConsolePath(version)
    if (path) {
      return path
    }
  }

  // Try config cache
  const cached = await configManager.getBinaryPath('typedb_console_bin')
  if (cached && existsSync(cached)) {
    return cached
  }

  throw new Error(
    'TypeDB console binary not found. Run: spindb engines download typedb <version>',
  )
}

/**
 * Validate a TypeDB identifier (database name)
 * TypeDB identifiers follow specific rules:
 * - Start with letter or underscore
 * - Contain letters, digits, underscores, dashes
 * - Max 63 characters
 *
 * @throws Error if identifier is invalid
 */
export function validateTypeDBIdentifier(
  identifier: string,
  type: 'database' = 'database',
): void {
  if (!identifier) {
    throw new Error(`${type} name cannot be empty`)
  }

  if (identifier.length > 63) {
    throw new Error(`${type} name cannot exceed 63 characters`)
  }

  // TypeDB allows alphanumeric, underscores, and dashes
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/
  if (!validPattern.test(identifier)) {
    throw new Error(
      `Invalid ${type} name "${identifier}". ` +
        `Must start with a letter or underscore and contain only letters, digits, underscores, and dashes.`,
    )
  }
}
