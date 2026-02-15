/**
 * SurrealDB version mapping
 *
 * Maps short version aliases to full versions from hostdb releases.
 * MUST stay in sync with hostdb databases.json
 */

// Full version map for SurrealDB
export const SURREALDB_VERSION_MAP: Record<string, string> = {
  '2': '2.3.2',
  '2.3': '2.3.2',
  '2.3.2': '2.3.2',
}

// Supported major versions (for CLI display)
export const SUPPORTED_MAJOR_VERSIONS = ['2']

// Default version
export const DEFAULT_VERSION = '2'

/**
 * Normalize a version string to its full version
 * e.g., '2' -> '2.3.2', '2.3' -> '2.3.2'
 */
export function normalizeVersion(version: string): string {
  return SURREALDB_VERSION_MAP[version] || version
}

/**
 * Check if a version is supported
 */
export function isVersionSupported(version: string): boolean {
  return version in SURREALDB_VERSION_MAP
}

/**
 * Get the latest patch version for a major version
 */
export function getLatestPatch(majorVersion: string): string | undefined {
  return SURREALDB_VERSION_MAP[majorVersion]
}
