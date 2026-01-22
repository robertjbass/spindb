/**
 * Meilisearch Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update MEILISEARCH_VERSION_MAP to match
 */

import { logDebug } from '../../core/error-handler'

/**
 * Map of major Meilisearch versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const MEILISEARCH_VERSION_MAP: Record<string, string> = {
  // 1-part: major version -> latest
  '1': '1.33.1',
  // 2-part: major.minor -> latest patch
  '1.33': '1.33.1',
  // 3-part: exact version (identity mapping)
  '1.33.1': '1.33.1',
}

/**
 * Supported major Meilisearch versions (1-part format).
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = ['1']

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '1')
 * @returns Full version string (e.g., '1.33.1') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return MEILISEARCH_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '1', '1.33', '1.33.1')
 * @returns Normalized version (e.g., '1.33.1')
 */
export function normalizeVersion(version: string): string {
  // If it's in the version map (major, major.minor, or full version), return the mapped value
  // Note: Full versions have identity mappings (e.g., '1.33.1' => '1.33.1')
  const fullVersion = MEILISEARCH_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version - warn and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  const parts = version.split('.')

  // Validate format: must be 1-3 numeric segments (e.g., "1", "1.33", "1.33.1")
  const isValidFormat =
    parts.length >= 1 &&
    parts.length <= 3 &&
    parts.every((p) => /^\d+$/.test(p))

  if (!isValidFormat) {
    logDebug(
      `Meilisearch version '${version}' has invalid format, may not be available in hostdb`,
    )
  } else {
    logDebug(
      `Meilisearch version '${version}' not in version map, may not be available in hostdb`,
    )
  }
  return version
}
