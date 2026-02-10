/**
 * InfluxDB Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update INFLUXDB_VERSION_MAP to match
 */

import { logDebug } from '../../core/error-handler'

/**
 * Map of major InfluxDB versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const INFLUXDB_VERSION_MAP: Record<string, string> = {
  // 1-part: major version -> latest
  '3': '3.8.0',
  // 2-part: major.minor -> latest patch
  '3.8': '3.8.0',
  // 3-part: exact version (identity mapping)
  '3.8.0': '3.8.0',
}

/**
 * Supported major InfluxDB versions (1-part format).
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = ['3']

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '3')
 * @returns Full version string (e.g., '3.8.0') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return INFLUXDB_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '3', '3.8', '3.8.0')
 * @returns Normalized version (e.g., '3.8.0')
 */
export function normalizeVersion(version: string): string {
  // If it's in the version map (major, major.minor, or full version), return the mapped value
  const fullVersion = INFLUXDB_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version - warn and return as-is
  const parts = version.split('.')

  const isValidFormat =
    parts.length >= 1 &&
    parts.length <= 3 &&
    parts.every((p) => /^\d+$/.test(p))

  if (!isValidFormat) {
    logDebug(
      `InfluxDB version '${version}' has invalid format, may not be available in hostdb`,
    )
  } else {
    logDebug(
      `InfluxDB version '${version}' not in version map, may not be available in hostdb`,
    )
  }
  return version
}
