/**
 * MongoDB version mapping
 *
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * To update: Check releases.json, find databases.mongodb, copy all version strings.
 */

/**
 * Map major versions to full versions
 * Keys are major.minor versions (e.g., "7.0", "8.0", "8.2")
 * Values are full versions from hostdb releases.json
 */
export const MONGODB_VERSION_MAP: Record<string, string> = {
  '7.0': '7.0.28',
  '8.0': '8.0.17',
  '8.2': '8.2.3',
}

// List of supported major versions
export const SUPPORTED_MAJOR_VERSIONS = Object.keys(MONGODB_VERSION_MAP)

/**
 * Fallback map of major versions to stable patch versions
 * Used when hostdb repository is unreachable
 */
export const FALLBACK_VERSION_MAP: Record<string, string> = MONGODB_VERSION_MAP

/**
 * Get the full version for a major version
 * @param majorVersion - Major version (e.g., "7.0", "8.0")
 * @returns Full version or null if not found
 */
export function getFullVersion(majorVersion: string): string | null {
  // Try exact match first
  if (MONGODB_VERSION_MAP[majorVersion]) {
    return MONGODB_VERSION_MAP[majorVersion]
  }

  // Try matching major only (e.g., "8" -> highest 8.x version)
  const majorOnly = majorVersion.split('.')[0]
  const matchingVersions = Object.entries(MONGODB_VERSION_MAP)
    .filter(([key]) => key.split('.')[0] === majorOnly)
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))

  if (matchingVersions.length > 0) {
    return matchingVersions[0][1]
  }

  return null
}

/**
 * Normalize a version string to a full version
 * @param version - Version string (major, major.minor, or full)
 * @returns Full version string
 */
export function normalizeVersion(version: string): string {
  // If already a full version (x.y.z), return as-is
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    return version
  }

  // Delegate to getFullVersion for major/major.minor lookup
  const fullVersion = getFullVersion(version)
  if (fullVersion) {
    return fullVersion
  }

  // Unknown version format - warn and return as-is
  // This may cause download failures if the version doesn't exist in hostdb
  console.warn(
    `MongoDB version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}
