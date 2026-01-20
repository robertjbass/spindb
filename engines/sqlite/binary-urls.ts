/**
 * SQLite Binary URL Utilities
 *
 * Simple sync wrapper around hostdb-client for backwards compatibility.
 * The actual URL building and platform validation is delegated to core/hostdb-client.ts.
 */

import { buildDownloadUrl } from '../../core/hostdb-client'
import { SQLITE_VERSION_MAP, normalizeVersion } from './version-maps'
import { Engine } from '../../types'

/**
 * Fallback map of major versions to stable patch versions
 * Used when hostdb repository is unreachable
 */
export const FALLBACK_VERSION_MAP: Record<string, string> = SQLITE_VERSION_MAP

// Legacy export for backward compatibility
export const VERSION_MAP = FALLBACK_VERSION_MAP

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
  platform: string,
  arch: string,
): string {
  const fullVersion = normalizeVersion(version)
  return buildDownloadUrl(Engine.SQLite, { version: fullVersion, platform, arch })
}

/**
 * Get the full version string for a major version
 *
 * @param majorVersion - Major version (e.g., '3')
 * @returns Full version string (e.g., '3.51.2') or null if not supported
 */
export function getFullVersion(majorVersion: string): string | null {
  return VERSION_MAP[majorVersion] || null
}
