/**
 * QuestDB hostdb Releases
 *
 * Fetches available QuestDB versions from hostdb releases.json
 * Falls back to local version-maps.ts if fetch fails.
 */

import { logDebug } from '../../core/error-handler'
import {
  LAYERBASE_RELEASES_URL,
  GITHUB_RELEASES_URL,
} from '../../core/hostdb-client'
import { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'

// Cache for fetched versions (5-minute TTL)
let cachedVersions: Record<string, string[]> | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

type ReleaseInfo = {
  version: string
  platforms: string[]
}

type ReleasesJson = {
  [engine: string]: ReleaseInfo[]
}

/**
 * Fetch available QuestDB versions from hostdb
 * Returns a map of major version to available full versions
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Return cached result if still valid
  const now = Date.now()
  if (cachedVersions && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedVersions
  }

  try {
    let response: Response | null = null
    for (const url of [LAYERBASE_RELEASES_URL, GITHUB_RELEASES_URL]) {
      try {
        response = await fetch(url)
        if (response.ok) break
        logDebug(`QuestDB releases fetch from ${url}: HTTP ${response.status}`)
        response = null
      } catch (error) {
        logDebug(`QuestDB releases fetch from ${url} failed: ${error}`)
      }
    }
    if (!response || !response.ok) {
      throw new Error('All release registries failed')
    }

    const releases = (await response.json()) as ReleasesJson
    const questdbReleases = releases.questdb || []

    // Group versions by major version
    const versionMap: Record<string, string[]> = {}

    for (const release of questdbReleases) {
      const version = release.version
      // Extract major version (e.g., '9' from '9.2.3')
      const majorMatch = version.match(/^(\d+)/)
      if (!majorMatch) continue

      const major = majorMatch[1]

      // Only include supported major versions
      if (!SUPPORTED_MAJOR_VERSIONS.includes(major)) continue

      if (!versionMap[major]) {
        versionMap[major] = []
      }
      versionMap[major].push(version)
    }

    // Sort versions within each major (newest first)
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

    // Cache the result
    cachedVersions = versionMap
    cacheTimestamp = now

    return versionMap
  } catch (error) {
    logDebug(`Failed to fetch QuestDB versions from hostdb: ${error}`)

    // Fall back to local version map
    const fallbackMap: Record<string, string[]> = {}
    for (const major of SUPPORTED_MAJOR_VERSIONS) {
      const fullVersion = FALLBACK_VERSION_MAP[major]
      if (fullVersion) {
        fallbackMap[major] = [fullVersion]
      }
    }
    return fallbackMap
  }
}
