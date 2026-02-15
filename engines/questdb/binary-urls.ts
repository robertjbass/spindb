/**
 * QuestDB Binary URLs
 *
 * Constructs download URLs for QuestDB binaries from the layerbase registry.
 * QuestDB archives are self-contained with bundled JRE.
 *
 * URL pattern:
 * https://registry.layerbase.host/questdb-{version}/questdb-{version}-{platform}-{arch}.tar.gz
 */

import { FALLBACK_VERSION_MAP } from './version-maps'
import { type Platform, type Arch } from '../../types'
import { buildHostdbUrl } from '../../core/hostdb-client'

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

  // Windows uses .zip, Unix uses .tar.gz
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'

  return buildHostdbUrl('questdb', {
    version: fullVersion,
    hostdbPlatform: `${platform}-${arch}`,
    extension: ext,
  })
}
