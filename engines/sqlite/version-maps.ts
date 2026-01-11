/**
 * SQLite Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update SQLITE_VERSION_MAP to match
 * 3. Update config/engine-defaults.ts supportedVersions array
 */

/**
 * Map of major SQLite versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const SQLITE_VERSION_MAP: Record<string, string> = {
  '3': '3.51.2',
  '3.51': '3.51.2',
}

/**
 * Supported major SQLite versions.
 * SQLite uses major version 3 for all modern releases.
 */
export const SUPPORTED_MAJOR_VERSIONS = ['3']

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '3')
 * @returns Full version string (e.g., '3.51.2') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return SQLITE_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '3', '3.51', '3.51.2')
 * @returns Normalized version (e.g., '3.51.2')
 */
export function normalizeVersion(version: string): string {
  // If it's in the map directly, use it
  const fullVersion = SQLITE_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // If it has less than 3 parts, try to find matching entry
  const parts = version.split('.')
  if (parts.length === 1) {
    // Single number like '3' - already checked above, not in map
    return `${version}.0.0`
  } else if (parts.length === 2) {
    // Two parts like '3.51' - try to find by major version
    const major = parts[0]
    const mapped = SQLITE_VERSION_MAP[major]
    if (mapped) {
      return mapped
    }
    // Default to adding .0 if not in map
    return `${version}.0`
  }

  return version
}
