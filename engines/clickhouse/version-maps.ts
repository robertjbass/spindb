/**
 * ClickHouse Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update CLICKHOUSE_VERSION_MAP to match
 *
 * ClickHouse uses YY.MM.X.build versioning (e.g., 25.12.3.21)
 * We use the YY.MM format as the major version identifier.
 */

import { logDebug } from '../../core/error-handler'

/**
 * Map of ClickHouse versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const CLICKHOUSE_VERSION_MAP: Record<string, string> = {
  // 1-part: year -> latest release for that year
  '25': '25.12.3.21',
  // 2-part: year.month -> latest
  '25.12': '25.12.3.21',
  // 3-part: year.month.patch -> latest build
  '25.12.3': '25.12.3.21',
  // 4-part: exact version (identity mapping)
  '25.12.3.21': '25.12.3.21',
}

/**
 * Supported major ClickHouse versions (YY.MM format).
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = ['25.12']

/**
 * Get the full version string for a version.
 *
 * @param version - Version (e.g., '25.12', '25.12.3', '25.12.3.21')
 * @returns Full version string (e.g., '25.12.3.21') or null if not supported
 */
export function getFullVersion(version: string): string | null {
  return CLICKHOUSE_VERSION_MAP[version] || null
}

/**
 * Normalize a version string to full version format.
 *
 * @param version - Version string (e.g., '25.12', '25.12.3', '25.12.3.21')
 * @returns Normalized version (e.g., '25.12.3.21')
 */
export function normalizeVersion(version: string): string {
  // If it's in the version map, return the mapped value
  const fullVersion = CLICKHOUSE_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version - warn and return as-is
  const parts = version.split('.')

  // ClickHouse versions can be 2-4 parts (YY.MM, YY.MM.X, YY.MM.X.build)
  const isValidFormat =
    parts.length >= 2 &&
    parts.length <= 4 &&
    parts.every((p) => /^\d+$/.test(p))

  if (!isValidFormat) {
    logDebug(
      `ClickHouse version '${version}' has invalid format, may not be available in hostdb`,
    )
  } else {
    logDebug(
      `ClickHouse version '${version}' not in version map, may not be available in hostdb`,
    )
  }
  return version
}

/**
 * Get the major version (YY.MM) from a full version string.
 *
 * @param version - Full version (e.g., '25.12.3.21')
 * @returns Major version (e.g., '25.12')
 */
export function getMajorVersion(version: string): string {
  const parts = version.split('.')
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`
  }
  return version
}
