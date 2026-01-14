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
  fetchHostdbReleases,
  clearCache as clearSharedCache,
  getEngineReleases,
  validatePlatform,
  buildDownloadUrl,
  type HostdbRelease,
  type HostdbReleasesData,
  type HostdbPlatform,
} from '../../core/hostdb-client'
import { getAvailableVersions as getHostdbVersions } from '../../core/hostdb-metadata'
import { postgresqlBinaryManager } from './binary-manager'
import { logDebug } from '../../core/error-handler'

// Re-export types for backwards compatibility
export type { HostdbRelease, HostdbReleasesData, HostdbPlatform }

// Re-export shared functions
export const clearCache = clearSharedCache

// Get available PostgreSQL versions from hostdb databases.json, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Try to fetch from hostdb databases.json (authoritative source)
  try {
    const versions = await getHostdbVersions('postgresql')

    if (versions && versions.length > 0) {
      // Group versions by major version
      const grouped: Record<string, string[]> = {}

      for (const version of versions) {
        const major = version.split('.')[0]
        if (!grouped[major]) {
          grouped[major] = []
        }
        grouped[major].push(version)
      }

      // Sort each group descending (latest first)
      for (const major of Object.keys(grouped)) {
        grouped[major].sort((a, b) => compareVersions(b, a))
      }

      return grouped
    }
  } catch (error) {
    logDebug(
      'Failed to fetch PostgreSQL versions from hostdb, checking local',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    )
  }

  // Offline fallback: return only locally installed versions
  const installed = await postgresqlBinaryManager.listInstalled()
  if (installed.length > 0) {
    const result: Record<string, string[]> = {}
    for (const binary of installed) {
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
  } catch (error) {
    // Fallback to constructing URL manually if fetch fails
    logDebug(
      'Failed to fetch PostgreSQL download URL from hostdb, using fallback',
      {
        version,
        platform,
        arch,
        error: error instanceof Error ? error.message : String(error),
      },
    )
    return buildDownloadUrl('postgresql', version, platform, arch)
  }
}

/**
 * Check if a version is available in hostdb
 *
 * @param version - Version to check (e.g., "17" or "17.7.0")
 * @returns true if the version exists in hostdb databases.json
 */
export async function isVersionAvailable(version: string): Promise<boolean> {
  try {
    const versions = await getHostdbVersions('postgresql')
    return versions ? versions.includes(version) : false
  } catch {
    // Fallback to checking version map when network unavailable
    // Accept either a major version key (e.g., "17") or its mapped full version (e.g., "17.7.0")
    if (version in POSTGRESQL_VERSION_MAP) {
      return true // Input is a major version key
    }
    const major = version.split('.')[0]
    return POSTGRESQL_VERSION_MAP[major] === version
  }
}
