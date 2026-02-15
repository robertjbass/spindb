import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

/**
 * Supported platform identifiers for hostdb downloads.
 * hostdb uses standard Node.js platform naming - this set validates
 * that a platform/arch combination is supported, not transforms it.
 */
const SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
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
 * Build the download URL for InfluxDB binaries from hostdb
 *
 * Format: https://registry.layerbase.host/influxdb-{version}/influxdb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - InfluxDB version (e.g., '3', '3.8.0')
 * @param platform - Platform identifier (e.g., 'darwin', 'linux', 'win32')
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
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.InfluxDB, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}
