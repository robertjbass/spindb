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

export type PrereleaseType = 'alpha' | 'beta' | 'rc'

/**
 * Parse a prerelease version string into its components.
 *
 * Accepts two shapes:
 *   - hostdb canonical form: "19.0.0-beta.1" (X.Y.Z-type.N)
 *   - upstream self-reported form: "19beta1" (X<type>N, e.g. `postgres --version`)
 *
 * Returns null for GA versions and any string that is not a recognised
 * prerelease.
 */
export function parsePrereleaseVersion(version: string): {
  major: number
  type: PrereleaseType
  num: number
} | null {
  const canonical = version.match(/^(\d+)(?:\.\d+)*-(alpha|beta|rc)\.(\d+)$/)
  if (canonical) {
    return {
      major: parseInt(canonical[1], 10),
      type: canonical[2] as PrereleaseType,
      num: parseInt(canonical[3], 10),
    }
  }

  const reported = version.match(/^(\d+)(alpha|beta|rc)(\d+)$/)
  if (reported) {
    return {
      major: parseInt(reported[1], 10),
      type: reported[2] as PrereleaseType,
      num: parseInt(reported[3], 10),
    }
  }

  return null
}

/**
 * Return true if a version string is a prerelease (alpha/beta/rc), in either
 * the canonical "19.0.0-beta.1" or self-reported "19beta1" form.
 */
export function isPrereleaseVersion(version: string): boolean {
  return parsePrereleaseVersion(version) !== null
}

/**
 * Verify that an expected prerelease version matches a binary's self-reported
 * version. This bridges hostdb's canonical form ("19.0.0-beta.1") and the
 * upstream form a server reports ("19beta1").
 *
 * Returns false when either side is not a prerelease so GA verification is
 * never loosened.
 */
export function prereleaseVersionMatches(
  expected: string,
  reported: string,
): boolean {
  const e = parsePrereleaseVersion(expected)
  const r = parsePrereleaseVersion(reported)
  if (!e || !r) return false
  return e.major === r.major && e.type === r.type && e.num === r.num
}

/**
 * Regex pattern for validating semver-like version strings.
 * Matches: X, X.Y, or X.Y.Z where each component is numeric.
 * Examples: "8", "8.0", "8.0.40", "17", "17.7.0"
 */
export const SEMVER_LIKE_PATTERN = /^\d+(\.\d+){0,2}$/

/**
 * Validate that a version string matches semver-like format (X, X.Y, or X.Y.Z).
 * Used by engines that require strict version format validation (MySQL, PostgreSQL).
 *
 * @param version - Version string to validate
 * @param engineName - Engine name for error message (e.g., 'MySQL', 'PostgreSQL')
 * @throws TypeError if version format is invalid
 */
export function validateSemverLikeVersion(
  version: string,
  engineName: string,
): void {
  if (!SEMVER_LIKE_PATTERN.test(version)) {
    throw new TypeError(
      `Invalid ${engineName} version format: "${version}". ` +
        `Expected format: X, X.Y, or X.Y.Z (e.g., "8", "8.0", "8.0.40")`,
    )
  }
}

/**
 * Return true if a version string is shorthand (not a full X.Y.Z form).
 *
 * Used by `spindb start` to detect container.version entries that pre-date
 * eager-resolution (A9) and auto-migrate them to the full form so the
 * container becomes drift-immune.
 *
 * Handles:
 *   - 1-part shorthand: '17', '8'
 *   - 2-part shorthand: '8.4', '11.8', '25.12'
 *   - Compound shorthand: '17' (postgresql-documentdb v1 backend)
 *   - Skips full 3-part semver: '17.10.0', '11.8.6'
 *   - Skips 4-part ClickHouse semver: '25.12.3.21'
 *   - Skips compound full form: '17-0.107.0'
 *
 * Returns false for strings that are already pinned-full or non-version
 * sentinels like 'unknown' (those are handled by the caller).
 */
export function isShorthandVersion(version: string): boolean {
  if (!version || version === 'unknown') return false

  // Compound format (postgresql-documentdb): `<pg-major>-<docdb-version>` like
  // `17-0.107.0`. The presence of a `-` AND a dotted suffix means it's the
  // full pinned form. Bare `17` (no `-` at all) is handled by the plain-semver
  // branch below as shorthand. A dash with no suffix dots (theoretical e.g.
  // `17-rc1`) is still shorthand — there's no patch component.
  if (version.includes('-')) {
    const [, suffix = ''] = version.split('-', 2)
    return !suffix.includes('.')
  }

  // Plain semver-like: 1-part `17` / 2-part `8.4` are shorthand;
  // 3-part `17.10.0` and 4-part ClickHouse `25.12.3.21` are full.
  const parts = version.split('.')
  return parts.length < 3
}
