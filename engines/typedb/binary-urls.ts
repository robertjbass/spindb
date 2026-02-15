/**
 * TypeDB binary URL generation
 *
 * Generates download URLs for TypeDB binaries from the layerbase registry.
 */

import { type Platform, type Arch, Engine } from '../../types'
import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'

/**
 * Get the binary download URL for a specific version and platform
 *
 * URL format: https://registry.layerbase.host/typedb-{version}/typedb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - TypeDB version (e.g., '3.8.0' or '3')
 * @param platform - Target platform (darwin, linux, win32)
 * @param arch - Target architecture (x64, arm64)
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const ext = getArchiveExtension(platform)

  return buildHostdbUrl(Engine.TypeDB, {
    version: fullVersion,
    hostdbPlatform: `${platform}-${arch}`,
    extension: ext,
  })
}

/**
 * Get the archive extension for a platform
 */
export function getArchiveExtension(platform: Platform): 'tar.gz' | 'zip' {
  return platform === 'win32' ? 'zip' : 'tar.gz'
}
