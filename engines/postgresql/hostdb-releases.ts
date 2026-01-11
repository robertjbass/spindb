/**
 * hostdb Releases Module
 *
 * Fetches PostgreSQL binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built PostgreSQL binaries for multiple platforms,
 * replacing the previous zonky.io (macOS/Linux) and EDB (Windows) sources.
 */

import {
  POSTGRESQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from './version-maps'

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
    postgresql: Record<string, HostdbRelease>
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

// Get available PostgreSQL versions from hostdb, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  try {
    const releases = await fetchHostdbReleases()
    const pgReleases = releases.databases.postgresql

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

/**
 * Compare two version strings (e.g., "16.11.0" vs "16.9.0")
 * Returns positive if a > b, negative if a < b, 0 if equal
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA !== numB) {
      return numA - numB
    }
  }
  return 0
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
  try {
    const releases = await fetchHostdbReleases()
    const pgReleases = releases.databases.postgresql

    // Find the version in releases
    const release = pgReleases[version]
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
        `Platform ${hostdbPlatform} not available for PostgreSQL ${version}`,
      )
    }

    return platformData.url
  } catch {
    // Fallback to constructing URL manually if fetch fails
    const platformKey = `${platform}-${arch}`
    const hostdbPlatform = mapPlatformToHostdb(platformKey)
    const tag = `postgresql-${version}`
    const filename = `postgresql-${version}-${hostdbPlatform}.tar.gz`

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
  // No transformation needed unlike zonky.io which used suffixes like 'v8'
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
    return version in releases.databases.postgresql
  } catch {
    // Fallback to checking version map
    // Handle both major versions ("17") and full versions ("17.7.0")
    const major = version.split('.')[0]
    return (
      version in POSTGRESQL_VERSION_MAP ||
      POSTGRESQL_VERSION_MAP[major] === version
    )
  }
}
