/**
 * ClickHouse CLI utilities
 * Shared utilities for interacting with the clickhouse binary
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { configManager } from '../../core/config-manager'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const CLICKHOUSE_NOT_FOUND_ERROR =
  'ClickHouse binary not found. Run: spindb engines download clickhouse <version>'

/**
 * Validate a ClickHouse identifier (database name, table name, etc.)
 * ClickHouse identifiers must:
 * - Start with a letter or underscore
 * - Contain only letters, digits, and underscores
 * - Not be a reserved word (basic check)
 *
 * @param identifier - The identifier to validate
 * @param type - Type of identifier for error messages (e.g., 'database', 'table')
 * @returns The validated identifier
 * @throws Error if the identifier is invalid
 */
export function validateClickHouseIdentifier(
  identifier: string,
  type: string = 'identifier',
): string {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error(`Invalid ${type}: must be a non-empty string`)
  }

  // ClickHouse identifier rules:
  // - Must start with a letter (a-z, A-Z) or underscore
  // - Can contain letters, digits, and underscores
  // - Maximum length of 255 characters
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/

  if (!validPattern.test(identifier)) {
    throw new Error(
      `Invalid ${type} "${identifier}": must start with a letter or underscore ` +
        `and contain only letters, digits, and underscores`,
    )
  }

  if (identifier.length > 255) {
    throw new Error(
      `Invalid ${type} "${identifier}": maximum length is 255 characters`,
    )
  }

  // Basic reserved word check (ClickHouse system databases)
  const reserved = ['system', 'information_schema']
  if (reserved.includes(identifier.toLowerCase())) {
    throw new Error(
      `Invalid ${type} "${identifier}": "${identifier}" is a reserved system name`,
    )
  }

  return identifier
}

/**
 * Escape a ClickHouse identifier for use in SQL queries
 * Uses backticks for escaping (ClickHouse supports both backticks and double quotes)
 *
 * @param identifier - The identifier to escape
 * @returns The escaped identifier wrapped in backticks
 */
export function escapeClickHouseIdentifier(identifier: string): string {
  // Replace any backticks in the identifier with escaped backticks
  const escaped = identifier.replace(/`/g, '``')
  return `\`${escaped}\``
}

/**
 * Get the path to the clickhouse binary
 * Checks config cache first, then falls back to downloaded binary path
 *
 * @param version - Optional version to look up specific binary
 * @returns Path to clickhouse binary, or null if not found
 */
export async function getClickHousePath(
  version?: string,
): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('clickhouse')
  if (cached && existsSync(cached)) {
    return cached
  }

  // If version provided, look for downloaded binary
  if (version) {
    const { platform, arch } = platformService.getPlatformInfo()
    const fullVersion = normalizeVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'clickhouse',
      version: fullVersion,
      platform,
      arch,
    })
    const clickhousePath = join(binPath, 'bin', 'clickhouse')
    if (existsSync(clickhousePath)) {
      return clickhousePath
    }
  }

  return null
}

/**
 * Get the path to the clickhouse binary, throwing if not found
 *
 * @param version - Optional version to look up specific binary
 * @returns Path to clickhouse binary
 * @throws Error if binary not found
 */
export async function requireClickHousePath(version?: string): Promise<string> {
  const path = await getClickHousePath(version)
  if (!path) {
    throw new Error(CLICKHOUSE_NOT_FOUND_ERROR)
  }
  return path
}

/**
 * Build a clickhouse client command for executing SQL
 *
 * @param clickhousePath - Path to clickhouse binary
 * @param port - Port to connect to
 * @param database - Database to use
 * @returns Array of command arguments
 */
export function buildClickHouseClientArgs(
  port: number,
  database: string,
): string[] {
  return [
    'client',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--database',
    database,
  ]
}

/**
 * Build clickhouse client command for executing a query
 *
 * @param port - Port to connect to
 * @param database - Database to use
 * @param query - SQL query to execute
 * @returns Array of command arguments
 */
export function buildClickHouseQueryArgs(
  port: number,
  database: string,
  query: string,
): string[] {
  return [
    'client',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--database',
    database,
    '--query',
    query,
  ]
}
