/**
 * hostdb Releases Module for Redis
 *
 * Fetches Redis binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built Redis binaries for multiple platforms.
 */

import { REDIS_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { compareVersions } from '../../core/version-utils'
import { logDebug } from '../../core/error-handler'
import { redisBinaryManager } from './binary-manager'
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

// Get available Redis versions from hostdb, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Try to fetch from hostdb first
  try {
    const releases = await fetchHostdbReleases()
    const redisReleases = getEngineReleases(releases, 'redis')

    if (redisReleases && Object.keys(redisReleases).length > 0) {
      // Group versions by major version
      const grouped: Record<string, string[]> = {}

      for (const major of SUPPORTED_MAJOR_VERSIONS) {
        grouped[major] = []

        // Find all versions matching this major version
        for (const [_versionKey, release] of Object.entries(redisReleases)) {
          // Redis uses single digit major versions (e.g., 7.4.7 matches 7)
          const versionParts = release.version.split('.')
          const releaseMajor = versionParts[0]

          if (releaseMajor === major) {
            grouped[major].push(release.version)
          }
        }

        // Sort descending (latest first)
        grouped[major].sort((a, b) => compareVersions(b, a))
      }

      return grouped
    }
  } catch (error) {
    logDebug('Failed to fetch Redis versions from hostdb, checking local', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Offline fallback: return only locally installed versions
  const installed = await redisBinaryManager.listInstalled()
  if (installed.length > 0) {
    const result: Record<string, string[]> = {}
    for (const binary of installed) {
      // Redis uses single digit major versions
      const major = binary.version.split('.')[0]
      if (!result[major]) {
        result[major] = []
      }
      if (!result[major].includes(binary.version)) {
        result[major].push(binary.version)
      }
    }
    // Sort each major version group descending
    for (const major of Object.keys(result)) {
      result[major].sort((a, b) => compareVersions(b, a))
    }
    return result
  }

  // Last resort: return hardcoded version map
  return getHardcodedVersions()
}

// Get hardcoded versions as last resort fallback
function getHardcodedVersions(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const major of SUPPORTED_MAJOR_VERSIONS) {
    grouped[major] = [REDIS_VERSION_MAP[major]]
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
  return REDIS_VERSION_MAP[major] || `${major}.0.0`
}

/**
 * Get the download URL for a Redis version from hostdb
 *
 * @param version - Full version (e.g., '7.4.7')
 * @param platform - Platform identifier (e.g., 'darwin', 'linux')
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
    const redisReleases = getEngineReleases(releases, 'redis')

    if (!redisReleases) {
      throw new Error('Redis releases not found in hostdb')
    }

    // Find the version in releases
    const release = redisReleases[version]
    if (!release) {
      throw new Error(`Version ${version} not found in hostdb releases`)
    }

    // Get the platform-specific download URL
    const platformData = release.platforms[hostdbPlatform]
    if (!platformData) {
      throw new Error(
        `Platform ${hostdbPlatform} not available for Redis ${version}`,
      )
    }

    return platformData.url
  } catch {
    // Fallback to constructing URL manually if fetch fails
    return buildDownloadUrl('redis', version, platform, arch)
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
    const redisReleases = getEngineReleases(releases, 'redis')
    return redisReleases ? version in redisReleases : false
  } catch {
    // Fallback to checking version map
    // Handle both major versions ("7") and full versions ("7.4.7")
    const major = version.split('.')[0]
    return version in REDIS_VERSION_MAP || REDIS_VERSION_MAP[major] === version
  }
}
