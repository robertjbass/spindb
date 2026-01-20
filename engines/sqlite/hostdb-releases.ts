/**
 * hostdb Releases Module for SQLite
 *
 * Fetches SQLite binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built SQLite binaries for multiple platforms.
 */

import {
  SQLITE_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
  normalizeVersion,
} from './version-maps'
import { compareVersions } from '../../core/version-utils'
import {
  fetchHostdbReleases,
  getEngineReleases,
  validatePlatform,
  buildDownloadUrl,
  type HostdbReleasesData,
} from '../../core/hostdb-client'
import { getAvailableVersions as getHostdbVersions } from '../../core/hostdb-metadata'
import { sqliteBinaryManager } from './binary-manager'
import { logDebug } from '../../core/error-handler'
import { Engine, type Platform, type Arch } from '../../types'

/**
 * Get available SQLite versions from hostdb databases.json, grouped by major version
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Try to fetch from hostdb databases.json (authoritative source)
  try {
    const versions = await getHostdbVersions(Engine.SQLite)

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
    logDebug('Failed to fetch SQLite versions from hostdb, checking local', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Offline fallback: return only locally installed versions
  const installed = await sqliteBinaryManager.listInstalled()
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

/**
 * Get hardcoded versions as last resort fallback
 */
function getHardcodedVersions(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const major of SUPPORTED_MAJOR_VERSIONS) {
    grouped[major] = [SQLITE_VERSION_MAP[major]]
  }
  return grouped
}

/**
 * Get the latest version for a major version from hostdb
 */
export async function getLatestVersion(major: string): Promise<string> {
  const versions = await fetchAvailableVersions()
  const majorVersions = versions[major]
  if (majorVersions && majorVersions.length > 0) {
    return majorVersions[0] // First is latest due to descending sort
  }

  const mappedVersion = SQLITE_VERSION_MAP[major]
  if (mappedVersion) {
    return mappedVersion
  }

  // Neither hostdb nor version map has this version - throw error
  throw new Error(
    `SQLite major version '${major}' not found in hostdb or version map. ` +
      `Available major versions: ${SUPPORTED_MAJOR_VERSIONS.join(', ')}`,
  )
}

/**
 * Get the download URL for a SQLite version from hostdb
 *
 * @param version - Full version (e.g., '3.51.2')
 * @param platform - Platform identifier (e.g., Platform.Darwin, Platform.Linux, Platform.Win32)
 * @param arch - Architecture identifier (e.g., Arch.ARM64, Arch.X64)
 * @returns Download URL for the binary
 */
export async function getHostdbDownloadUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): Promise<string> {
  // Normalize version first
  const fullVersion = normalizeVersion(version)

  // Validate platform up-front so we fail fast for unsupported platforms
  const hostdbPlatform = validatePlatform(platform, arch)

  let releases: HostdbReleasesData
  try {
    releases = await fetchHostdbReleases()
  } catch (error) {
    // Fallback to constructing URL manually if fetch fails
    logDebug(
      'Failed to fetch SQLite download URL from hostdb, using fallback',
      {
        version: fullVersion,
        platform,
        arch,
        error: error instanceof Error ? error.message : String(error),
      },
    )
    return buildDownloadUrl(Engine.SQLite, { version: fullVersion, platform, arch })
  }

  const sqliteReleases = getEngineReleases(releases, Engine.SQLite)

  if (!sqliteReleases) {
    throw new Error('SQLite releases not found in hostdb')
  }

  // Find the version in releases
  const release = sqliteReleases[fullVersion]
  if (!release) {
    throw new Error(`Version ${fullVersion} not found in hostdb releases`)
  }

  // Get the platform-specific download URL
  const platformData = release.platforms[hostdbPlatform]
  if (!platformData) {
    throw new Error(
      `Platform ${hostdbPlatform} not available for SQLite ${fullVersion}`,
    )
  }

  return platformData.url
}

/**
 * Check if a version is available in hostdb
 *
 * @param version - Version to check (e.g., "3" or "3.51.2")
 * @returns true if the version exists in hostdb databases.json
 */
export async function isVersionAvailable(version: string): Promise<boolean> {
  try {
    const versions = await getHostdbVersions(Engine.SQLite)
    if (!versions) return false

    // Check for exact full-version match
    if (versions.includes(version)) {
      return true
    }

    // Check if major-only input (e.g., "3") matches any available version
    const major = version.split('.')[0]
    if (version === major && versions.some((v) => v.startsWith(major + '.'))) {
      return true
    }

    return false
  } catch {
    // Fallback to checking version map when network unavailable
    // Accept either a major version key (e.g., "3") or its mapped full version (e.g., "3.51.2")
    if (version in SQLITE_VERSION_MAP) {
      return true // Input is a major version key
    }
    const major = version.split('.')[0]
    return SQLITE_VERSION_MAP[major] === version
  }
}
