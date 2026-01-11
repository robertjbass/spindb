/**
 * hostdb Releases Module for Redis
 *
 * Fetches Redis binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built Redis binaries for multiple platforms.
 */

import { REDIS_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { getHostdbPlatform } from './binary-urls'
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
    redis?: Record<string, HostdbRelease>
    mysql?: Record<string, HostdbRelease>
    mariadb?: Record<string, HostdbRelease>
    postgresql?: Record<string, HostdbRelease>
    mongodb?: Record<string, HostdbRelease>
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

// Get available Redis versions from hostdb, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  try {
    const releases = await fetchHostdbReleases()
    const redisReleases = releases.databases.redis

    if (!redisReleases) {
      // No Redis releases in hostdb yet, use fallback
      return getFallbackVersions()
    }

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
  } catch {
    // Fallback to version map on error
    return getFallbackVersions()
  }
}

// Get fallback versions when network is unavailable
function getFallbackVersions(): Record<string, string[]> {
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
  try {
    const releases = await fetchHostdbReleases()
    const redisReleases = releases.databases.redis

    if (!redisReleases) {
      throw new Error('Redis releases not found in hostdb')
    }

    // Find the version in releases
    const release = redisReleases[version]
    if (!release) {
      throw new Error(`Version ${version} not found in hostdb releases`)
    }

    // Map Node.js platform names to hostdb platform names
    const hostdbPlatform = getHostdbPlatform(platform, arch)
    if (!hostdbPlatform) {
      throw new Error(`Unsupported platform: ${platform}-${arch}`)
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
    const hostdbPlatform = getHostdbPlatform(platform, arch)
    if (!hostdbPlatform) {
      throw new Error(`Unsupported platform: ${platform}-${arch}`)
    }
    const tag = `redis-${version}`
    // Windows uses .zip, Unix uses .tar.gz
    const ext = platform === 'win32' ? 'zip' : 'tar.gz'
    const filename = `redis-${version}-${hostdbPlatform}.${ext}`

    return `https://github.com/robertjbass/hostdb/releases/download/${tag}/${filename}`
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
    if (!releases.databases.redis) {
      return false
    }
    return version in releases.databases.redis
  } catch {
    // Fallback to checking version map
    // Handle both major versions ("7") and full versions ("7.4.7")
    const major = version.split('.')[0]
    return version in REDIS_VERSION_MAP || REDIS_VERSION_MAP[major] === version
  }
}
