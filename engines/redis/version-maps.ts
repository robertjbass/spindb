/**
 * Redis Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update REDIS_VERSION_MAP to match
 */

import { logDebug } from '../../core/error-handler'

/**
 * Map of major Redis versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const REDIS_VERSION_MAP: Record<string, string> = {
  // 1-part: major version → latest
  '7': '7.4.7',
  '8': '8.4.0',
  // 2-part: major.minor → latest patch
  '7.4': '7.4.7',
  '8.4': '8.4.0',
  // 3-part: exact version (identity mapping)
  '7.4.7': '7.4.7',
  '8.4.0': '8.4.0',
}

/**
 * Supported major Redis versions (1-part format).
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = ['7', '8']

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '7', '8')
 * @returns Full version string (e.g., '7.4.7') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return REDIS_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '7', '7.4', '7.4.7')
 * @returns Normalized version (e.g., '7.4.7')
 */
export function normalizeVersion(version: string): string {
  // If it's in the version map (major, major.minor, or full version), return the mapped value
  // Note: Full versions have identity mappings (e.g., '7.4.7' => '7.4.7')
  const fullVersion = REDIS_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version - warn and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  const parts = version.split('.')

  // Validate format: must be 1-3 numeric segments (e.g., "7", "7.4", "7.4.7")
  const isValidFormat =
    parts.length >= 1 &&
    parts.length <= 3 &&
    parts.every((p) => /^\d+$/.test(p))

  if (!isValidFormat) {
    logDebug(
      `Redis version '${version}' has invalid format, may not be available in hostdb`,
    )
  } else {
    logDebug(
      `Redis version '${version}' not in version map, may not be available in hostdb`,
    )
  }
  return version
}
