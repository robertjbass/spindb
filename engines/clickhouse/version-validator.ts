/**
 * ClickHouse version validation utilities
 * Handles version parsing, comparison, and compatibility checking
 *
 * ClickHouse uses YY.MM.X.build versioning (e.g., 25.12.3.21)
 * - YY: Year (2-digit)
 * - MM: Month
 * - X: Patch number
 * - build: Build number
 */

/**
 * Parse a ClickHouse version string into components
 * Handles formats like "25.12.3.21", "25.12.3", "25.12", "v25.12.3.21"
 */
export function parseVersion(versionString: string): {
  year: number
  month: number
  patch: number
  build: number
  raw: string
} | null {
  const cleaned = versionString.replace(/^v/, '').trim()
  const parts = cleaned.split('.')

  if (parts.length < 2) return null

  const year = parseInt(parts[0], 10)
  const month = parseInt(parts[1], 10)
  const patch = parts[2] ? parseInt(parts[2], 10) : 0
  const build = parts[3] ? parseInt(parts[3], 10) : 0

  if (isNaN(year) || isNaN(month)) return null
  if (parts[2] && isNaN(patch)) return null
  if (parts[3] && isNaN(build)) return null

  return { year, month, patch, build, raw: cleaned }
}

/**
 * Check if a ClickHouse version is supported by SpinDB
 * Minimum supported version: 24.1.0.0
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  // Support ClickHouse 24.x and newer
  return parsed.year >= 24
}

/**
 * Get major version from full version string (YY.MM format)
 * e.g., "25.12.3.21" -> "25.12"
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.year}.${parsed.month}`
}

/**
 * Get major.minor.patch version from full version string
 * e.g., "25.12.3.21" -> "25.12.3"
 */
export function getMajorMinorPatchVersion(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed) return version
  return `${parsed.year}.${parsed.month}.${parsed.patch}`
}

/**
 * Compare two ClickHouse versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b, null if either version cannot be parsed
 */
export function compareVersions(a: string, b: string): number | null {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  if (!parsedA || !parsedB) {
    return null
  }

  if (parsedA.year !== parsedB.year) {
    return parsedA.year < parsedB.year ? -1 : 1
  }
  if (parsedA.month !== parsedB.month) {
    return parsedA.month < parsedB.month ? -1 : 1
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1
  }
  if (parsedA.build !== parsedB.build) {
    return parsedA.build < parsedB.build ? -1 : 1
  }
  return 0
}

/**
 * Check if a backup version is compatible with the restore version
 * ClickHouse is generally forward-compatible for backups
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

  // Cannot restore backup from much newer version
  // Calculate total months to handle year boundaries correctly
  const backupMonths = backup.year * 12 + backup.month
  const restoreMonths = restore.year * 12 + restore.month

  if (backupMonths > restoreMonths + 6) {
    // More than 6 months newer
    return {
      compatible: false,
      warning: `Cannot restore ClickHouse ${backupVersion} backup to ${restoreVersion} server. The backup is from a much newer version.`,
    }
  }

  // Allow same or close versions
  if (backupMonths === restoreMonths) {
    return { compatible: true }
  }

  // Allow upgrading from older version
  if (restoreMonths > backupMonths) {
    return {
      compatible: true,
      warning: `Restoring ClickHouse ${backupVersion} backup to ${restoreVersion} server. Schema may need updates.`,
    }
  }

  // Restoring to slightly older version (within 6 months)
  return {
    compatible: true,
    warning: `Restoring ClickHouse ${backupVersion} backup to older ${restoreVersion} server. Some features may not be available.`,
  }
}

// Validate that a version string matches supported format
export function isValidVersionFormat(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null
}
