/**
 * PostgreSQL Binary Resolver
 *
 * Resolves the correct pg_dump / pg_restore / psql / pg_basebackup binary for a
 * requested major version. SpinDB owns all of its database binaries: they are
 * downloaded by hostdb and stored under ~/.spindb/bin/postgresql-<version>-<platform>-<arch>/bin/.
 *
 * We do NOT look at system-installed PostgreSQL (Homebrew, APT, YUM, etc.).
 * If a matching bundled binary is not present, the correct remediation is to
 * run `spindb engines download postgresql <major>`, not to install a separate
 * copy via a system package manager.
 */

import { existsSync } from 'fs'
import { paths } from '../config/paths'
import { platformService } from './platform-service'

export type PostgresClientTool =
  | 'pg_dump'
  | 'pg_restore'
  | 'psql'
  | 'pg_basebackup'

export type InstalledPostgresVersion = {
  majorVersion: string // e.g., "14", "17"
  fullVersion: string // e.g., "17.7.0", "18.1.0"
  binPath: string // e.g., ~/.spindb/bin/postgresql-18.1.0-darwin-arm64/bin
}

/**
 * Resolve the path to a PostgreSQL tool inside SpinDB's bundled binary cache.
 *
 * Returns the newest installed patch release for the requested major version,
 * or null if no matching bundled binary is present.
 */
export function getBundledBinaryPath(
  tool: PostgresClientTool,
  majorVersion: string,
): string | null {
  const { platform, arch } = platformService.getPlatformInfo()
  const installed = paths.findInstalledBinaryForMajor(
    'postgresql',
    majorVersion,
    platform,
    arch,
  )
  if (!installed) return null

  const ext = platformService.getExecutableExtension()
  const toolPath = `${installed.path}/bin/${tool}${ext}`
  return existsSync(toolPath) ? toolPath : null
}

/**
 * Scan SpinDB's bundled binary cache for every installed PostgreSQL version.
 * Returned entries are sorted newest-first (by version, via paths.findInstalledBinaries).
 */
export function detectInstalledPostgres(): InstalledPostgresVersion[] {
  const { platform, arch } = platformService.getPlatformInfo()
  const installed = paths.findInstalledBinaries('postgresql', platform, arch)
  const ext = platformService.getExecutableExtension()
  const bundled: InstalledPostgresVersion[] = []

  for (const entry of installed) {
    const binDir = `${entry.path}/bin`
    if (!existsSync(`${binDir}/pg_dump${ext}`)) continue

    const majorVersion = entry.version.split('.')[0]
    if (!majorVersion) continue

    bundled.push({
      majorVersion,
      fullVersion: entry.version,
      binPath: binDir,
    })
  }

  return bundled
}

/**
 * Find the lowest installed bundled version that can read data from a server
 * at the target major version (i.e., version >= targetMajor).
 *
 * Returns null if no compatible bundled binary is available.
 */
export function findCompatibleVersion(
  targetMajor: number,
): InstalledPostgresVersion | null {
  const installed = detectInstalledPostgres()
  const compatible = installed.filter(
    (v) => parseInt(v.majorVersion, 10) >= targetMajor,
  )

  if (compatible.length === 0) {
    return null
  }

  // Prefer the lowest compatible major (closest to the remote server).
  compatible.sort(
    (a, b) => parseInt(a.majorVersion, 10) - parseInt(b.majorVersion, 10),
  )
  return compatible[0]
}

/**
 * Get versioned tool paths for a specific PostgreSQL major version.
 * Returns null for any tool that isn't present in the bundled install.
 */
export function getVersionedToolPaths(majorVersion: string): {
  pgDump: string | null
  pgRestore: string | null
  psql: string | null
  pgBasebackup: string | null
} {
  return {
    pgDump: getBundledBinaryPath('pg_dump', majorVersion),
    pgRestore: getBundledBinaryPath('pg_restore', majorVersion),
    psql: getBundledBinaryPath('psql', majorVersion),
    pgBasebackup: getBundledBinaryPath('pg_basebackup', majorVersion),
  }
}
