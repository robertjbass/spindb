/**
 * TigerBeetle Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update TIGERBEETLE_VERSION_MAP to match
 */

import { logDebug } from '../../core/error-handler'

/**
 * Map of major TigerBeetle versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 *
 * TigerBeetle uses xy-format grouping (like MariaDB/ClickHouse):
 * 0.16.70 groups as "0.16"
 */
export const TIGERBEETLE_VERSION_MAP: Record<string, string> = {
  // 1-part: major version → latest
  '0': '0.16.70',
  // 2-part: major.minor → latest patch
  '0.16': '0.16.70',
  // 3-part: exact version (identity mapping)
  '0.16.70': '0.16.70',
}

/**
 * Supported major TigerBeetle versions (2-part format).
 * Derived from TIGERBEETLE_VERSION_MAP keys to avoid duplication.
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = Object.keys(
  TIGERBEETLE_VERSION_MAP,
).filter((key) => key.split('.').length === 2)

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '0.16')
 * @returns Full version string (e.g., '0.16.70') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return TIGERBEETLE_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '0', '0.16', '0.16.70')
 * @returns Normalized version (e.g., '0.16.70')
 */
export function normalizeVersion(version: string): string {
  // If it's a version key in the map (major, major.minor, or full), return the mapped version
  const fullVersion = TIGERBEETLE_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version - log debug and return as-is
  logDebug(
    `TigerBeetle version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
