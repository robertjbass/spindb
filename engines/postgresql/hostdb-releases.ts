/**
 * hostdb Releases Module for PostgreSQL
 *
 * Fetches PostgreSQL binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built PostgreSQL binaries for multiple platforms.
 */

import {
  POSTGRESQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from './version-maps'
import { compareVersions } from '../../core/version-utils'
import {
  fetchHostdbReleases as fetchReleases,
  clearCache as clearSharedCache,
  getEngineReleases,
  validatePlatform,
  buildDownloadUrl,
  type HostdbRelease,
  type HostdbReleasesData,
  type HostdbPlatform,
} from '../../core/hostdb-client'

// Re-export types for backwards compatibility
export type { HostdbRelease, HostdbReleasesData, HostdbPlatform }

// Re-export shared functions
export const clearCache = clearSharedCache
export const fetchHostdbReleases = fetchReleases

// Get available PostgreSQL versions from hostdb, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  try {
    const releases = await fetchHostdbReleases()
    const pgReleases = getEngineReleases(releases, 'postgresql')

    if (!pgReleases) {
      return getFallbackVersions()
    }

    // Group versions by major version
    const grouped: Record<string, string[]> = {}

    for (const major of SUPPORTED_MAJOR_VERSIONS) {
      grouped[major] = []

      // Find all versions matching this major version
      for (const [_versionKey, release] of Object.entries(pgReleases)) {
        if (release.version.startsWith(`${major}.`)) {
          grouped[major].push(release.version)
        }
      }

      // Sort descending (latest first)
      grouped[major].sort((a, b) => compareVersions(b, a))
    }

    return grouped
  } catch {
    // Fallback to version map on error
    return getFallbackVersions()
  }
}

// Get fallback versions when network is unavailable
function getFallbackVersions(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const major of SUPPORTED_MAJOR_VERSIONS) {
    grouped[major] = [POSTGRESQL_VERSION_MAP[major]]
  }
  return grouped
}

// Get the latest version for a major version from hostdb
export async function getLatestVersion(major: string): Promise<string> {
  const versions = await fetchAvailableVersions()
  const majorVersions = versions[major]
  if (majorVersions && majorVersions.length > 0) {
    return majorVersions[0] // First is latest due to descending sort
  }
  return POSTGRESQL_VERSION_MAP[major] || `${major}.0.0`
}

/**
 * Get the download URL for a PostgreSQL version from hostdb
 *
 * @param version - Full version (e.g., '17.7.0')
 * @param platform - Platform identifier (e.g., 'darwin', 'linux', 'win32')
 * @param arch - Architecture identifier (e.g., 'arm64', 'x64')
 * @returns Download URL for the binary
 */
export async function getHostdbDownloadUrl(
  version: string,
  platform: string,
  arch: string,
): Promise<string> {
  // Validate platform up-front so we fail fast for unsupported platforms
  const hostdbPlatform = validatePlatform(platform, arch)

  try {
    const releases = await fetchHostdbReleases()
    const pgReleases = getEngineReleases(releases, 'postgresql')

    if (!pgReleases) {
      throw new Error('PostgreSQL releases not found in hostdb')
    }

    // Find the version in releases
    const release = pgReleases[version]
    if (!release) {
      throw new Error(`Version ${version} not found in hostdb releases`)
    }

    // Get the platform-specific download URL
    const platformData = release.platforms[hostdbPlatform]
    if (!platformData) {
      throw new Error(
        `Platform ${hostdbPlatform} not available for PostgreSQL ${version}`,
      )
    }

    return platformData.url
  } catch {
    // Fallback to constructing URL manually if fetch fails
    return buildDownloadUrl('postgresql', version, platform, arch)
  }
}

/**
 * Check if a version is available in hostdb
 *
 * @param version - Version to check
 * @returns true if the version exists in hostdb releases
 */
export async function isVersionAvailable(version: string): Promise<boolean> {
  try {
    const releases = await fetchHostdbReleases()
    const pgReleases = getEngineReleases(releases, 'postgresql')
    return pgReleases ? version in pgReleases : false
  } catch {
    // Fallback to checking version map when network unavailable
    const major = version.split('.')[0]
    return (
      major in POSTGRESQL_VERSION_MAP ||
      POSTGRESQL_VERSION_MAP[major] === version
    )
  }
}
