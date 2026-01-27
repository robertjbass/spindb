/**
 * QuestDB Version Maps
 *
 * IMPORTANT: Keep this in sync with hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * QuestDB uses standard semantic versioning (e.g., 9.2.3)
 */

export const QUESTDB_VERSION_MAP: Record<string, string> = {
  '9': '9.2.3',
  '9.2': '9.2.3',
  '9.2.3': '9.2.3',
}

export const SUPPORTED_MAJOR_VERSIONS = ['9']
export const FALLBACK_VERSION_MAP = QUESTDB_VERSION_MAP

/**
 * Normalize a version string to a full version
 * e.g., '9' -> '9.2.3'
 */
export function normalizeVersion(version: string): string {
  // If already a full version, return as-is
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    return version
  }

  // Try to look up in version map
  const fullVersion = QUESTDB_VERSION_MAP[version]
  if (fullVersion) {
    return fullVersion
  }

  // Return as-is if not found
  return version
}
