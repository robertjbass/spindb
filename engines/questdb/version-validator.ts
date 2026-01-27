/**
 * QuestDB Version Validator
 *
 * Provides version parsing, validation, and comparison utilities.
 */

import { SUPPORTED_MAJOR_VERSIONS, QUESTDB_VERSION_MAP } from './version-maps'

export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  full: string
}

/**
 * Parse a version string into components
 * @param version Version string (e.g., '9.2.3', '9.2', '9')
 * @returns Parsed version or null if invalid
 */
export function parseVersion(version: string): ParsedVersion | null {
  // Match version patterns: 9.2.3, 9.2, 9
  const match = version.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  if (!match) return null

  const major = parseInt(match[1], 10)
  const minor = match[2] ? parseInt(match[2], 10) : 0
  const patch = match[3] ? parseInt(match[3], 10) : 0

  return {
    major,
    minor,
    patch,
    full: `${major}.${minor}.${patch}`,
  }
}

/**
 * Check if a version is supported
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  const majorStr = String(parsed.major)
  return SUPPORTED_MAJOR_VERSIONS.includes(majorStr)
}

/**
 * Get the major version string from a version
 */
export function getMajorVersion(version: string): string | null {
  const parsed = parseVersion(version)
  if (!parsed) return null
  return String(parsed.major)
}

/**
 * Compare two versions
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) {
    // Fall back to string comparison if parsing fails
    return a.localeCompare(b)
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major - parsedB.major
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor - parsedB.minor
  }
  return parsedA.patch - parsedB.patch
}

/**
 * Check if two versions are compatible for backup/restore
 * QuestDB allows restoring to same or newer major version
 */
export function isVersionCompatible(
  sourceVersion: string,
  targetVersion: string,
): boolean {
  const sourceMajor = getMajorVersion(sourceVersion)
  const targetMajor = getMajorVersion(targetVersion)

  if (!sourceMajor || !targetMajor) return false

  // Same major version is always compatible
  if (sourceMajor === targetMajor) return true

  // Target major must be >= source major
  return parseInt(targetMajor, 10) >= parseInt(sourceMajor, 10)
}

/**
 * Resolve a version alias to full version
 */
export function resolveVersion(version: string): string {
  // Check if it's already a full version in the map
  if (QUESTDB_VERSION_MAP[version]) {
    return QUESTDB_VERSION_MAP[version]
  }

  // If already a full version format, return as-is
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    return version
  }

  // Try major version lookup
  const majorVersion = getMajorVersion(version)
  if (majorVersion && QUESTDB_VERSION_MAP[majorVersion]) {
    return QUESTDB_VERSION_MAP[majorVersion]
  }

  return version
}
