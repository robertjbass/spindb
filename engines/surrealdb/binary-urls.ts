/**
 * SurrealDB binary URL generation
 *
 * Generates download URLs for SurrealDB binaries from the layerbase registry.
 */

import type { Platform, Arch } from '../../types'
import { normalizeVersion } from './version-maps'
import { buildHostdbUrl } from '../../core/hostdb-client'

/**
 * Get the binary download URL for a specific version and platform
 *
 * URL format: https://registry.layerbase.host/surrealdb-{version}/surrealdb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - SurrealDB version (e.g., '2.3.2' or '2')
 * @param platform - Target platform (darwin, linux, win32)
 * @param arch - Target architecture (x64, arm64)
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'

  return buildHostdbUrl('surrealdb', {
    version: fullVersion,
    hostdbPlatform: `${platform}-${arch}`,
    extension: ext,
  })
}

/**
 * Get the archive extension for a platform
 */
export function getArchiveExtension(platform: Platform): string {
  return platform === 'win32' ? 'zip' : 'tar.gz'
}
