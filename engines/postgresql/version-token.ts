/**
 * The PostgreSQL version token shared by the tool-version, dump-header, and
 * remote server-version parsers. Kept in its own module so version-validator
 * and remote-version can both use it without importing each other.
 */

export type VersionInfo = {
  major: number
  minor: number
  patch: number
  full: string
  /** Set for a prerelease such as `19beta3` or `19rc1`; absent for a release. */
  prerelease?: string
}

/**
 * A PostgreSQL version as it appears in `--version` output, `server_version`,
 * and dump headers: `16.1`, `17.0`, `14.9.1`, or a prerelease like `19beta3`
 * / `19rc1`, which carries NO minor. A bare major with neither a dot nor a
 * prerelease tag is deliberately not matched, so a stray number elsewhere in
 * the line (a distro build string, a date) cannot pass for the version.
 */
export const POSTGRES_VERSION_PATTERN =
  /(\d+)(?:\.(\d+)(?:\.(\d+))?|((?:alpha|beta|rc)\d+))/

/**
 * Parse the first PostgreSQL version token in `text`, or null if there is none.
 * A prerelease reports minor 0 and patch 0 with the tag in `prerelease`.
 */
export function parsePostgresVersionToken(text: string): VersionInfo | null {
  const match = text.match(POSTGRES_VERSION_PATTERN)
  if (!match) return null
  const [full, major, minor, patch, prerelease] = match
  return {
    major: parseInt(major, 10),
    minor: parseInt(minor || '0', 10),
    patch: parseInt(patch || '0', 10),
    full,
    ...(prerelease ? { prerelease } : {}),
  }
}
