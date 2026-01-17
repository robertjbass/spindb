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
