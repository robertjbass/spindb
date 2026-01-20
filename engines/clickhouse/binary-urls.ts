import { CLICKHOUSE_VERSION_MAP } from './version-maps'
import { logDebug } from '../../core/error-handler'
import { type Platform, type Arch } from '../../types'

/**
 * Supported platform identifiers for hostdb downloads.
 * Note: ClickHouse on hostdb doesn't support Windows currently.
 */
const SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
])

/**
 * Get the hostdb platform identifier
 *
 * hostdb uses standard platform naming that matches Node.js identifiers directly.
 * This function validates the platform/arch combination is supported.
 *
 * @param platform - Node.js platform (e.g., 'darwin', 'linux', 'win32')
 * @param arch - Node.js architecture (e.g., 'arm64', 'x64')
 * @returns hostdb platform identifier or null if unsupported
 */
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORMS.has(key) ? key : null
}

/**
 * Build the download URL for ClickHouse binaries from hostdb
 *
 * Format: https://github.com/robertjbass/hostdb/releases/download/clickhouse-{version}/clickhouse-{version}-{platform}-{arch}.tar.gz
 *
 * @param version - ClickHouse version (e.g., '25.12', '25.12.3.21')
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
    const supported = Array.from(SUPPORTED_PLATFORMS).join(', ')
    throw new Error(
      `Unsupported platform: ${platformKey}. Supported platforms: ${supported}`,
    )
  }

  // Normalize version (handles major version lookup)
  const fullVersion = normalizeVersion(version, CLICKHOUSE_VERSION_MAP)

  const tag = `clickhouse-${fullVersion}`
  // ClickHouse on hostdb uses tar.gz for all platforms (no Windows support)
  const filename = `clickhouse-${fullVersion}-${hostdbPlatform}.tar.gz`

  return `https://github.com/robertjbass/hostdb/releases/download/${tag}/${filename}`
}

/**
 * Normalize version string to full version format
 *
 * @param version - Version string (e.g., '25.12', '25.12.3', '25.12.3.21')
 * @param versionMap - Optional version map for version lookup
 * @returns Normalized version (e.g., '25.12.3.21')
 */
function normalizeVersion(
  version: string,
  versionMap: Record<string, string> = CLICKHOUSE_VERSION_MAP,
): string {
  // Check if it's an exact key in the map
  if (versionMap[version]) {
    return versionMap[version]
  }

  const parts = version.split('.')

  // If it's already a full version (4 parts), return as-is
  if (parts.length === 4) {
    return version
  }

  // For partial versions, try to find a match
  if (parts.length === 3) {
    // Try YY.MM.X format
    const threePart = `${parts[0]}.${parts[1]}.${parts[2]}`
    if (versionMap[threePart]) {
      return versionMap[threePart]
    }
  }

  if (parts.length === 2) {
    // Try YY.MM format
    const twoPart = `${parts[0]}.${parts[1]}`
    if (versionMap[twoPart]) {
      return versionMap[twoPart]
    }
  }

  // Unknown version format - log and return as-is
  logDebug(
    `ClickHouse version '${version}' not in version map, may not be available in hostdb`,
  )
  return version
}

/**
 * Get the full version string for a version
 *
 * Supports partial version lookups (e.g., '25.12' -> '25.12.3.21')
 * by delegating to normalizeVersion for consistent behavior.
 *
 * @param version - Version (e.g., '25.12', '25.12.3.21')
 * @returns Full version string (e.g., '25.12.3.21') or null if not in version map
 */
