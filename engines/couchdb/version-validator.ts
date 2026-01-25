/**
 * CouchDB Version Validator
 *
 * Utilities for parsing, validating, and comparing CouchDB versions.
 */

import { COUCHDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'

/**
 * Parsed CouchDB version
 */
export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  full: string
}

/**
 * Parse a CouchDB version string into components.
 *
 * @param version - Version string (e.g., '3.5.1')
 * @returns Parsed version object or null if invalid
 */
export function parseVersion(version: string): ParsedVersion | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    return null
  }

  const [, major, minor, patch] = match
  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
    full: version,
  }
}

/**
 * Check if a version string is supported.
 *
 * @param version - Version string (e.g., '3', '3.5', '3.5.1')
 * @returns true if the version is supported
 */
export function isVersionSupported(version: string): boolean {
  // Check if it's in the version map
  if (COUCHDB_VERSION_MAP[version]) {
    return true
  }

  // Check if major version is supported
  const parts = version.split('.')
  const major = parts[0]
  return SUPPORTED_MAJOR_VERSIONS.includes(major)
}

/**
 * Get the major version from a version string.
 *
 * @param version - Version string (e.g., '3.5.1')
 * @returns Major version string (e.g., '3')
 */
export function getMajorVersion(version: string): string {
  const parts = version.split('.')
  return parts[0]
}

/**
 * Compare two version strings.
 *
 * @param a - First version string
 * @param b - Second version string
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) {
    // Fall back to string comparison for invalid versions
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
 * Check if two versions are compatible for backup/restore operations.
 * CouchDB versions within the same major version are generally compatible.
 *
 * @param sourceVersion - Source version
 * @param targetVersion - Target version
 * @returns true if versions are compatible
 */
export function isVersionCompatible(
  sourceVersion: string,
  targetVersion: string,
): boolean {
  const sourceMajor = getMajorVersion(sourceVersion)
  const targetMajor = getMajorVersion(targetVersion)

  // Same major version is compatible
  return sourceMajor === targetMajor
}
