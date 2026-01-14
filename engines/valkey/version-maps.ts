/**
 * Valkey Version Maps
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * When updating versions:
 * 1. Check hostdb releases.json for available versions
 * 2. Update VALKEY_VERSION_MAP to match
 * 3. Update config/engine-defaults.ts supportedVersions array
 */

/**
 * Map of major Valkey versions to their latest stable patch versions.
 * Must match versions available in hostdb releases.json.
 */
export const VALKEY_VERSION_MAP: Record<string, string> = {
  // 1-part: major version -> latest
  '8': '8.0.6',
  '9': '9.0.1',
  // 2-part: major.minor -> latest patch
  '8.0': '8.0.6',
  '9.0': '9.0.1',
  // 3-part: exact version (identity mapping)
  '8.0.6': '8.0.6',
  '9.0.1': '9.0.1',
}

/**
 * Supported major Valkey versions (1-part format).
 * Used for grouping and display purposes.
 */
export const SUPPORTED_MAJOR_VERSIONS = ['8', '9']

/**
 * Get the full version string for a major version.
 *
 * @param majorVersion - Major version (e.g., '8', '9')
 * @returns Full version string (e.g., '8.0.6') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return VALKEY_VERSION_MAP[majorVersion] || null
}

/**
 * Normalize a version string to X.Y.Z format.
 *
 * @param version - Version string (e.g., '8', '8.0', '8.0.6')
 * @returns Normalized version (e.g., '8.0.6')
 */
export function normalizeVersion(version: string): string {
  // If it's a major version key in the map, return the full version
  const fullVersion = VALKEY_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // If it's already a known full version (a value in the map), return as-is
  const knownVersions = Object.values(VALKEY_VERSION_MAP)
  if (knownVersions.includes(version)) {
    return version
  }

  // If it looks like a full version (X.Y.Z), return as-is but warn
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    console.warn(
      `Valkey version '${version}' not in version map, may not be available in hostdb`,
    )
    return version
  }

  // Unknown version format - warn and return unchanged
  console.warn(
    `Valkey version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
