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
 * 3. Update config/engine-defaults.ts supportedVersions array
 */

/**
 * Map of major MariaDB versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const MARIADB_VERSION_MAP: Record<string, string> = {
  '10.11': '10.11.15',
  '11.4': '11.4.5',
  '11.8': '11.8.5',
}

/**
 * Supported major MariaDB versions.
 * Derived from MARIADB_VERSION_MAP keys.
 */
export const SUPPORTED_MAJOR_VERSIONS = Object.keys(MARIADB_VERSION_MAP)

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
  // If it's a major version only, use the map
  const fullVersion = MARIADB_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // If it has two parts, try to find matching entry
  const parts = version.split('.')
  if (parts.length === 2) {
    const mapped = MARIADB_VERSION_MAP[version]
    if (mapped) {
      return mapped
    }
    // Default to adding .0 if not in map
    return `${version}.0`
  }

  return version
}
