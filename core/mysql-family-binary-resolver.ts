/**
 * MySQL Family Binary Resolver
 *
 * Resolves a MySQL or MariaDB client binary out of spindb's own binary cache
 * (`~/.spindb/bin/<engine>-<version>-<platform>-<arch>/bin/`), preferring the
 * version the caller asks for.
 *
 * This is the MySQL-family twin of `core/pg-binary-resolver.ts`, and it exists
 * for the same reason: `configManager.getBinaryPath('mysqldump')` stores ONE
 * path per tool name with no version dimension, so on a machine with several
 * installed versions it returns whichever one was registered first and still
 * exists on disk. That is how a MySQL 9.7.2 container ended up dumping through
 * `mysql-9.6.0/bin/mysqldump`: nothing was wrong with the 9.6 binary, it was
 * simply the entry already in `config.json`.
 *
 * As with PostgreSQL, spindb owns its binaries: we never probe Homebrew, APT,
 * or any other system package manager here. The globally registered path stays
 * available as the caller's last resort.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../config/paths'
import { platformService } from './platform-service'
import { compareVersions, isVersionPrefixOf } from './version-utils'

export type MysqlFamilyEngineName = 'mysql' | 'mariadb'

export type ResolvedMysqlFamilyBinary = {
  path: string
  version: string
}

/**
 * Choose one version out of the installed ones.
 *
 * Pure, so the preference order is unit tested without a filesystem:
 * 1. the requested version exactly,
 * 2. the newest install the requested version is a prefix of, matched on
 *    version-segment boundaries (`isVersionPrefixOf`) so `11.8` never matches
 *    `11.80`,
 * 3. the newest installed version.
 *
 * Returns null only when nothing is installed.
 */
export function selectInstalledVersion(options: {
  installed: string[]
  preferVersion?: string
}): string | null {
  const { installed, preferVersion } = options
  if (installed.length === 0) return null

  const newestFirst = [...installed].sort((a, b) => compareVersions(b, a))

  if (preferVersion) {
    const exact = newestFirst.find((version) => version === preferVersion)
    if (exact) return exact

    const sameLine = newestFirst.find((version) =>
      isVersionPrefixOf(preferVersion, version),
    )
    if (sameLine) return sameLine
  }

  return newestFirst[0]
}

/**
 * List the installed versions of an engine that actually ship the given tool,
 * newest first.
 */
export function listInstalledMysqlFamilyBinaries(options: {
  engine: MysqlFamilyEngineName
  tool: string
}): ResolvedMysqlFamilyBinary[] {
  const { engine, tool } = options
  const { platform, arch } = platformService.getPlatformInfo()
  const ext = platformService.getExecutableExtension()

  return paths
    .findInstalledBinaries(engine, platform, arch)
    .map((entry) => ({
      version: entry.version,
      path: join(entry.path, 'bin', `${tool}${ext}`),
    }))
    .filter((candidate) => existsSync(candidate.path))
}

/**
 * Resolve a bundled MySQL-family binary, preferring `preferVersion`.
 *
 * Returns null when the engine has no installed version carrying that tool,
 * which is the caller's cue to fall back or to download.
 */
export function resolveBundledMysqlFamilyBinary(options: {
  engine: MysqlFamilyEngineName
  tool: string
  preferVersion?: string
}): ResolvedMysqlFamilyBinary | null {
  const candidates = listInstalledMysqlFamilyBinaries(options)
  const version = selectInstalledVersion({
    installed: candidates.map((candidate) => candidate.version),
    preferVersion: options.preferVersion,
  })

  if (!version) return null
  return candidates.find((candidate) => candidate.version === version) ?? null
}
