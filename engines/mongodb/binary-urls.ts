/**
 * MongoDB binary URL generation for hostdb
 *
 * Generates download URLs for MongoDB binaries from the hostdb GitHub releases.
 * All platforms (macOS, Linux, Windows) use hostdb binaries.
 */

import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, Platform, type Arch } from '../../types'

// Supported platforms for MongoDB hostdb binaries
export const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'] as const
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number]

// Supported platform/arch combinations for MongoDB hostdb binaries
const SUPPORTED_PLATFORM_KEYS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
])

// Map Node.js platform/arch to hostdb platform key
export function getHostdbPlatform(
  platform: Platform,
  arch: Arch,
): string | null {
  const key = `${platform}-${arch}`
  return SUPPORTED_PLATFORM_KEYS.has(key) ? key : null
}

/**
 * Get the download URL for MongoDB binaries
 *
 * @param version - MongoDB version (major.minor or full)
 * @param platform - Operating system (darwin, linux, win32)
 * @param arch - Architecture (arm64, x64)
 * @returns Download URL
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const hostdbPlatform = getHostdbPlatform(platform, arch)

  if (!hostdbPlatform) {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. MongoDB hostdb binaries are available for: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64`,
    )
  }

  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'

  return buildHostdbUrl(Engine.MongoDB, {
    version: fullVersion,
    hostdbPlatform,
    extension: ext,
  })
}
