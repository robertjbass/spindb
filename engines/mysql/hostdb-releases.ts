/**
 * hostdb Releases Module for MySQL
 *
 * Fetches MySQL binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built MySQL binaries for multiple platforms.
 */

import { MYSQL_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { logDebug } from '../../core/error-handler'
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
import { mysqlBinaryManager } from './binary-manager'

// Re-export types for backwards compatibility
export type { HostdbRelease, HostdbReleasesData, HostdbPlatform }

// Re-export shared functions
export const clearCache = clearSharedCache

// Get available MySQL versions from hostdb databases.json, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Try to fetch from hostdb databases.json (authoritative source)
  try {
    const versions = await getHostdbVersions('mysql')

    if (versions && versions.length > 0) {
      // Group versions by major version
      // MySQL uses X.Y format for major versions (e.g., 8.0.40 matches 8.0)
      // But also supports single digit major (e.g., 9.1.0 matches 9)
      const grouped: Record<string, string[]> = {}

      for (const version of versions) {
        const parts = version.split('.')
        // Try X.Y first, then fall back to X
        const majorXY = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0]
        const majorX = parts[0]

        // Use X.Y if it's in SUPPORTED_MAJOR_VERSIONS, otherwise use X
        const major = SUPPORTED_MAJOR_VERSIONS.includes(majorXY)
          ? majorXY
          : majorX

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
    logDebug('Failed to fetch MySQL versions from hostdb, checking local', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Offline fallback: return only locally installed versions
  const installed = await mysqlBinaryManager.listInstalled()
  if (installed.length > 0) {
    const result: Record<string, string[]> = {}
    for (const binary of installed) {
      // MySQL uses X.Y format for major versions
      const parts = binary.version.split('.')
      const major = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0]
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
    grouped[major] = [MYSQL_VERSION_MAP[major]]
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
  return MYSQL_VERSION_MAP[major] || `${major}.0.0`
}

/**
 * Get the download URL for a MySQL version from hostdb
 *
 * @param version - Full version (e.g., '8.0.40')
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
    const mysqlReleases = getEngineReleases(releases, 'mysql')

    if (!mysqlReleases) {
      throw new Error('MySQL releases not found in hostdb')
    }

    // Find the version in releases
    const release = mysqlReleases[version]
    if (!release) {
      throw new Error(`Version ${version} not found in hostdb releases`)
    }

    // Get the platform-specific download URL
    const platformData = release.platforms[hostdbPlatform]
    if (!platformData) {
      throw new Error(
        `Platform ${hostdbPlatform} not available for MySQL ${version}`,
      )
    }

    return platformData.url
  } catch (error) {
    // Log the error before falling back to manual URL construction
    const errorMessage = error instanceof Error ? error.message : String(error)
    logDebug(
      `Failed to fetch MySQL ${version} URL from hostdb for ${platform}-${arch}: ${errorMessage}. Using fallback URL.`,
    )

    // Fallback to constructing URL manually if fetch fails
    return buildDownloadUrl('mysql', version, platform, arch)
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
    const versions = await getHostdbVersions('mysql')
    return versions ? versions.includes(version) : false
  } catch {
    // Fallback to checking version map
    // Handle both major versions ("8.0") and full versions ("8.0.40")
    const majorParts = version.split('.')
    let major: string
    if (majorParts.length === 1) {
      major = version
    } else {
      major = `${majorParts[0]}.${majorParts[1]}`
    }
    return version in MYSQL_VERSION_MAP || MYSQL_VERSION_MAP[major] === version
  }
}
