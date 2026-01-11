/**
 * MySQL Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update MYSQL_VERSION_MAP to match
 * 3. Update config/engine-defaults.ts supportedVersions array
 */

/**
 * Map of major MySQL versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const MYSQL_VERSION_MAP: Record<string, string> = {
  '8.0': '8.0.40',
  '8.4': '8.4.3',
  '9': '9.1.0',
}

/**
 * Supported major MySQL versions.
 * Derived from MYSQL_VERSION_MAP keys.
 */
export const SUPPORTED_MAJOR_VERSIONS = Object.keys(MYSQL_VERSION_MAP)

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '8.0', '9')
 * @returns Full version string (e.g., '8.0.40') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return MYSQL_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '8.0', '8.0.40', '9')
 * @returns Normalized version (e.g., '8.0.40', '9.1.0')
 */
export function normalizeVersion(version: string): string {
  // If it's in the map directly, use it (handles '9', '8.0', '8.4', etc.)
  const fullVersion = MYSQL_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // If it's already a full version (X.Y.Z), return as-is
  const parts = version.split('.')
  if (parts.length === 3) {
    return version
  }

  // Unknown version format - warn and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  console.warn(
    `MySQL version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
