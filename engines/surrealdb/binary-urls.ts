/**
 * SurrealDB binary URL generation
 *
 * Generates download URLs for SurrealDB binaries from hostdb.
 */

import type { Platform, Arch } from '../../types'
import { normalizeVersion } from './version-maps'

const HOSTDB_BASE_URL = 'https://github.com/robertjbass/hostdb/releases/download'

/**
 * Get the binary download URL for a specific version and platform
 *
 * URL format: https://github.com/robertjbass/hostdb/releases/download/surrealdb-{version}/surrealdb-{version}-{platform}-{arch}.{ext}
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

  return `${HOSTDB_BASE_URL}/surrealdb-${fullVersion}/surrealdb-${fullVersion}-${platform}-${arch}.${ext}`
}

/**
 * Get the archive extension for a platform
 */
export function getArchiveExtension(platform: Platform): string {
  return platform === 'win32' ? 'zip' : 'tar.gz'
}
