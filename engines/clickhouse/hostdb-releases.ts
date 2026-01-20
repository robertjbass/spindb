/**
 * hostdb Releases Module for ClickHouse
 *
 * Fetches ClickHouse binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built ClickHouse binaries for multiple platforms.
 */

import {
  CLICKHOUSE_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
  getMajorVersion,
} from './version-maps'
import { compareVersions } from '../../core/version-utils'
import { logDebug } from '../../core/error-handler'
import { clickhouseBinaryManager } from './binary-manager'
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
import { Engine, type Platform, type Arch } from '../../types'

// TODO - remove all places where vars are re-exported for backwards compatibility - search below comment
// Re-export types for backwards compatibility
export type { HostdbRelease, HostdbReleasesData, HostdbPlatform }

// Re-export shared functions
export const clearCache = clearSharedCache

// Get available ClickHouse versions from hostdb databases.json, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Try to fetch from hostdb databases.json (authoritative source)
  try {
    const versions = await getHostdbVersions(Engine.ClickHouse)

    if (versions && versions.length > 0) {
      // Group versions by major version (YY.MM format)
      const grouped: Record<string, string[]> = {}

      for (const version of versions) {
        const major = getMajorVersion(version)
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
      'Failed to fetch ClickHouse versions from hostdb, checking local',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    )
  }

  // Offline fallback: return only locally installed versions
  const installed = await clickhouseBinaryManager.listInstalled()
  if (installed.length > 0) {
    const result: Record<string, string[]> = {}
    for (const binary of installed) {
      const major = getMajorVersion(binary.version)
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
    grouped[major] = [CLICKHOUSE_VERSION_MAP[major]]
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

  // Check version map fallback
  if (CLICKHOUSE_VERSION_MAP[major]) {
    return CLICKHOUSE_VERSION_MAP[major]
  }

  // Normalize to 4-segment ClickHouse version format (YY.MM.patch.build)
  const parts = major.split('.')
  while (parts.length < 4) {
    parts.push('0')
  }
  return parts.slice(0, 4).join('.')
}

/**
 * Get the download URL for a ClickHouse version from hostdb
 *
 * @param version - Full version (e.g., '25.12.3.21')
 * @param platform - Platform identifier (e.g., Platform.Darwin, Platform.Linux)
 * @param arch - Architecture identifier (e.g., Arch.ARM64, Arch.X64)
 * @returns Download URL for the binary
 */
export async function getHostdbDownloadUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): Promise<string> {
  // Validate platform up-front so we fail fast for unsupported platforms
  const hostdbPlatform = validatePlatform(platform, arch)

  try {
    const releases = await fetchHostdbReleases()
    const clickhouseReleases = getEngineReleases(releases, Engine.ClickHouse)

    if (!clickhouseReleases) {
      throw new Error('ClickHouse releases not found in hostdb')
    }

    // Find the version in releases
    const release = clickhouseReleases[version]
    if (!release) {
      throw new Error(`Version ${version} not found in hostdb releases`)
    }

    // Get the platform-specific download URL
    const platformData = release.platforms[hostdbPlatform]
    if (!platformData) {
      throw new Error(
        `Platform ${hostdbPlatform} not available for ClickHouse ${version}`,
      )
    }

    return platformData.url
  } catch (error) {
    // Fallback to constructing URL manually if fetch fails
    logDebug(
      'Failed to fetch ClickHouse download URL from hostdb, using fallback',
      {
        version,
        platform,
        arch,
        error: error instanceof Error ? error.message : String(error),
      },
    )
    return buildDownloadUrl(Engine.ClickHouse, { version, platform, arch })
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
    const versions = await getHostdbVersions(Engine.ClickHouse)
    return versions ? versions.includes(version) : false
  } catch {
    // Fallback to checking version map using explicit key/value checks
    const major = getMajorVersion(version)
    const mapKeys = Object.keys(CLICKHOUSE_VERSION_MAP)
    const mapValues = Object.values(CLICKHOUSE_VERSION_MAP)

    return (
      mapKeys.includes(version) || // version is a major key (e.g., "25.12")
      mapValues.includes(version) || // version is a full version value
      CLICKHOUSE_VERSION_MAP[major] === version // version matches the mapped full version for its major
    )
  }
}
