/**
 * hostdb Releases Module for MySQL
 *
 * Fetches MySQL binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * hostdb provides pre-built MySQL binaries for multiple platforms.
 */

import { MYSQL_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { logDebug } from '../../core/error-handler'
import { compareVersions } from '../../core/version-utils'
import { getAvailableVersions as getHostdbVersions } from '../../core/hostdb-metadata'
import { mysqlBinaryManager } from './binary-manager'
import { Engine } from '../../types'

// Get available MySQL versions from hostdb databases.json, grouped by major version
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  // Try to fetch from hostdb databases.json (authoritative source)
  try {
    const versions = await getHostdbVersions(Engine.MySQL)

    if (versions && versions.length > 0) {
      // Group versions by major version
      // MySQL uses X.Y format for major versions (e.g., 8.0.40 matches 8.0)
      // But also supports single digit major (e.g., 9.5.0 matches 9)
      const grouped: Record<string, string[]> = {}

      for (const version of versions) {
        const parts = version.split('.')
        // Try X.Y first, then fall back to X
        const majorXY = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0]
        const majorX = parts[0]

        // Use X.Y if it's in SUPPORTED_MAJOR_VERSIONS, otherwise use X
        const major = SUPPORTED_MAJOR_VERSIONS.includes(majorXY)
          ? majorXY
          : majorX

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
    logDebug('Failed to fetch MySQL versions from hostdb, checking local', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Offline fallback: return only locally installed versions
  const installed = await mysqlBinaryManager.listInstalled()
  if (installed.length > 0) {
    const result: Record<string, string[]> = {}
    for (const binary of installed) {
      // MySQL uses X.Y format for major versions
      const parts = binary.version.split('.')
      const major = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0]
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
    grouped[major] = [MYSQL_VERSION_MAP[major]]
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
  if (MYSQL_VERSION_MAP[major]) {
    return MYSQL_VERSION_MAP[major]
  }
  // Fallback: append .0 or .0.0 depending on format
  // "8.0" -> "8.0.0", "8" -> "8.0.0"
  return major.includes('.') ? `${major}.0` : `${major}.0.0`
}

/**
 * Get the download URL for a MySQL version from hostdb
 *
 * @param version - Full version (e.g., '8.0.40')
 * @param platform - Platform identifier (e.g., Platform.Darwin, Platform.Linux, Platform.Win32)
 * @param arch - Architecture identifier (e.g., Arch.ARM64, Arch.X64)
 * @returns Download URL for the binary
 */
