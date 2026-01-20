/**
 * hostdb Releases Factory
 *
 * Creates standardized hostdb-releases modules for database engines.
 * This reduces code duplication across engines that follow the same pattern.
 *
 * The factory creates two functions:
 * - fetchAvailableVersions(): Fetches available versions grouped by major version
 * - getLatestVersion(major): Gets the latest version for a major version
 */

import { compareVersions } from './version-utils'
import { getAvailableVersions as getHostdbVersions } from './hostdb-metadata'
import { logDebug } from './error-handler'
import type { Engine, InstalledBinary } from '../types'

/**
 * Grouping strategy for version numbers:
 * - 'single-digit': Group by first segment (e.g., 17.7.0 → 17)
 * - 'xy-format': Group by first two segments (e.g., 8.0.40 → 8.0)
 */
export type GroupingStrategy = 'single-digit' | 'xy-format'

/**
 * Configuration for creating hostdb-releases functions
 */
export type HostdbReleasesConfig = {
  /** Engine enum value */
  engine: Engine
  /** Display name for log messages */
  displayName: string
  /** Version map from major to full version */
  versionMap: Record<string, string>
  /** Supported major versions */
  supportedMajorVersions: readonly string[]
  /** Strategy for grouping versions by major version */
  groupingStrategy: GroupingStrategy
  /** Function to list installed binaries for offline fallback */
  listInstalled: () => Promise<InstalledBinary[]>
  /**
   * Optional custom function to extract major version.
   * Use this for engines with non-standard version grouping (e.g., ClickHouse's YY.MM,
   * MySQL's conditional X.Y vs X grouping).
   */
  getMajorVersion?: (version: string) => string
}

/**
 * Return type for the factory
 */
export type HostdbReleasesModule = {
  fetchAvailableVersions: () => Promise<Record<string, string[]>>
  getLatestVersion: (major: string) => Promise<string>
}

/**
 * Default function to extract major version based on grouping strategy
 */
function defaultGetMajorVersion(
  version: string,
  strategy: GroupingStrategy,
): string {
  const parts = version.split('.')
  if (strategy === 'xy-format') {
    return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0]
  }
  return parts[0]
}

/**
 * Create hostdb-releases functions for an engine
 */
export function createHostdbReleases(
  config: HostdbReleasesConfig,
): HostdbReleasesModule {
  const {
    engine,
    displayName,
    versionMap,
    supportedMajorVersions,
    groupingStrategy,
    listInstalled,
  } = config

  // Use custom getMajorVersion if provided, otherwise use default
  const getMajorVersion =
    config.getMajorVersion ??
    ((version: string) => defaultGetMajorVersion(version, groupingStrategy))

  // Cache for fetchAvailableVersions to avoid repeated network requests
  let cachedVersions: Record<string, string[]> | null = null
  let cachedAt = 0
  const cacheTTLMs = 30_000 // 30 seconds
  let inflightFetchPromise: Promise<Record<string, string[]>> | null = null

  /**
   * Get hardcoded versions as last resort fallback
   */
  function getHardcodedVersions(): Record<string, string[]> {
    const grouped: Record<string, string[]> = {}
    for (const major of supportedMajorVersions) {
      const version = versionMap[major]
      if (version) {
        grouped[major] = [version]
      }
    }
    return grouped
  }

  /**
   * Get available versions from hostdb, grouped by major version
   */
  async function fetchAvailableVersions(): Promise<Record<string, string[]>> {
    // Try to fetch from hostdb databases.json (authoritative source)
    try {
      const versions = await getHostdbVersions(engine)

      if (versions && versions.length > 0) {
        // Group versions by major version
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
        `Failed to fetch ${displayName} versions from hostdb, checking local`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      )
    }

    // Offline fallback: return only locally installed versions
    const installed = await listInstalled()
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

  /**
   * Get cached versions if fresh, otherwise fetch and cache.
   * Uses inflightFetchPromise to dedupe concurrent requests.
   */
  async function getCachedVersions(): Promise<Record<string, string[]>> {
    const now = Date.now()

    // Return cached result if fresh
    if (cachedVersions && now - cachedAt < cacheTTLMs) {
      return cachedVersions
    }

    // If there's an inflight request, await it instead of starting a new one
    if (inflightFetchPromise) {
      return inflightFetchPromise
    }

    // Start new fetch, store promise to dedupe concurrent calls
    inflightFetchPromise = fetchAvailableVersions()
      .then((versions) => {
        cachedVersions = versions
        cachedAt = Date.now()
        inflightFetchPromise = null
        return versions
      })
      .catch((error) => {
        // Clear inflight promise on error so subsequent calls can retry
        inflightFetchPromise = null
        throw error
      })

    return inflightFetchPromise
  }

  /**
   * Get the latest version for a major version from hostdb.
   * Uses cached fetchAvailableVersions result to avoid repeated network requests.
   */
  async function getLatestVersion(major: string): Promise<string> {
    const versions = await getCachedVersions()
    const majorVersions = versions[major]
    if (majorVersions && majorVersions.length > 0) {
      return majorVersions[0] // First is latest due to descending sort
    }

    // Fallback to version map
    if (versionMap[major]) {
      return versionMap[major]
    }

    // Generate default version based on grouping strategy
    if (groupingStrategy === 'xy-format') {
      // For X.Y format, add .0 to get X.Y.0
      return `${major}.0`
    }
    // For single-digit, add .0.0 to get X.0.0
    return `${major}.0.0`
  }

  return {
    fetchAvailableVersions: getCachedVersions,
    getLatestVersion,
  }
}
