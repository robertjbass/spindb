/**
 * QuestDB Binary URLs
 *
 * Constructs download URLs for QuestDB binaries from hostdb.
 * QuestDB archives are self-contained with bundled JRE.
 *
 * URL pattern:
 * https://github.com/robertjbass/hostdb/releases/download/questdb-{version}/questdb-{version}-{platform}-{arch}.tar.gz
 */

import { FALLBACK_VERSION_MAP } from './version-maps'
import { type Platform, type Arch } from '../../types'

const HOSTDB_BASE_URL =
  'https://github.com/robertjbass/hostdb/releases/download'

/**
 * Get the binary download URL for a specific version and platform
 */
export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  // Resolve to full version
  const fullVersion = FALLBACK_VERSION_MAP[version] || version

  // Construct platform key (e.g., 'darwin-arm64', 'linux-x64', 'win32-x64')
  const platformKey = `${platform}-${arch}`

  // Windows uses .zip, Unix uses .tar.gz
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'

  return `${HOSTDB_BASE_URL}/questdb-${fullVersion}/questdb-${fullVersion}-${platformKey}.${ext}`
}
