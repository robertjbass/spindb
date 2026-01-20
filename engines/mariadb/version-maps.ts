/**
 * MariaDB Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update MARIADB_VERSION_MAP to match
 */

import { logDebug } from '../../core/error-handler'

/**
 * Map of major MariaDB versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const MARIADB_VERSION_MAP: Record<string, string> = {
  // 1-part: major version → LTS
  '10': '10.11.15',
  '11': '11.8.5',
  // 2-part: major.minor → latest patch
  '10.11': '10.11.15',
  '11.4': '11.4.5',
  '11.8': '11.8.5',
  // 3-part: exact version (identity mapping)
  '10.11.15': '10.11.15',
  '11.4.5': '11.4.5',
  '11.8.5': '11.8.5',
}

/**
 * Supported major MariaDB versions (2-part format).
 * Derived from MARIADB_VERSION_MAP keys to avoid duplication.
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = Object.keys(MARIADB_VERSION_MAP).filter(
  (key) => key.split('.').length === 2,
)

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '11.8')
 * @returns Full version string (e.g., '11.8.5') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return MARIADB_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '11.8', '11.8.5')
 * @returns Normalized version (e.g., '11.8.5')
 */
export function normalizeVersion(version: string): string {
  // If it's a version key in the map (major, major.minor, or full), return the mapped version
  // Identity mappings for 3-part versions (e.g., '11.8.5' -> '11.8.5') are already in the map
  const fullVersion = MARIADB_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version - log debug and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  logDebug(
    `MariaDB version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
