/**
 * TypeDB version mapping
 *
 * Maps short version aliases to full versions from hostdb releases.
 * MUST stay in sync with hostdb databases.json
 */

import { logDebug } from '../../core/error-handler'

// Full version map for TypeDB
export const TYPEDB_VERSION_MAP: Record<string, string> = {
  '3': '3.8.0',
  '3.8': '3.8.0',
  '3.8.0': '3.8.0',
}

// Supported major versions (for CLI display)
export const SUPPORTED_MAJOR_VERSIONS = ['3']

// Default version
export const DEFAULT_VERSION = '3'

/**
 * Normalize a version string to its full version
 * e.g., '3' -> '3.8.0', '3.8' -> '3.8.0'
 */
export function normalizeVersion(version: string): string {
  if (!TYPEDB_VERSION_MAP[version]) {
    logDebug(
      `TypeDB version "${version}" not found in TYPEDB_VERSION_MAP (available: ${Object.keys(TYPEDB_VERSION_MAP).join(', ')}), using as-is`,
    )
  }
  return TYPEDB_VERSION_MAP[version] || version
}

/**
 * Check if a version is supported
 */
export function isVersionSupported(version: string): boolean {
  return Object.hasOwn(TYPEDB_VERSION_MAP, version)
}

/**
 * Get the latest patch version for a major version
 */
export function getLatestPatch(majorVersion: string): string | undefined {
  return TYPEDB_VERSION_MAP[majorVersion]
}
