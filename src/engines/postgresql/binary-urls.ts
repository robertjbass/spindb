import { defaults } from '@/config/defaults'

/**
 * Map major versions to latest stable patch versions
 */
export const VERSION_MAP: Record<string, string> = {
  '14': '14.15.0',
  '15': '15.10.0',
  '16': '16.6.0',
  '17': '17.2.0',
}

/**
 * Get the zonky.io platform identifier
 */
export function getZonkyPlatform(
  platform: string,
  arch: string,
): string | undefined {
  const key = `${platform}-${arch}`
  return defaults.platformMappings[key]
}

/**
 * Build the download URL for PostgreSQL binaries from zonky.io
 */
export function getBinaryUrl(
  version: string,
  platform: string,
  arch: string,
): string {
  const zonkyPlatform = getZonkyPlatform(platform, arch)
  if (!zonkyPlatform) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`)
  }

  const fullVersion = VERSION_MAP[version]
  if (!fullVersion) {
    throw new Error(
      `Unsupported PostgreSQL version: ${version}. Supported: ${Object.keys(VERSION_MAP).join(', ')}`,
    )
  }

  return `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${zonkyPlatform}/${fullVersion}/embedded-postgres-binaries-${zonkyPlatform}-${fullVersion}.jar`
}

/**
 * Get the full version string for a major version
 */
export function getFullVersion(majorVersion: string): string | null {
  return VERSION_MAP[majorVersion] || null
}
