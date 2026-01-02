/**
 * MongoDB version validation and compatibility checking
 */

import { existsSync, readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { logDebug } from '../../core/error-handler'

/**
 * Parse a version string into components
 * Handles formats like "8.0.4", "8.0", "v8.0.4"
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  const parts = cleaned.split('.')

  if (parts.length < 2) return null

  const major = parseInt(parts[0], 10)
  const minor = parseInt(parts[1], 10)
  const patch = parts[2] ? parseInt(parts[2], 10) : 0

  if (isNaN(major) || isNaN(minor)) return null

  return { major, minor, patch, raw: cleaned }
}

/**
 * Compare two versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b, null if either version cannot be parsed
 */
export function compareVersions(a: string, b: string): number | null {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) {
    return null
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major < parsedB.major ? -1 : 1
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor < parsedB.minor ? -1 : 1
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1
  }
  return 0
}

/**
 * Check if a backup version is compatible with the restore version
 * MongoDB allows restoring from older versions but not newer
 *
 * Compatible scenarios:
 * - Same major.minor version (e.g., 8.0.2 -> 8.0.4)
 * - One major version difference (e.g., 7.0.x -> 8.0.x)
 *
 * Incompatible:
 * - Restoring newer dump to older server
 * - More than one major version difference
 */
export function isVersionCompatible(
  backupVersion: string,
  restoreVersion: string,
): { compatible: boolean; warning?: string } {
  const backup = parseVersion(backupVersion)
  const restore = parseVersion(restoreVersion)

  if (!backup || !restore) {
    return {
      compatible: true,
      warning: 'Could not parse versions, proceeding with restore',
    }
  }

  // Cannot restore newer dump to older server
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `Cannot restore MongoDB ${backupVersion} backup to ${restoreVersion} server. The backup is from a newer major version.`,
    }
  }

  // Allow same major version
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // Allow one major version upgrade (e.g., 7.0 -> 8.0)
  if (restore.major - backup.major === 1) {
    return {
      compatible: true,
      warning: `Restoring MongoDB ${backupVersion} backup to ${restoreVersion} server. Consider running database upgrade procedures after restore.`,
    }
  }

  // More than one major version difference
  return {
    compatible: false,
    warning: `Cannot restore MongoDB ${backupVersion} backup to ${restoreVersion} server. The version difference is too large.`,
  }
}

/**
 * Extract version from a mongodump directory
 * Mongodump creates a metadata.json file with version info
 */
export async function extractVersionFromDump(
  dumpPath: string,
): Promise<string | null> {
  try {
    // Check if it's a directory dump
    if (!existsSync(dumpPath)) {
      return null
    }

    // Look for oplog.bson or any .metadata.json file
    const files = readdirSync(dumpPath, { recursive: true }) as string[]

    for (const file of files) {
      if (file.endsWith('.metadata.json')) {
        const metadataPath = join(dumpPath, file)
        const content = await readFile(metadataPath, 'utf8')
        const metadata = JSON.parse(content)

        // Check for version in metadata
        if (metadata.version) {
          return metadata.version
        }
      }
    }

    return null
  } catch (error) {
    logDebug(`Failed to extract version from dump: ${error}`)
    return null
  }
}

/**
 * Get major.minor version from full version string
 * e.g., "8.0.4" -> "8.0"
 */
export function getMajorMinorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * Validate that a version string matches supported format
 */
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
