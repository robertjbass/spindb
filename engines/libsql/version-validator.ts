/**
 * libSQL version validation utilities
 * Handles version parsing, comparison, and compatibility checking
 */

/**
 * Parse a libSQL version string into components
 * Handles formats like "0.24.32", "0.24", "v0.24.32"
 */
export function parseVersion(versionString: string): {
  major: number
  minor: number
  patch: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  if (!cleaned) return null

  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  if (!match) return null

  const major = Number(match[1])
  const minor = match[2] ? Number(match[2]) : 0
  const patch = match[3] ? Number(match[3]) : 0

  return { major, minor, patch, raw: cleaned }
}

/**
 * Check if a libSQL version is supported by SpinDB
 * Minimum supported version: 0.24.0
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  // Support 0.24+
  if (parsed.major === 0) {
    return parsed.minor >= 24
  }
  return parsed.major >= 1
}

/**
 * Get major version from full version string
 * e.g., "0.24.32" -> "0"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : version
}

/**
 * Get major.minor version from full version string
 * e.g., "0.24.32" -> "0.24"
 */
export function getMajorMinorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.major}.${parsed.minor}`
}

/**
 * Compare two libSQL versions
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
 * libSQL backups are generally compatible within major versions
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

  // Cannot restore newer backup to older server
  if (backup.major > restore.major) {
    return {
      compatible: false,
      warning: `Cannot restore libSQL ${backupVersion} backup to ${restoreVersion} server. The backup is from a newer major version.`,
    }
  }

  // Allow same major version
  if (backup.major === restore.major) {
    return { compatible: true }
  }

  // Allow upgrading from older major version (restore.major > backup.major)
  return {
    compatible: true,
    warning: `Restoring libSQL ${backupVersion} backup to ${restoreVersion} server. libSQL will upgrade the data format on next save.`,
  }
}

/**
 * Validate that a version string matches supported format
 */
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
