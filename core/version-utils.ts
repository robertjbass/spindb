/**
 * Shared version comparison utilities
 *
 * Provides robust version comparison that handles prerelease suffixes
 * like "11.8.0-rc1" or "7.4.7-beta2".
 */

/**
 * Parse a version segment into numeric prefix and suffix
 *
 * Expected format: optional digits followed by optional suffix
 * Examples:
 *   "7"     -> { num: 7, suffix: "" }
 *   "7-rc1" -> { num: 7, suffix: "-rc1" }
 *   "0"     -> { num: 0, suffix: "" }
 *
 * Non-numeric segments (no leading digits):
 *   "abc"   -> { num: -1, suffix: "abc" }
 *   ""      -> { num: -1, suffix: "" }
 *
 * Use num === -1 to detect non-numeric segments. When comparing versions,
 * non-numeric segments sort before numeric ones (since -1 < 0).
 *
 * @param segment - A single version segment (part between dots)
 * @returns Object with numeric prefix and remaining suffix
 */
export function parseVersionSegment(segment: string): {
  num: number
  suffix: string
} {
  const match = segment.match(/^(\d+)(.*)$/)
  if (!match) {
    // Non-numeric segment: use -1 as sentinel so callers can distinguish
    return { num: -1, suffix: segment }
  }
  return { num: parseInt(match[1], 10), suffix: match[2] }
}

/**
 * Compare two version strings (e.g., "11.8.5" vs "11.8.4")
 * Handles prerelease suffixes like "11.8.0-rc1" - empty suffix sorts after prerelease
 * Returns positive if a > b, negative if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.')
  const partsB = b.split('.')

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const segA = parseVersionSegment(partsA[i] || '0')
    const segB = parseVersionSegment(partsB[i] || '0')

    // Compare numeric parts first
    if (segA.num !== segB.num) {
      return segA.num - segB.num
    }

    // If numeric parts equal, compare suffixes
    // Empty suffix (release) > prerelease suffix (e.g., "-rc1")
    if (segA.suffix !== segB.suffix) {
      if (segA.suffix === '') return 1 // a is release, b is prerelease
      if (segB.suffix === '') return -1 // b is release, a is prerelease
      // NOTE: Lexicographic comparison means -rc10 < -rc2 (incorrect for numeric suffixes).
      // This is acceptable for hostdb versions which use single-digit prereleases.
      // If multi-digit prereleases are needed, parse numeric suffix separately.
      return segA.suffix.localeCompare(segB.suffix)
    }
  }
  return 0
}

/**
 * Check if versionA is newer than versionB
 * Convenience wrapper around compareVersions
 */
export function isNewerVersion(versionA: string, versionB: string): boolean {
  return compareVersions(versionA, versionB) > 0
}
