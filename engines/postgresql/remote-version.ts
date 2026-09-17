/**
 * Remote PostgreSQL Version Detection
 *
 * Detects the PostgreSQL version of a remote database from a connection string.
 * This is used to ensure we use compatible client tools for dump operations.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { configManager } from '../../core/config-manager'
import { logDebug } from '../../core/error-handler'

import { parsePostgresVersionToken } from './version-token'

const execAsync = promisify(exec)

export type RemoteVersionResult = {
  majorVersion: number
  minorVersion: number
  fullVersion: string
  serverType: 'postgresql' | 'aurora' | 'rds' | 'supabase' | 'neon' | 'unknown'
}

/**
 * Detect the PostgreSQL version of a remote database
 *
 * Uses psql to query the server's version information.
 * This works with all PostgreSQL-compatible databases including Aurora, RDS, Supabase, etc.
 */
export async function detectRemotePostgresVersion(
  connectionString: string,
): Promise<RemoteVersionResult> {
  const psqlPath = await configManager.getBinaryPath('psql')
  if (!psqlPath) {
    throw new Error(
      'psql not found - required for remote version detection.\n' +
        'Download PostgreSQL binaries: spindb engines download postgresql',
    )
  }

  // Query remote server version using psql
  // Use multiple settings to get comprehensive version info
  const sql = "SELECT version(), current_setting('server_version')"
  const cmd = `"${psqlPath}" "${connectionString}" -t -A -F "|||" -c "${sql}"`

  try {
    const { stdout } = await execAsync(cmd, { timeout: 30000 })
    const result = parseRemoteVersionOutput(stdout)

    logDebug('Remote PostgreSQL version detected', result)

    return result
  } catch (error) {
    const e = error as Error & { code?: string; killed?: boolean }

    // Handle timeout
    if (e.killed) {
      throw new Error(
        'Connection to remote database timed out after 30 seconds',
      )
    }

    // Handle common connection errors with helpful messages
    if (
      e.message.includes('could not connect') ||
      e.message.includes('Connection refused')
    ) {
      throw new Error(
        `Could not connect to remote database. Check your connection string and ensure the database is accessible.\n\nOriginal error: ${e.message}`,
      )
    }

    if (
      e.message.includes('password authentication failed') ||
      e.message.includes('authentication failed')
    ) {
      throw new Error(
        `Authentication failed. Check your username and password in the connection string.\n\nOriginal error: ${e.message}`,
      )
    }

    if (
      e.message.includes('database') &&
      e.message.includes('does not exist')
    ) {
      throw new Error(
        `Database does not exist. Check the database name in your connection string.\n\nOriginal error: ${e.message}`,
      )
    }

    if (e.message.includes('SSL')) {
      throw new Error(
        `SSL connection error. You may need to add ?sslmode=require or ?sslmode=disable to your connection string.\n\nOriginal error: ${e.message}`,
      )
    }

    // Re-throw with context
    throw new Error(`Failed to detect remote PostgreSQL version: ${e.message}`)
  }
}

/**
 * Parse the raw psql output of
 * `SELECT version(), current_setting('server_version')` (tuples-only,
 * unaligned, `|||` as the field separator) into the remote version result.
 * Pure, so the prerelease path (`19beta3`, which has no minor) is testable
 * without a server. Throws on output that is not two fields or whose
 * server_version carries no recognizable version.
 */
export function parseRemoteVersionOutput(stdout: string): RemoteVersionResult {
  const parts = stdout.trim().split('|||')

  if (parts.length < 2) {
    throw new Error(`Unexpected version output format: ${stdout}`)
  }

  const [versionString, serverVersion] = parts

  // Parse version from server_version (e.g., "16.1", "17.0", or a
  // prerelease such as "19beta3", which has no minor).
  const parsed = parsePostgresVersionToken(serverVersion)
  if (!parsed) {
    throw new Error(`Could not parse server version: ${serverVersion}`)
  }

  return {
    majorVersion: parsed.major,
    minorVersion: parsed.minor,
    fullVersion: parsed.full,
    // Detect server type from version() output
    serverType: detectServerType(versionString),
  }
}

// Detect the type of PostgreSQL server from version() output
function detectServerType(
  versionString: string,
): RemoteVersionResult['serverType'] {
  const lower = versionString.toLowerCase()

  if (lower.includes('aurora')) {
    return 'aurora'
  }
  if (lower.includes('rds') || lower.includes('amazon')) {
    return 'rds'
  }
  if (lower.includes('supabase')) {
    return 'supabase'
  }
  if (lower.includes('neon')) {
    return 'neon'
  }
  if (lower.includes('postgresql')) {
    return 'postgresql'
  }

  return 'unknown'
}

/**
 * Check if a local pg_dump version is compatible with a remote database version
 *
 * PostgreSQL is forward-compatible: pg_dump version X can dump databases from version <= X
 */
export function isVersionCompatible(
  localMajorVersion: number,
  remoteMajorVersion: number,
): boolean {
  return localMajorVersion >= remoteMajorVersion
}
