/**
 * MySQL-family data directory version cross-check.
 *
 * `start()` picks the server binary from `container.json`'s `version` alone.
 * mariadbd/mysqld will happily open whatever data directory they are pointed
 * at, and a NEWER major performs an irreversible in-place upgrade of the
 * system tables the moment it boots. MariaDB has no cross-major downgrade, so
 * a container whose pinned version names a different release line than the
 * data directory actually is must be refused before the server is spawned.
 *
 * Both servers record the last server version that opened the data directory
 * in a one-line plain text file at the data directory root:
 *   - MariaDB 11+       data/mariadb_upgrade_info  ("11.8.9-MariaDB")
 *   - MariaDB 10.x      data/mysql_upgrade_info    ("10.11.15-MariaDB")
 *   - MySQL 5.7 and older  data/mysql_upgrade_info ("5.7.44")
 * MySQL 8.0+ keeps that state in the data dictionary and writes no file, so
 * the check is simply skipped there (missing file = start as before).
 *
 * A newer PATCH on the same line is fine (11.8.8 data under 11.8.9): only the
 * major.minor line is compared.
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { ErrorCodes, SpinDBError, logDebug } from './error-handler'

// Newest first: MariaDB 11+ writes mariadb_upgrade_info, older MariaDB and
// MySQL 5.7 write mysql_upgrade_info. A data dir upgraded from 10.x to 11.x
// can carry both, and the mariadb-named file is the authoritative one.
export const UPGRADE_INFO_FILENAMES = [
  'mariadb_upgrade_info',
  'mysql_upgrade_info',
] as const

export type VersionLine = {
  major: number
  minor?: number
}

export type DataDirVersionInfo = {
  /** Basename of the file the version was read from. */
  file: string
  /** Absolute path of that file. */
  path: string
  /** The raw one-line contents, trimmed ("11.8.9-MariaDB"). */
  raw: string
  /** The parsed release line. */
  line: VersionLine
}

/**
 * Parse the leading numeric version out of an upgrade-info line or a
 * container.json version string. Returns null when there is no leading
 * major number (for example 'unknown' on linked containers).
 */
export function parseVersionLine(value: string): VersionLine | null {
  const match = /^\s*(\d+)(?:\.(\d+))?/.exec(value)
  if (!match) return null
  const major = Number(match[1])
  if (!Number.isFinite(major)) return null
  if (match[2] === undefined) return { major }
  return { major, minor: Number(match[2]) }
}

/** '11.8' for a full line, '11' when only a major is known. */
export function formatVersionLine(line: VersionLine): string {
  return line.minor === undefined
    ? `${line.major}`
    : `${line.major}.${line.minor}`
}

/**
 * True when the two versions name different release lines.
 *
 * major.minor is compared when BOTH sides carry a minor; when either side is
 * a bare major (a legacy container.json pinned to '11') only the major is
 * compared, so an unknowable minor never produces a false refusal.
 */
export function versionLinesDisagree(
  configured: VersionLine,
  dataDir: VersionLine,
): boolean {
  if (configured.major !== dataDir.major) return true
  if (configured.minor === undefined || dataDir.minor === undefined) {
    return false
  }
  return configured.minor !== dataDir.minor
}

/**
 * Read the version the data directory was last opened by. Returns null when
 * no upgrade-info file exists (fresh dir, MySQL 8+, or an unreadable file).
 */
export async function readDataDirVersion(
  dataDir: string,
): Promise<DataDirVersionInfo | null> {
  for (const file of UPGRADE_INFO_FILENAMES) {
    const path = join(dataDir, file)
    if (!existsSync(path)) continue
    let contents: string
    try {
      contents = await readFile(path, 'utf8')
    } catch (error) {
      logDebug('Could not read data directory upgrade info', {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    const raw = contents.split('\n')[0]?.trim() ?? ''
    const line = parseVersionLine(raw)
    if (!line) {
      logDebug('Unparsable data directory upgrade info', { path, raw })
      continue
    }
    return { file, path, raw, line }
  }
  return null
}

export function buildVersionMismatchMessage(options: {
  engineLabel: string
  containerName: string
  configuredVersion: string
  configuredLine: VersionLine
  dataDir: string
  info: DataDirVersionInfo
}): string {
  const {
    engineLabel,
    containerName,
    configuredVersion,
    configuredLine,
    dataDir,
    info,
  } = options
  const configuredLabel = formatVersionLine(configuredLine)
  const dataDirLabel = formatVersionLine(info.line)
  return (
    `${engineLabel} container "${containerName}" is pinned to version ` +
    `${configuredVersion} (the ${configuredLabel} line), but its data ` +
    `directory was last opened by ${info.raw} (the ${dataDirLabel} line).\n` +
    `  data directory: ${dataDir}\n` +
    `  recorded in:    ${info.path}\n` +
    `Starting the ${configuredLabel} server against ${dataDirLabel} data would ` +
    `upgrade the data directory in place, and that cannot be undone: there is ` +
    `no cross-major downgrade.\n` +
    `Fix: put the version back on the ${dataDirLabel} line and start again, ` +
    `or back up this container, create a NEW container on the ` +
    `${configuredLabel} line, and restore the backup into it. spindb cannot ` +
    `move a data directory across release lines.`
  )
}

/**
 * Refuse to start when the pinned version and the data directory name
 * different release lines. No-op when the data directory records no version.
 */
export async function assertDataDirVersionMatches(options: {
  engineLabel: string
  containerName: string
  configuredVersion: string
  dataDir: string
}): Promise<void> {
  const { engineLabel, containerName, configuredVersion, dataDir } = options
  const configuredLine = parseVersionLine(configuredVersion)
  if (!configuredLine) return
  if (!existsSync(dataDir)) return

  const info = await readDataDirVersion(dataDir)
  if (!info) return
  if (!versionLinesDisagree(configuredLine, info.line)) return

  throw new SpinDBError(
    ErrorCodes.VERSION_MISMATCH,
    buildVersionMismatchMessage({
      engineLabel,
      containerName,
      configuredVersion,
      configuredLine,
      dataDir,
      info,
    }),
    'error',
    `Start ${containerName} on the ${formatVersionLine(info.line)} line, or restore a backup into a new ${formatVersionLine(configuredLine)} container.`,
    {
      containerName,
      configuredVersion,
      dataDirVersion: info.raw,
      upgradeInfoFile: info.path,
    },
  )
}
