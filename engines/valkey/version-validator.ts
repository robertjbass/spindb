/**
 * Valkey version validation utilities
 * Handles version parsing, comparison, and compatibility checking
 */

/**
 * Parse a Valkey version string into components
 * Handles formats like "8.0.6", "8.0", "v8.0.6"
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
 * Check if a Valkey version is supported by SpinDB
 * Minimum supported version: 8.0.0
 * Supports Valkey 8 and 9
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return parsed.major >= 8
}

/**
 * Get major version from full version string
 * e.g., "8.0.6" -> "8"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : version
}

/**
 * Get major.minor version from full version string
 * e.g., "8.0.6" -> "8.0"
 */
export function getMajorMinorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * Compare two Valkey versions
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
 * Valkey RDB files are generally forward-compatible within major versions
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
      warning: `Cannot restore Valkey ${backupVersion} RDB backup to ${restoreVersion} server. The backup is from a newer major version.`,
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
      warning: `Restoring Valkey ${backupVersion} RDB backup to ${restoreVersion} server. Valkey will upgrade the RDB format on next save.`,
    }
  }

  return { compatible: true }
}

// Validate that a version string matches supported format
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
