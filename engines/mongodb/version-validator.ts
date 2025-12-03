/**
 * MongoDB version parsing and validation
 *
 * MongoDB versions follow semver format: MAJOR.MINOR.PATCH
 * We support major versions 6.0, 7.0, and 8.0
 */

import { getEngineDefaults } from '../../config/engine-defaults'

/**
 * Parse a MongoDB version string into major.minor.patch components
 */
export function parseVersion(version: string): {
  major: number
  minor: number
  patch: number
  full: string
} | null {
  // Handle formats like "8.0", "8.0.0", "v8.0.0"
  const cleaned = version.replace(/^v/, '').trim()
  const match = cleaned.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)

  if (!match) {
    return null
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: match[3] ? parseInt(match[3], 10) : 0,
    full: `${match[1]}.${match[2]}.${match[3] || '0'}`,
  }
}

/**
 * Get the major.minor version string (e.g., "8.0" from "8.0.3")
 */
export function getMajorMinorVersion(version: string): string | null {
  const parsed = parseVersion(version)
  if (!parsed) return null
  return `${parsed.major}.${parsed.minor}`
}

/**
 * Check if a version is supported
 */
export function isSupportedVersion(version: string): boolean {
  const majorMinor = getMajorMinorVersion(version)
  if (!majorMinor) return false

  const defaults = getEngineDefaults('mongodb')
  return defaults.supportedVersions.includes(majorMinor)
}

/**
 * Validate and normalize a version string
 * Returns normalized version or throws error if invalid
 */
export function validateVersion(version: string): string {
  const defaults = getEngineDefaults('mongodb')

  // If it's just a major.minor version (e.g., "8.0"), return as-is
  if (defaults.supportedVersions.includes(version)) {
    return version
  }

  // Parse the full version
  const parsed = parseVersion(version)
  if (!parsed) {
    throw new Error(
      `Invalid MongoDB version format: "${version}". Expected format: X.Y or X.Y.Z`,
    )
  }

  // Check if the major.minor is supported
  const majorMinor = `${parsed.major}.${parsed.minor}`
  if (!defaults.supportedVersions.includes(majorMinor)) {
    throw new Error(
      `Unsupported MongoDB version: ${version}. Supported versions: ${defaults.supportedVersions.join(', ')}`,
    )
  }

  return version
}

/**
 * Get the latest supported version
 */
export function getLatestVersion(): string {
  const defaults = getEngineDefaults('mongodb')
  return defaults.latestVersion
}

/**
 * Get the default version for new containers
 */
export function getDefaultVersion(): string {
  const defaults = getEngineDefaults('mongodb')
  return defaults.defaultVersion
}

/**
 * Compare two versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
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
 * Check if version a is compatible with version b
 * Compatibility means same major.minor version
 */
export function isCompatible(versionA: string, versionB: string): boolean {
  const majorMinorA = getMajorMinorVersion(versionA)
  const majorMinorB = getMajorMinorVersion(versionB)

  if (!majorMinorA || !majorMinorB) {
    return false
  }

  return majorMinorA === majorMinorB
}

/**
 * Get all supported major.minor versions
 */
export function getSupportedVersions(): string[] {
  const defaults = getEngineDefaults('mongodb')
  return [...defaults.supportedVersions]
}
