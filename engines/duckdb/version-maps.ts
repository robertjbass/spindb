/**
 * DuckDB Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update DUCKDB_VERSION_MAP to match
 * 3. Update config/engine-defaults.ts supportedVersions array
 */

import { logWarning } from '../../core/error-handler'

/**
 * Map of major DuckDB versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const DUCKDB_VERSION_MAP: Record<string, string> = {
  // 1-part: major version → latest
  '1': '1.4.3',
  // 2-part: major.minor → latest patch
  '1.4': '1.4.3',
  // 3-part: exact version (identity mapping)
  '1.4.3': '1.4.3',
}

/**
 * Supported major DuckDB versions (1-part format).
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = ['1']

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '1')
 * @returns Full version string (e.g., '1.4.3') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return DUCKDB_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '1', '1.4', '1.4.3')
 * @returns Normalized version (e.g., '1.4.3')
 */
export function normalizeVersion(version: string): string {
  // If it's a version key in the map (major, major.minor, or full), return the mapped version
  // Identity mappings for 3-part versions (e.g., '1.4.3' -> '1.4.3') are already in the map
  const fullVersion = DUCKDB_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version - warn and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  logWarning(
    `DuckDB version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
