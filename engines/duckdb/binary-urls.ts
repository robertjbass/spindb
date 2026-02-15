/**
 * DuckDB Binary URL Utilities
 *
 * Simple sync wrapper around hostdb-client for backwards compatibility.
 * The actual URL building and platform validation is delegated to core/hostdb-client.ts.
 */

import { buildDownloadUrl } from '../../core/hostdb-client'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

/**
 * Build the download URL for DuckDB binaries from hostdb
 *
 * Format: https://registry.layerbase.host/duckdb-{version}/duckdb-{version}-{platform}-{arch}.{ext}
 *
 * @param version - DuckDB version (e.g., '1', '1.4.3')
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
  return buildDownloadUrl(Engine.DuckDB, {
    version: fullVersion,
    platform,
    arch,
  })
}
