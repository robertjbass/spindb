import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, type Platform, type Arch } from '../../types'
import { normalizeVersion } from './version-maps'

export function supportsDocumentDBPlatform(
  platform: Platform,
  arch: Arch,
): boolean {
  return (
    (platform === 'linux' && ['x64', 'arm64'].includes(arch)) ||
    (platform === 'darwin' && arch === 'arm64')
  )
}

export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  if (!supportsDocumentDBPlatform(platform, arch)) {
    throw new Error(
      `Native DocumentDB is not available for ${platform}-${arch}; requires Linux x64/ARM64 or macOS ARM64`,
    )
  }
  return buildHostdbUrl(Engine.DocumentDB, {
    version: normalizeVersion(version),
    hostdbPlatform: `${platform}-${arch}`,
    extension: 'tar.gz',
  })
}
