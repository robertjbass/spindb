/**
 * Redis version validation utilities
 * Handles version parsing, comparison, and compatibility checking
 */

/**
 * Parse a Redis version string into components
 * Handles formats like "7.2.4", "7.2", "v7.2.4"
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  const parts = cleaned.split('.')

  if (parts.length < 1) return null

  const major = parseInt(parts[0], 10)
  const minor = parts[1] ? parseInt(parts[1], 10) : 0
  const patch = parts[2] ? parseInt(parts[2], 10) : 0

  if (isNaN(major)) return null

  return { major, minor, patch, raw: cleaned }
}

/**
 * Check if a Redis version is supported by SpinDB
 * Minimum supported version: 6.0.0
 * Supports Redis 6, 7, and 8
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return parsed.major >= 6
}

/**
 * Get major version from full version string
 * e.g., "7.2.4" -> "7"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : version
}

/**
 * Get major.minor version from full version string
 * e.g., "7.2.4" -> "7.2"
 */
export function getMajorMinorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * Compare two Redis versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) return 0

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
 * Redis RDB files are generally forward-compatible within major versions
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

  // Cannot restore newer RDB to older server
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `Cannot restore Redis ${backupVersion} RDB backup to ${restoreVersion} server. The backup is from a newer major version.`,
    }
  }

  // Allow same major version
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // Allow upgrading from older major version
  if (restore.major > backup.major) {
    return {
      compatible: true,
      warning: `Restoring Redis ${backupVersion} RDB backup to ${restoreVersion} server. Redis will upgrade the RDB format on next save.`,
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
