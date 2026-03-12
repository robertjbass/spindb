/**
 * libSQL Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update LIBSQL_VERSION_MAP to match
 */

import { logDebug } from '../../core/error-handler'

/**
 * Map of major libSQL versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const LIBSQL_VERSION_MAP: Record<string, string> = {
  // 1-part: major version -> latest
  '0': '0.24.32',
  // 2-part: major.minor -> latest patch
  '0.24': '0.24.32',
  // 3-part: exact version (identity mapping)
  '0.24.32': '0.24.32',
}

/**
 * Supported major libSQL versions (1-part format).
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = ['0']

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '0')
 * @returns Full version string (e.g., '0.24.32') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return LIBSQL_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '0', '0.24', '0.24.32')
 * @returns Normalized version (e.g., '0.24.32')
 */
export function normalizeVersion(version: string): string {
  const fullVersion = LIBSQL_VERSION_MAP[version]
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
      `libSQL version '${version}' has invalid format, may not be available in hostdb`,
    )
  } else {
    logDebug(
      `libSQL version '${version}' not in version map, may not be available in hostdb`,
    )
  }
  return version
}
