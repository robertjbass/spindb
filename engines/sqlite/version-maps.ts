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
  // 1-part: major version → latest
  '3': '3.51.2',
  // 2-part: major.minor → latest patch
  '3.51': '3.51.2',
  // 3-part: exact version (identity mapping)
  '3.51.2': '3.51.2',
}

/**
 * Supported major SQLite versions (1-part format).
 * Used for grouping and display purposes.
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
  // If it's a version key in the map (major, major.minor, or full), return the mapped version
  // Identity mappings for 3-part versions (e.g., '3.51.2' -> '3.51.2') are already in the map
  const fullVersion = SQLITE_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version - warn and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  console.warn(
    `SQLite version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
