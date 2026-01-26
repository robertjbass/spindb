/**
 * CockroachDB CLI utilities
 *
 * Helper functions for working with CockroachDB command-line tools.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const COCKROACH_NOT_FOUND_ERROR =
  'CockroachDB binary not found. Run: spindb engines download cockroachdb <version>'

/**
 * Get the path to the cockroach binary
 *
 * First checks the config cache, then looks in the downloaded binaries directory.
 * Returns null if not found.
 */
export async function getCockroachPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('cockroach')
  if (cached && existsSync(cached)) {
    return cached
  }

  return null
}

/**
 * Get the cockroach binary path for a specific version
 */
export async function getCockroachPathForVersion(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  const ext = platformService.getExecutableExtension()

  const binPath = paths.getBinaryPath({
    engine: 'cockroachdb',
    version: fullVersion,
    platform,
    arch,
  })

  const cockroachPath = join(binPath, 'bin', `cockroach${ext}`)
  if (existsSync(cockroachPath)) {
    return cockroachPath
  }

  return null
}

/**
 * Require the cockroach binary path, throwing if not found
 */
export async function requireCockroachPath(
  version?: string,
): Promise<string> {
  // If version provided, look for that specific version
  if (version) {
    const path = await getCockroachPathForVersion(version)
    if (path) {
      return path
    }
  }

  // Try config cache
  const cached = await getCockroachPath()
  if (cached) {
    return cached
  }

  throw new Error(COCKROACH_NOT_FOUND_ERROR)
}

/**
 * Validate a CockroachDB identifier (database, table name)
 * CockroachDB uses PostgreSQL-style identifiers
 *
 * Valid identifiers:
 * - Start with letter or underscore
 * - Contain letters, digits, underscores
 * - Max 63 characters (PostgreSQL limit)
 *
 * @throws Error if identifier is invalid
 */
export function validateCockroachIdentifier(
  identifier: string,
  type: 'database' | 'table' | 'user' = 'database',
): void {
  if (!identifier) {
    throw new Error(`${type} name cannot be empty`)
  }

  if (identifier.length > 63) {
    throw new Error(`${type} name cannot exceed 63 characters`)
  }

  // PostgreSQL identifier rules
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
  if (!validPattern.test(identifier)) {
    throw new Error(
      `Invalid ${type} name "${identifier}". ` +
        `Must start with a letter or underscore and contain only letters, digits, and underscores.`,
    )
  }

  // Check for reserved words (subset of PostgreSQL reserved words)
  const reserved = [
    'all',
    'analyse',
    'analyze',
    'and',
    'any',
    'array',
    'as',
    'asc',
    'asymmetric',
    'both',
    'case',
    'cast',
    'check',
    'collate',
    'column',
    'constraint',
    'create',
    'current_catalog',
    'current_date',
    'current_role',
    'current_schema',
    'current_time',
    'current_timestamp',
    'current_user',
    'default',
    'deferrable',
    'desc',
    'distinct',
    'do',
    'else',
    'end',
    'except',
    'false',
    'fetch',
    'for',
    'foreign',
    'from',
    'grant',
    'group',
    'having',
    'in',
    'initially',
    'intersect',
    'into',
    'lateral',
    'leading',
    'limit',
    'localtime',
    'localtimestamp',
    'not',
    'null',
    'offset',
    'on',
    'only',
    'or',
    'order',
    'placing',
    'primary',
    'references',
    'returning',
    'select',
    'session_user',
    'some',
    'symmetric',
    'table',
    'then',
    'to',
    'trailing',
    'true',
    'union',
    'unique',
    'user',
    'using',
    'variadic',
    'when',
    'where',
    'window',
    'with',
  ]

  if (reserved.includes(identifier.toLowerCase())) {
    throw new Error(
      `"${identifier}" is a reserved word and cannot be used as a ${type} name`,
    )
  }
}

/**
 * Escape a CockroachDB identifier for use in SQL
 * Uses double quotes for PostgreSQL-style quoting
 */
export function escapeCockroachIdentifier(identifier: string): string {
  // Double any existing double quotes and wrap in double quotes
  return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * Escape a SQL value for use in INSERT statements
 * Handles strings, numbers, booleans, nulls, and special values
 */
export function escapeSqlValue(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return 'NULL'
  }

  // Check for explicit NULL string (from CSV output)
  if (value === 'NULL' || value === '\\N') {
    return 'NULL'
  }

  // Check for boolean values
  const lowerValue = value.toLowerCase()
  if (lowerValue === 'true' || lowerValue === 't') {
    return 'TRUE'
  }
  if (lowerValue === 'false' || lowerValue === 'f') {
    return 'FALSE'
  }

  // Check if it's a number (integer or decimal)
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return value
  }

  // For strings: escape single quotes by doubling them
  const escaped = value.replace(/'/g, "''")
  return `'${escaped}'`
}

/**
 * Parse a CSV line respecting quoted fields
 * Handles fields that contain commas, quotes, and newlines
 */
export function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote (double quote)
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++ // Skip next quote
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        result.push(current)
        current = ''
      } else {
        current += char
      }
    }
  }

  result.push(current)
  return result
}

/**
 * Check if a connection string indicates an insecure (non-SSL) connection
 */
export function isInsecureConnection(connectionString: string): boolean {
  try {
    const url = new URL(connectionString)
    const sslmode = url.searchParams.get('sslmode')
    const host = url.hostname.toLowerCase()
    // Handle both regular hostnames and bracketed IPv6 addresses
    const isLocalhost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)

    // Explicit disable means insecure
    if (sslmode === 'disable') {
      return true
    }

    // Localhost without explicit SSL settings defaults to insecure for local dev
    if (isLocalhost && !sslmode) {
      return true
    }

    // Any SSL mode other than 'disable' means secure
    return false
  } catch {
    // If we can't parse it, assume secure (safer default)
    return false
  }
}
