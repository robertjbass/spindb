/**
 * hostdb Releases Module for ClickHouse
 *
 * Fetches ClickHouse binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built ClickHouse binaries for multiple platforms.
 */

import {
  CLICKHOUSE_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
  getMajorVersion,
} from './version-maps'
import { compareVersions } from '../../core/version-utils'
import { logDebug } from '../../core/error-handler'
import { clickhouseBinaryManager } from './binary-manager'
import { getAvailableVersions as getHostdbVersions } from '../../core/hostdb-metadata'
import { Engine } from '../../types'

// Get available ClickHouse versions from hostdb databases.json, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Try to fetch from hostdb databases.json (authoritative source)
  try {
    const versions = await getHostdbVersions(Engine.ClickHouse)

    if (versions && versions.length > 0) {
      // Group versions by major version (YY.MM format)
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
      'Failed to fetch ClickHouse versions from hostdb, checking local',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    )
  }

  // Offline fallback: return only locally installed versions
  const installed = await clickhouseBinaryManager.listInstalled()
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

// Get hardcoded versions as last resort fallback
function getHardcodedVersions(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const major of SUPPORTED_MAJOR_VERSIONS) {
    grouped[major] = [CLICKHOUSE_VERSION_MAP[major]]
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

  // Check version map fallback
  if (CLICKHOUSE_VERSION_MAP[major]) {
    return CLICKHOUSE_VERSION_MAP[major]
  }

  // Normalize to 4-segment ClickHouse version format (YY.MM.patch.build)
  const parts = major.split('.')
  while (parts.length < 4) {
    parts.push('0')
  }
  return parts.slice(0, 4).join('.')
}

/**
 * Get the download URL for a ClickHouse version from hostdb
 *
 * @param version - Full version (e.g., '25.12.3.21')
 * @param platform - Platform identifier (e.g., Platform.Darwin, Platform.Linux)
 * @param arch - Architecture identifier (e.g., Arch.ARM64, Arch.X64)
 * @returns Download URL for the binary
 */
