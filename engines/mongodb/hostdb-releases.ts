/**
 * MongoDB hostdb releases integration
 *
 * Fetches available MongoDB versions from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built MongoDB binaries for multiple platforms.
 */

import { logDebug } from '../../core/error-handler'
import { FALLBACK_VERSION_MAP } from './version-maps'
import { isNewerVersion } from '../../core/version-utils'
import { mongodbBinaryManager } from './binary-manager'
import { getAvailableVersions as getHostdbVersions } from '../../core/hostdb-metadata'
import { Engine } from '../../types'

/**
 * Fetch available MongoDB versions from hostdb databases.json
 * Falls back to locally installed versions, then hardcoded version map
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string>
> {
  // Try to fetch from hostdb databases.json (authoritative source)
  try {
    const versions = await getHostdbVersions(Engine.MongoDB)

    if (versions && versions.length > 0) {
      const versionMap: Record<string, string> = {}

      // Iterate over version strings (e.g., "7.0.28", "8.0.17", "8.2.3")
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
  } catch (error) {
    logDebug('Failed to fetch MongoDB versions from hostdb, checking local', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Offline fallback: return only locally installed versions
  const installed = await mongodbBinaryManager.listInstalled()
  if (installed.length > 0) {
    const versionMap: Record<string, string> = {}
    for (const binary of installed) {
      // MongoDB uses X.Y format for major versions
      const parts = binary.version.split('.')
      if (parts.length >= 2) {
        const majorMinor = `${parts[0]}.${parts[1]}`
        // Keep the latest full version for each major.minor
        if (
          !versionMap[majorMinor] ||
          isNewerVersion(binary.version, versionMap[majorMinor])
        ) {
          versionMap[majorMinor] = binary.version
        }
      }
    }
    logDebug('Using locally installed MongoDB versions', {
      versions: versionMap,
    })
    return versionMap
  }

  // Last resort: return hardcoded version map
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
