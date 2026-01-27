/**
 * CockroachDB hostdb releases integration
 *
 * Fetches available versions from hostdb releases.json and provides
 * fallback to local version maps.
 */

import { logDebug } from '../../core/error-handler'
import { COCKROACHDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'

const HOSTDB_RELEASES_URL =
  'https://raw.githubusercontent.com/robertjbass/hostdb/main/releases.json'

// Cache for fetched versions (expires after 5 minutes)
let cachedVersions: Record<string, string[]> | null = null
let cacheExpiry = 0
const CACHE_TTL_MS = 5 * 60 * 1000

type HostdbReleases = {
  [engine: string]: {
    versions: {
      version: string
      platforms: string[]
    }[]
  }
}

/**
 * Fetch available CockroachDB versions from hostdb
 * Returns a map of major version to available patch versions
 *
 * Falls back to local version maps if fetch fails
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Return cached versions if still valid
  if (cachedVersions && Date.now() < cacheExpiry) {
    return cachedVersions
  }

  try {
    const response = await fetch(HOSTDB_RELEASES_URL)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const releases = (await response.json()) as HostdbReleases
    const cockroachdbReleases = releases.cockroachdb

    if (!cockroachdbReleases?.versions) {
      throw new Error('No CockroachDB versions found in releases.json')
    }

    // Group versions by major version (YY.MM format)
    const versionMap: Record<string, string[]> = {}

    for (const { version } of cockroachdbReleases.versions) {
      // Extract major version (e.g., "25" from "25.4.2")
      const majorMatch = version.match(/^(\d+)/)
      if (!majorMatch) continue

      const majorVersion = majorMatch[1]
      if (!versionMap[majorVersion]) {
        versionMap[majorVersion] = []
      }
      versionMap[majorVersion].push(version)
    }

    // Sort versions within each major version (newest first)
    for (const major of Object.keys(versionMap)) {
      versionMap[major].sort((a, b) => {
        const partsA = a.split('.').map(Number)
        const partsB = b.split('.').map(Number)
        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
          const diff = (partsB[i] || 0) - (partsA[i] || 0)
          if (diff !== 0) return diff
        }
        return 0
      })
    }

    // Cache the results
    cachedVersions = versionMap
    cacheExpiry = Date.now() + CACHE_TTL_MS

    logDebug('Fetched CockroachDB versions from hostdb', { versionMap })
    return versionMap
  } catch (error) {
    logDebug(`Failed to fetch hostdb releases: ${error}`)

    // Fall back to local version maps
    const fallbackMap: Record<string, string[]> = {}
    for (const major of SUPPORTED_MAJOR_VERSIONS) {
      const fullVersion = COCKROACHDB_VERSION_MAP[major]
      if (fullVersion) {
        fallbackMap[major] = [fullVersion]
      }
    }

    return fallbackMap
  }
}

/**
 * Clear the version cache (useful for testing)
 */
export function clearVersionCache(): void {
  cachedVersions = null
  cacheExpiry = 0
}
