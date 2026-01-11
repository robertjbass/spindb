/**
 * hostdb Releases Module for MariaDB
 *
 * Fetches MariaDB binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built MariaDB binaries for multiple platforms.
 */

import { MARIADB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { compareVersions } from '../../core/version-utils'

// Platform definition in hostdb releases.json
export type HostdbPlatform = {
  url: string
  sha256: string
  size: number
}

// Version entry in hostdb releases.json
export type HostdbRelease = {
  version: string
  releaseTag: string
  releasedAt: string
  platforms: Record<string, HostdbPlatform>
}

// Structure of hostdb releases.json
export type HostdbReleasesData = {
  repository: string
  updatedAt: string
  databases: {
    mariadb?: Record<string, HostdbRelease>
    postgresql?: Record<string, HostdbRelease>
    // Other databases...
  }
}

// Cache for fetched releases
let cachedReleases: HostdbReleasesData | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// Clear the releases cache (for testing)
export function clearCache(): void {
  cachedReleases = null
  cacheTimestamp = 0
}

// Fetch releases.json from hostdb repository
export async function fetchHostdbReleases(): Promise<HostdbReleasesData> {
  // Return cached releases if still valid
  if (cachedReleases && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedReleases
  }

  const url =
    'https://raw.githubusercontent.com/robertjbass/hostdb/main/releases.json'

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as HostdbReleasesData

    // Cache the results
    cachedReleases = data
    cacheTimestamp = Date.now()

    return data
  } catch (error) {
    const err = error as Error
    // Log the failure and rethrow - caller decides whether to use fallback
    console.warn(`Warning: Failed to fetch hostdb releases: ${err.message}`)
    throw error
  }
}

// Get available MariaDB versions from hostdb, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  try {
    const releases = await fetchHostdbReleases()
    const mariadbReleases = releases.databases.mariadb

    if (!mariadbReleases) {
      // No MariaDB releases in hostdb yet, use fallback
      return getFallbackVersions()
    }

    // Group versions by major version (e.g., 11.8)
    const grouped: Record<string, string[]> = {}

    for (const major of SUPPORTED_MAJOR_VERSIONS) {
      grouped[major] = []

      // Find all versions matching this major version
      for (const [_versionKey, release] of Object.entries(mariadbReleases)) {
        // MariaDB uses X.Y format for major versions (e.g., 11.8.5 matches 11.8)
        const releaseMajor = release.version.split('.').slice(0, 2).join('.')
        if (releaseMajor === major) {
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
    grouped[major] = [MARIADB_VERSION_MAP[major]]
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
  return MARIADB_VERSION_MAP[major] || `${major}.0`
}

/**
 * Get the download URL for a MariaDB version from hostdb
 *
 * @param version - Full version (e.g., '11.8.5')
 * @param platform - Platform identifier (e.g., 'darwin', 'linux', 'win32')
 * @param arch - Architecture identifier (e.g., 'arm64', 'x64')
 * @returns Download URL for the binary
 */
export async function getHostdbDownloadUrl(
  version: string,
  platform: string,
  arch: string,
): Promise<string> {
  try {
    const releases = await fetchHostdbReleases()
    const mariadbReleases = releases.databases.mariadb

    if (!mariadbReleases) {
      throw new Error('MariaDB releases not found in hostdb')
    }

    // Find the version in releases
    const release = mariadbReleases[version]
    if (!release) {
      throw new Error(`Version ${version} not found in hostdb releases`)
    }

    // Map Node.js platform names to hostdb platform names
    const platformKey = `${platform}-${arch}`
    const hostdbPlatform = mapPlatformToHostdb(platformKey)

    // Get the platform-specific download URL
    const platformData = release.platforms[hostdbPlatform]
    if (!platformData) {
      throw new Error(
        `Platform ${hostdbPlatform} not available for MariaDB ${version}`,
      )
    }

    return platformData.url
  } catch {
    // Fallback to constructing URL manually if fetch fails
    const platformKey = `${platform}-${arch}`
    const hostdbPlatform = mapPlatformToHostdb(platformKey)
    const tag = `mariadb-${version}`
    const ext = platform === 'win32' ? 'zip' : 'tar.gz'
    const filename = `mariadb-${version}-${hostdbPlatform}.${ext}`

    return `https://github.com/robertjbass/hostdb/releases/download/${tag}/${filename}`
  }
}

/**
 * Map Node.js platform identifiers to hostdb platform identifiers
 *
 * @param platformKey - Node.js platform-arch key (e.g., 'darwin-arm64')
 * @returns hostdb platform identifier (e.g., 'darwin-arm64')
 */
function mapPlatformToHostdb(platformKey: string): string {
  // hostdb uses standard platform naming, which matches Node.js
  const mapping: Record<string, string> = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux-x64',
    'win32-x64': 'win32-x64',
  }

  const result = mapping[platformKey]
  if (!result) {
    throw new Error(`Unsupported platform: ${platformKey}`)
  }

  return result
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
    if (!releases.databases.mariadb) {
      return false
    }
    return version in releases.databases.mariadb
  } catch {
    // Fallback to checking version map
    // Handle both major versions ("11.8") and full versions ("11.8.5")
    const majorParts = version.split('.')
    const major =
      majorParts.length >= 2 ? `${majorParts[0]}.${majorParts[1]}` : version
    return (
      version in MARIADB_VERSION_MAP || MARIADB_VERSION_MAP[major] === version
    )
  }
}
