/**
 * MongoDB hostdb releases integration
 *
 * Fetches available MongoDB versions from the hostdb releases.json file.
 * This allows SpinDB to stay in sync with hostdb's available binaries.
 */

import { logDebug, logWarning } from '../../core/error-handler'
import { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'
import { isNewerVersion } from '../../core/version-utils'

const HOSTDB_RELEASES_URL =
  'https://raw.githubusercontent.com/robertjbass/hostdb/main/releases.json'

// Cache for releases data (5 minute TTL)
let releasesCache: HostdbReleasesResponse | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000

type HostdbPlatform = {
  url: string
  sha256: string
  size: number
}

type VersionRelease = {
  version: string
  releaseTag: string
  releasedAt: string
  platforms: Record<string, HostdbPlatform>
}

type HostdbReleasesResponse = {
  databases: {
    mongodb?: Record<string, VersionRelease>
  }
}

// Fetch the hostdb releases.json file
export async function fetchHostdbReleases(): Promise<HostdbReleasesResponse | null> {
  const now = Date.now()

  // Return cached data if still valid
  if (releasesCache && now - cacheTimestamp < CACHE_TTL_MS) {
    return releasesCache
  }

  try {
    // Add 30 second timeout to prevent hanging
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30 * 1000)

    let response: Response
    try {
      response = await fetch(HOSTDB_RELEASES_URL, { signal: controller.signal })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      logWarning(`Failed to fetch hostdb releases: ${response.status}`)
      return null
    }

    const data = (await response.json()) as HostdbReleasesResponse
    releasesCache = data
    cacheTimestamp = now
    return data
  } catch (error) {
    const err = error as Error
    if (err.name === 'AbortError') {
      logWarning('Timeout fetching hostdb releases')
    } else {
      logWarning(`Error fetching hostdb releases: ${error}`)
    }
    return null
  }
}

/**
 * Fetch available MongoDB versions from hostdb
 * Falls back to hardcoded version map if fetch fails
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string>
> {
  const releases = await fetchHostdbReleases()

  if (releases?.databases?.mongodb) {
    const mongodbReleases = releases.databases.mongodb
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

  // Fall back to hardcoded versions
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
    const mongodbReleases = releases?.databases?.mongodb

    if (!mongodbReleases) {
      throw new Error('MongoDB releases not found in hostdb')
    }

    // Find the version in releases
    const release = mongodbReleases[version]
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
    const platformKey = `${platform}-${arch}`
    const hostdbPlatform = mapPlatformToHostdb(platformKey)
    const tag = `mongodb-${version}`
    const filename = `mongodb-${version}-${hostdbPlatform}.tar.gz`

    return `https://github.com/robertjbass/hostdb/releases/download/${tag}/${filename}`
  }
}

/**
 * Map Node.js platform identifiers to hostdb platform identifiers
 */
function mapPlatformToHostdb(platformKey: string): string {
  const mapping: Record<string, string> = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux-x64',
  }

  const result = mapping[platformKey]
  if (!result) {
    throw new Error(`Unsupported platform: ${platformKey}`)
  }

  return result
}

// Re-export for convenience
export { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP }
