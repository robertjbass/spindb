import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, type Platform, type Arch } from '../../types'
import { normalizeVersion } from './version-maps'

export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) {
    throw new Error(
      `Native DocumentDB is not available for ${platform}-${arch}; currently Linux x64 and ARM64 only`,
    )
  }
  return buildHostdbUrl(Engine.DocumentDB, {
    version: normalizeVersion(version),
    hostdbPlatform: `${platform}-${arch}`,
    extension: 'tar.gz',
  })
}
