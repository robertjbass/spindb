/**
 * TypeDB version validation utilities
 * Handles version parsing, comparison, and compatibility checking
 */

import { SUPPORTED_MAJOR_VERSIONS } from './version-maps'

/**
 * Parse a TypeDB version string into components
 * Handles formats like "3.8.0", "3.8", "v3.8.0"
 * Rejects pre-release suffixes (e.g., "3.8.0-beta") and extra segments (e.g., "3.8.0.1")
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()

  // Reject versions with pre-release suffixes or metadata
  if (/[-+]/.test(cleaned)) return null

  const parts = cleaned.split('.')

  // Only allow 1-3 segments (major, major.minor, major.minor.patch)
  if (parts.length > 3) return null

  // Reject segments that aren't purely numeric (e.g., "3b", "8rc1")
  if (parts.some((p) => !/^\d+$/.test(p))) return null

  const major = parseInt(parts[0], 10)
  const minor = parts[1] ? parseInt(parts[1], 10) : 0
  const patch = parts[2] ? parseInt(parts[2], 10) : 0

  return { major, minor, patch, raw: cleaned }
}

/**
 * Check if a TypeDB version is supported by SpinDB
 * Minimum supported version: 3.0.0 (v3 is the Rust rewrite)
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return SUPPORTED_MAJOR_VERSIONS.includes(String(parsed.major))
}

/**
 * Get major version from full version string
 * e.g., "3.8.0" -> "3"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : version
}

/**
 * Compare two TypeDB versions
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
 * TypeDB backups are generally compatible within major versions
 */
export function isVersionCompatible(
  backupVersion: string,
  restoreVersion: string,
): { compatible: boolean; warning?: string } {
  const backup = parseVersion(backupVersion)
  const restore = parseVersion(restoreVersion)

  if (!backup || !restore) {
    return {
      compatible: false,
      warning:
        'Could not parse versions, refusing to proceed without valid version information',
    }
  }

  // Cannot restore newer backup to older server
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `Cannot restore TypeDB ${backupVersion} backup to ${restoreVersion} server. The backup is from a newer major version.`,
    }
  }

  // Allow same major version
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // Allow upgrading from older major version
  return {
    compatible: true,
    warning: `Restoring TypeDB ${backupVersion} backup to ${restoreVersion} server. Data format may be upgraded.`,
  }
}

// Validate that a version string matches supported format
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
