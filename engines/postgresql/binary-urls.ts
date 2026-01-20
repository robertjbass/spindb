import {
  fetchAvailableVersions as fetchHostdbVersions,
  getLatestVersion as getHostdbLatestVersion,
} from './hostdb-releases'
import { POSTGRESQL_VERSION_MAP } from './version-maps'
import { type Platform, type Arch } from '../../types'

/**
 * Fallback map of major versions to stable patch versions
 * Used when hostdb repository is unreachable
 *
 * @deprecated Use POSTGRESQL_VERSION_MAP from version-maps.ts instead
 */
export const FALLBACK_VERSION_MAP: Record<string, string> =
  POSTGRESQL_VERSION_MAP

/**
 * Fetch available versions from hostdb repository
 *
 * This replaces the previous Maven Central (zonky.io) source with the new
 * hostdb repository at https://github.com/robertjbass/hostdb
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  return await fetchHostdbVersions()
}

// Get the latest version for a major version from hostdb
export async function getLatestVersion(major: string): Promise<string> {
  return await getHostdbLatestVersion(major)
}

// Legacy export for backward compatibility
export const VERSION_MAP = FALLBACK_VERSION_MAP

/**
 * Get the hostdb platform identifier
 *
 * hostdb uses standard platform naming (e.g., 'darwin-arm64', 'linux-x64')
 * which matches Node.js platform identifiers directly.
 *
 * @param platform - Node.js platform (e.g., 'darwin', 'linux', 'win32')
 * @param arch - Node.js architecture (e.g., 'arm64', 'x64')
 * @returns hostdb platform identifier or undefined if unsupported
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | undefined {
  const key = `${platform}-${arch}`
  const mapping: Record<string, string> = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux-x64',
    'win32-x64': 'win32-x64',
  }
  return mapping[key]
}

/**
 * Get the hostdb platform identifier
 *
 * @deprecated Use getHostdbPlatform instead. This function exists for backward compatibility.
 */
export function getZonkyPlatform(
  platform: Platform,
  arch: Arch,
): string | undefined {
  return getHostdbPlatform(platform, arch)
}

/**
 * Build the download URL for PostgreSQL binaries from hostdb
 *
 * Format: https://github.com/robertjbass/hostdb/releases/download/postgresql-{version}/postgresql-{version}-{platform}-{arch}.tar.gz
 *
 * @param version - PostgreSQL version (e.g., '17', '17.7.0')
 * @param platform - Platform identifier (e.g., 'darwin', 'linux')
 * @param arch - Architecture identifier (e.g., 'arm64', 'x64')
 * @returns Download URL for the binary
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const platformKey = `${platform}-${arch}`
  const hostdbPlatform = getHostdbPlatform(platform, arch)
  if (!hostdbPlatform) {
    throw new Error(`Unsupported platform: ${platformKey}`)
  }

  // Normalize version (handles major version lookup and X.Y -> X.Y.0 conversion)
  const fullVersion = normalizeVersion(version, VERSION_MAP)

  const tag = `postgresql-${fullVersion}`
  const filename = `postgresql-${fullVersion}-${hostdbPlatform}.tar.gz`

  return `https://github.com/robertjbass/hostdb/releases/download/${tag}/${filename}`
}

/**
 * Normalize version string to X.Y.Z format
 *
 * @param version - Version string (e.g., '17', '17.7', '17.7.0')
 * @param versionMap - Optional version map for major version lookup
 * @returns Normalized version (e.g., '17.7.0')
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = VERSION_MAP,
): string {
  // Check if it's a major version in the map
  if (versionMap[version]) {
    return versionMap[version]
  }

  // Normalize to X.Y.Z format
  const parts = version.split('.')
  if (parts.length === 2) {
    return `${version}.0`
  }
  return version
}

/**
 * Get the full version string for a major version
 *
 * @param majorVersion - Major version (e.g., '17')
 * @returns Full version string (e.g., '17.7.0') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return VERSION_MAP[majorVersion] || null
}
