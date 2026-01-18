/**
 * DuckDB Version Validator
 *
 * Handles version parsing, validation, and compatibility checking for DuckDB.
 */

import { DUCKDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'

export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  full: string
}

/**
 * Parse a version string into its components.
 *
 * @param version - Version string (e.g., '1.4.3', '1.4', '1')
 * @returns Parsed version object or null if invalid
 */
export function parseVersion(version: string): ParsedVersion | null {
  const parts = version.split('.')

  if (parts.length < 1 || parts.length > 3) {
    return null
  }

  const major = parseInt(parts[0], 10)
  const minor = parts.length >= 2 ? parseInt(parts[1], 10) : 0
  const patch = parts.length >= 3 ? parseInt(parts[2], 10) : 0

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    return null
  }

  return {
    major,
    minor,
    patch,
    full: `${major}.${minor}.${patch}`,
  }
}

/**
 * Check if a version is supported by SpinDB.
 *
 * @param version - Version string to check
 * @returns True if the version is supported
 */
export function isVersionSupported(version: string): boolean {
  // Check if version is in the map directly
  if (DUCKDB_VERSION_MAP[version]) {
    return true
  }

  // Check if major version is supported
  const parsed = parseVersion(version)
  if (!parsed) {
    return false
  }

  return SUPPORTED_MAJOR_VERSIONS.includes(String(parsed.major))
}

/**
 * Get the major version from a version string.
 *
 * @param version - Version string (e.g., '1.4.3')
 * @returns Major version string (e.g., '1') or null if invalid
 */
export function getMajorVersion(version: string): string | null {
  const parsed = parseVersion(version)
  if (!parsed) {
    return null
  }
  return String(parsed.major)
}

/**
 * Compare two version strings.
 *
 * @param a - First version
 * @param b - Second version
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) {
    return 0
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
 * Check if two versions are compatible for backup/restore operations.
 * DuckDB uses storage format versioning, so major versions should match.
 *
 * @param sourceVersion - Version of the source database
 * @param targetVersion - Version of the target database
 * @returns True if versions are compatible
 */
export function isVersionCompatible(
  sourceVersion: string,
  targetVersion: string,
): boolean {
  const sourceMajor = getMajorVersion(sourceVersion)
  const targetMajor = getMajorVersion(targetVersion)

  if (!sourceMajor || !targetMajor) {
    return false
  }

  // Major versions should match for compatibility
  return sourceMajor === targetMajor
}

/**
 * Get all supported versions.
 *
 * @returns Array of supported version strings
 */
export function getSupportedVersions(): string[] {
  return SUPPORTED_MAJOR_VERSIONS
}
