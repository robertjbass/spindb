/**
 * PostgreSQL Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update POSTGRESQL_VERSION_MAP to match
 * 3. Update config/engine-defaults.ts supportedVersions array
 */

/**
 * Map of major PostgreSQL versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const POSTGRESQL_VERSION_MAP: Record<string, string> = {
  '15': '15.15.0',
  '16': '16.11.0',
  '17': '17.7.0',
  '18': '18.1.0',
}

/**
 * Supported major PostgreSQL versions.
 * Derived from POSTGRESQL_VERSION_MAP keys.
 */
export const SUPPORTED_MAJOR_VERSIONS = Object.keys(POSTGRESQL_VERSION_MAP)

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '17')
 * @returns Full version string (e.g., '17.7.0') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return POSTGRESQL_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '17', '17.7', '17.7.0')
 * @returns Normalized version (e.g., '17.7.0')
 */
export function normalizeVersion(version: string): string {
  // If it's in the map directly, use it
  const fullVersion = POSTGRESQL_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Version not in map - warn and return unchanged
  // Don't silently modify user input by appending zeros
  console.warn(
    `PostgreSQL version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
