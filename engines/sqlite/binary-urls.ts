/**
 * SQLite Binary URL Utilities
 *
 * Simple sync wrapper around hostdb-client for backwards compatibility.
 * The actual URL building and platform validation is delegated to core/hostdb-client.ts.
 */

import { buildDownloadUrl } from '../../core/hostdb-client'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

/**
 * Build the download URL for SQLite binaries from hostdb
 *
 * Format: https://github.com/robertjbass/hostdb/releases/download/sqlite-{version}/sqlite-{version}-{platform}-{arch}.{ext}
 *
 * @param version - SQLite version (e.g., '3', '3.51.2')
 * @param platform - Platform identifier (e.g., 'darwin', 'linux', 'win32')
 * @param arch - Architecture identifier (e.g., 'arm64', 'x64')
 * @returns Download URL for the binary
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const fullVersion = normalizeVersion(version)
  return buildDownloadUrl(Engine.SQLite, {
    version: fullVersion,
    platform,
    arch,
  })
}
