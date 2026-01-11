/**
 * MongoDB hostdb releases integration
 *
 * Fetches available MongoDB versions from the hostdb releases.json file.
 * This allows SpinDB to stay in sync with hostdb's available binaries.
 */

import { logDebug, logWarning } from '../../core/error-handler'
import { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'

const HOSTDB_RELEASES_URL =
  'https://raw.githubusercontent.com/robertjbass/hostdb/main/releases.json'

// Cache for releases data (5 minute TTL)
let releasesCache: HostdbReleasesResponse | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000

type HostdbReleasesResponse = {
  databases: {
    mongodb?: {
      versions: string[]
      platforms: Record<string, string[]>
    }
  }
}

/**
 * Fetch the hostdb releases.json file
 */
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

  if (releases?.databases?.mongodb?.versions) {
    const versions = releases.databases.mongodb.versions
    const versionMap: Record<string, string> = {}

    for (const fullVersion of versions) {
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

/**
 * Get the latest full version for a major.minor version
 */
export async function getLatestVersion(
  majorMinor: string,
): Promise<string | null> {
  const versions = await fetchAvailableVersions()
  return versions[majorMinor] || null
}

/**
 * Get the download URL for a MongoDB version from hostdb
 */
export function getHostdbDownloadUrl(
  version: string,
  platform: string,
  arch: string,
): string {
  const platformKey = `${platform}-${arch}`
  return `https://github.com/robertjbass/hostdb/releases/download/mongodb-${version}/mongodb-${version}-${platformKey}.tar.gz`
}

/**
 * Compare two semantic versions
 * Returns true if versionA > versionB
 */
function isNewerVersion(versionA: string, versionB: string): boolean {
  const partsA = versionA.split('.').map(Number)
  const partsB = versionB.split('.').map(Number)
  const maxLength = Math.max(partsA.length, partsB.length)

  for (let i = 0; i < maxLength; i++) {
    const a = partsA[i] || 0
    const b = partsB[i] || 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

// Re-export for convenience
export { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP }
