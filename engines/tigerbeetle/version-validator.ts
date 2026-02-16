/**
 * TigerBeetle version validation utilities
 * Handles version parsing, comparison, and compatibility checking
 */

/**
 * Parse a TigerBeetle version string into components
 * Handles formats like "0.16.70", "0.16", "v0.16.70"
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  if (!cleaned) return null

  const parts = cleaned.split('.')

  const major = parseInt(parts[0], 10)
  const minor = parts[1] ? parseInt(parts[1], 10) : 0
  const patch = parts[2] ? parseInt(parts[2], 10) : 0

  if (isNaN(major)) return null
  if (parts[1] && isNaN(minor)) return null
  if (parts[2] && isNaN(patch)) return null

  return { major, minor, patch, raw: cleaned }
}

/**
 * Check if a TigerBeetle version is supported by SpinDB
 * Minimum supported version: 0.16.0
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  // Support 0.16+
  if (parsed.major === 0) {
    return parsed.minor >= 16
  }
  return parsed.major >= 1
}

/**
 * Get major version from full version string (xy-format: 2-part)
 * e.g., "0.16.70" -> "0.16"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * Get major.minor version from full version string.
 * Intentional alias for getMajorVersion — both return the 2-part xy-format
 * version (e.g., "0.16"). Kept as a separate export for API consistency
 * with other engine version validators.
 */
export function getMajorMinorVersion(version: string): string {
  return getMajorVersion(version)
}

/**
 * Compare two TigerBeetle versions
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
 * TigerBeetle data files are generally compatible within minor versions
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

  // Must be same major.minor for TigerBeetle
  if (backup.major !== restore.major || backup.minor !== restore.minor) {
    return {
      compatible: false,
      warning: `Cannot restore TigerBeetle ${backupVersion} data to ${restoreVersion} server. Major.minor versions must match.`,
    }
  }

  return { compatible: true }
}

/**
 * Validate that a version string matches supported format
 */
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
