import { getReleaseInfo, type Platform as HostDBPlatform } from 'hostdb'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { Engine, type Platform, type Arch } from '../../types'
import { normalizeVersion } from './version-maps'

export function supportsDocumentDBPlatform(
  platform: Platform,
  arch: Arch,
  version = normalizeVersion('1'),
): boolean {
  const supportedNativeTarget =
    (platform === 'linux' && ['x64', 'arm64'].includes(arch)) ||
    (platform === 'darwin' && arch === 'arm64')
  return (
    supportedNativeTarget &&
    getReleaseInfo(
      Engine.DocumentDB,
      version,
      `${platform}-${arch}` as HostDBPlatform,
    ) !== null
  )
}

export function getBinaryUrl(
  version: string,
  platform: Platform,
  arch: Arch,
): string {
  const resolvedVersion = normalizeVersion(version)
  if (!supportsDocumentDBPlatform(platform, arch, resolvedVersion)) {
    throw new Error(
      `Native DocumentDB is not available for ${platform}-${arch}; requires Linux x64/ARM64 or macOS ARM64`,
    )
  }
  return buildHostdbUrl(Engine.DocumentDB, {
    version: resolvedVersion,
    hostdbPlatform: `${platform}-${arch}`,
    extension: 'tar.gz',
  })
}
