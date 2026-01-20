/**
 * hostdb Releases Module for PostgreSQL
 *
 * Fetches PostgreSQL binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built PostgreSQL binaries for multiple platforms.
 */

import {
  POSTGRESQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from './version-maps'
import { compareVersions } from '../../core/version-utils'
import { getAvailableVersions as getHostdbVersions } from '../../core/hostdb-metadata'
import { postgresqlBinaryManager } from './binary-manager'
import { logDebug } from '../../core/error-handler'
import { Engine } from '../../types'

// Get available PostgreSQL versions from hostdb databases.json, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Try to fetch from hostdb databases.json (authoritative source)
  try {
    const versions = await getHostdbVersions(Engine.PostgreSQL)

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
    logDebug(
      'Failed to fetch PostgreSQL versions from hostdb, checking local',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    )
  }

  // Offline fallback: return only locally installed versions
  const installed = await postgresqlBinaryManager.listInstalled()
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

// Get hardcoded versions as last resort fallback
function getHardcodedVersions(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const major of SUPPORTED_MAJOR_VERSIONS) {
    grouped[major] = [POSTGRESQL_VERSION_MAP[major]]
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
  return POSTGRESQL_VERSION_MAP[major] || `${major}.0.0`
}

