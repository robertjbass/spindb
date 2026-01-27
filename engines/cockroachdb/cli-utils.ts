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
 *
 * If a version is provided, only that specific version is checked.
 * If no version is provided, falls back to the config cache.
 */
export async function requireCockroachPath(
  version?: string,
): Promise<string> {
  // If version provided, require that specific version (no fallback)
  if (version) {
    const path = await getCockroachPathForVersion(version)
    if (path) {
      return path
    }
    throw new Error(
      `CockroachDB ${version} binary not found. Run: spindb engines download cockroachdb ${version}`,
    )
  }

  // No version specified - try config cache
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
 *
 * Always outputs string literals for non-NULL values to avoid type inference
 * issues (e.g., "001" becoming 1, or "true" becoming a boolean). The database
 * will handle implicit type coercion when inserting strings into typed columns.
 *
 * @param value - The value to escape
 * @param wasQuoted - Whether the value was quoted in the original CSV (preserves empty strings)
 */
export function escapeSqlValue(
  value: string | null | undefined,
  wasQuoted = false,
): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }

  // Empty string: only treat as NULL if it was NOT quoted in CSV
  // Quoted empty strings ("") should be preserved as empty strings
  // CockroachDB CSV output uses empty unquoted fields for NULL values
  if (value === '' && !wasQuoted) {
    return 'NULL'
  }

  // Always output as string literal - escape single quotes by doubling them
  const escaped = value.replace(/'/g, "''")
  return `'${escaped}'`
}

/**
 * Represents a parsed CSV field with its value and quoting information
 */
export type CsvField = {
  value: string
  wasQuoted: boolean
}

/**
 * Parse multi-line CSV data into individual records (rows)
 * Respects quoted fields that may contain embedded newlines
 * Returns an array of complete CSV record strings (one per row)
 *
 * @param csvData - The raw CSV output from a query
 * @param skipHeader - If true, skips the first record (header row)
 * @returns Array of complete CSV record strings
 */
export function parseCsvRecords(csvData: string, skipHeader = false): string[] {
  const records: string[] = []
  let currentRecord = ''
  let inQuotes = false

  for (let i = 0; i < csvData.length; i++) {
    const char = csvData[i]

    if (inQuotes) {
      currentRecord += char
      if (char === '"') {
        // Check for escaped quote (double quote)
        if (i + 1 < csvData.length && csvData[i + 1] === '"') {
          currentRecord += csvData[i + 1]
          i++ // Skip next quote
        } else {
          inQuotes = false
        }
      }
    } else {
      if (char === '"') {
        inQuotes = true
        currentRecord += char
      } else if (char === '\n') {
        // End of record (unless we're in quotes, handled above)
        const trimmed = currentRecord.trim()
        if (trimmed) {
          records.push(trimmed)
        }
        currentRecord = ''
      } else if (char === '\r') {
        // Skip carriage return (handle \r\n line endings)
        continue
      } else {
        currentRecord += char
      }
    }
  }

  // Don't forget the last record if there's no trailing newline
  const trimmed = currentRecord.trim()
  if (trimmed) {
    records.push(trimmed)
  }

  // Skip header if requested
  return skipHeader ? records.slice(1) : records
}

/**
 * Parse a CSV line respecting quoted fields
 * Handles fields that contain commas, quotes, and newlines
 * Returns both the value and whether it was quoted (to preserve empty string semantics)
 */
export function parseCsvLine(line: string): CsvField[] {
  const result: CsvField[] = []
  let current = ''
  let inQuotes = false
  let fieldWasQuoted = false

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
        fieldWasQuoted = true
      } else if (char === ',') {
        result.push({ value: current, wasQuoted: fieldWasQuoted })
        current = ''
        fieldWasQuoted = false
      } else {
        current += char
      }
    }
  }

  result.push({ value: current, wasQuoted: fieldWasQuoted })
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
