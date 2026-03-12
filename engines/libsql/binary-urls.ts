import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, type Platform, type Arch } from '../../types'

/**
 * Supported platform identifiers for hostdb downloads.
 * libSQL (sqld) does not have Windows binaries.
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
 * @param platform - Node.js platform (e.g., 'darwin', 'linux')
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
 * Build the download URL for libSQL binaries from hostdb
 *
 * Format: https://registry.layerbase.host/libsql-{version}/libsql-{version}-{platform}-{arch}.tar.gz
 *
 * @param version - libSQL version (e.g., '0.24', '0.24.32')
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

  // Normalize version (handles major version lookup and X.Y -> X.Y.Z conversion)
  const fullVersion = normalizeVersion(version)

  return buildHostdbUrl(Engine.LibSQL, {
    version: fullVersion,
    hostdbPlatform,
    extension: 'tar.gz',
  })
}
