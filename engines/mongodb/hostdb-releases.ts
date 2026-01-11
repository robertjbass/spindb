/**
 * MongoDB hostdb releases integration
 *
 * Fetches available MongoDB versions from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built MongoDB binaries for multiple platforms.
 */

import { logDebug } from '../../core/error-handler'
import { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'
import { isNewerVersion } from '../../core/version-utils'
import { mongodbBinaryManager } from './binary-manager'
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

/**
 * Fetch available MongoDB versions from hostdb
 * Falls back to locally installed versions, then hardcoded version map
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string>
> {
  // Try to fetch from hostdb first
  try {
    const releases = await fetchHostdbReleases()
    const mongodbReleases = getEngineReleases(releases, 'mongodb')

    if (mongodbReleases && Object.keys(mongodbReleases).length > 0) {
      const versionMap: Record<string, string> = {}

      // Iterate over version keys (e.g., "7.0.28", "8.0.17", "8.2.3")
      for (const fullVersion of Object.keys(mongodbReleases)) {
        // Extract major.minor (e.g., "7.0.28" -> "7.0")
        const parts = fullVersion.split('.')
        if (parts.length >= 2) {
          const majorMinor = `${parts[0]}.${parts[1]}`
          // Keep the latest full version for each major.minor
          if (
            !versionMap[majorMinor] ||
            isNewerVersion(fullVersion, versionMap[majorMinor])
          ) {
            versionMap[majorMinor] = fullVersion
          }
        }
      }

      logDebug('Fetched MongoDB versions from hostdb', { versions: versionMap })
      return versionMap
    }
  } catch (error) {
    logDebug('Failed to fetch MongoDB versions from hostdb, checking local', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Offline fallback: return only locally installed versions
  const installed = await mongodbBinaryManager.listInstalled()
  if (installed.length > 0) {
    const versionMap: Record<string, string> = {}
    for (const binary of installed) {
      // MongoDB uses X.Y format for major versions
      const parts = binary.version.split('.')
      if (parts.length >= 2) {
        const majorMinor = `${parts[0]}.${parts[1]}`
        // Keep the latest full version for each major.minor
        if (
          !versionMap[majorMinor] ||
          isNewerVersion(binary.version, versionMap[majorMinor])
        ) {
          versionMap[majorMinor] = binary.version
        }
      }
    }
    logDebug('Using locally installed MongoDB versions', {
      versions: versionMap,
    })
    return versionMap
  }

  // Last resort: return hardcoded version map
  logDebug('Using fallback MongoDB version map')
  return FALLBACK_VERSION_MAP
}

// Get the latest full version for a major.minor version
export async function getLatestVersion(
  majorMinor: string,
): Promise<string | null> {
  const versions = await fetchAvailableVersions()
  return versions[majorMinor] || null
}

/**
 * Get the download URL for a MongoDB version from hostdb
 *
 * @param version - Full version (e.g., '7.0.28')
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
    const mongodbReleases = getEngineReleases(releases, 'mongodb')

    if (!mongodbReleases) {
      throw new Error('MongoDB releases not found in hostdb')
    }

    // Find the version in releases
    const release = mongodbReleases[version]
    if (!release) {
      throw new Error(`Version ${version} not found in hostdb releases`)
    }

    // Get the platform-specific download URL
    const platformData = release.platforms[hostdbPlatform]
    if (!platformData) {
      throw new Error(
        `Platform ${hostdbPlatform} not available for MongoDB ${version}`,
      )
    }

    return platformData.url
  } catch (error) {
    // Log the error before falling back to manual URL construction
    const errorMessage = error instanceof Error ? error.message : String(error)
    logDebug(
      `Failed to fetch MongoDB ${version} URL from hostdb for ${platform}-${arch}: ${errorMessage}. Using fallback URL.`,
    )

    // Fallback to constructing URL manually if fetch fails
    return buildDownloadUrl('mongodb', version, platform, arch)
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
    const mongodbReleases = getEngineReleases(releases, 'mongodb')
    return mongodbReleases ? version in mongodbReleases : false
  } catch {
    // Fallback to checking version map
    // Handle both major versions ("8.0") and full versions ("8.0.17")
    const majorParts = version.split('.')
    const major =
      majorParts.length >= 2 ? `${majorParts[0]}.${majorParts[1]}` : version
    return (
      version in FALLBACK_VERSION_MAP || FALLBACK_VERSION_MAP[major] === version
    )
  }
}

// Re-export for convenience
export { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP }
