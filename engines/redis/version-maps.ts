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
 * 3. Update config/engine-defaults.ts supportedVersions array
 */

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
  // If it's a major version key in the map, return the full version
  const fullVersion = REDIS_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // If it's already a known full version (a value in the map), return as-is
  const knownVersions = Object.values(REDIS_VERSION_MAP)
  if (knownVersions.includes(version)) {
    return version
  }

  // If it looks like a full version (X.Y.Z), return as-is but warn
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    console.warn(
      `Redis version '${version}' not in version map, may not be available in hostdb`,
    )
    return version
  }

  // Unknown version format - warn and return unchanged
  console.warn(
    `Redis version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
