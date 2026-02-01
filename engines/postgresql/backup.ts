/**
 * PostgreSQL Backup
 *
 * Creates database backups in SQL or custom (.dump) format using pg_dump.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { configManager } from '../../core/config-manager'
import {
  getWindowsSpawnOptions,
  platformService,
} from '../../core/platform-service'
import { defaults } from '../../config/defaults'
import { paths } from '../../config/paths'
import { normalizeVersion } from './version-maps'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Get pg_dump path for a specific PostgreSQL version.
 *
 * Prioritizes SpinDB-managed binaries that match the container's version,
 * falling back to system pg_dump only if no matching version is found.
 *
 * @param containerVersion - The container's PostgreSQL version (e.g., "18" or "18.1.0")
 * @returns Path to the version-matched pg_dump binary
 */
async function getPgDumpPath(containerVersion: string): Promise<string> {
  // Normalize to full version (e.g., "18" -> "18.1.0")
  const fullVersion = normalizeVersion(containerVersion)

  // Get platform info for building the binary path
  const platformInfo = platformService.getPlatformInfo()
  const ext = platformInfo.platform === 'win32' ? '.exe' : ''

  // Try to find SpinDB-managed pg_dump for the matching version
  const versionedBinPath = paths.getBinaryPath({
    engine: 'postgresql',
    version: fullVersion,
    platform: platformInfo.platform,
    arch: platformInfo.arch,
  })

  const versionedPgDump = join(versionedBinPath, 'bin', `pg_dump${ext}`)

  if (existsSync(versionedPgDump)) {
    return versionedPgDump
  }

  // Try to find any installed version for this major version
  const majorVersion = containerVersion.split('.')[0]
  const installed = paths.findInstalledBinaryForMajor(
    'postgresql',
    majorVersion,
    platformInfo.platform,
    platformInfo.arch,
  )

  if (installed) {
    const installedPgDump = join(installed.path, 'bin', `pg_dump${ext}`)
    if (existsSync(installedPgDump)) {
      return installedPgDump
    }
  }

  // Fall back to globally registered pg_dump (system binary)
  const systemPgDump = await configManager.getBinaryPath('pg_dump')
  if (systemPgDump) {
    return systemPgDump
  }

  throw new Error(
    `pg_dump not found for PostgreSQL ${containerVersion}. ` +
      `Either download PostgreSQL binaries with 'spindb create --engine postgresql --version ${majorVersion}' ` +
      'or install PostgreSQL client tools:\n' +
      '  macOS: brew install libpq && brew link --force libpq\n' +
      '  Ubuntu/Debian: apt install postgresql-client\n\n' +
      'Or configure manually: spindb config set pg_dump /path/to/pg_dump',
  )
}

/**
 * Create a backup of a PostgreSQL database
 *
 * CLI equivalent:
 * - SQL format: pg_dump -Fp -h 127.0.0.1 -p {port} -U postgres -d {database} -f {outputPath}
 * - Dump format: pg_dump -Fc -h 127.0.0.1 -p {port} -U postgres -d {database} -f {outputPath}
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port, version } = container
  const { database, format } = options

  const pgDumpPath = await getPgDumpPath(version)

  // -Fp = plain SQL format, -Fc = custom format
  const formatFlag = format === 'sql' ? '-Fp' : '-Fc'

  return new Promise((resolve, reject) => {
    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      database,
      formatFlag,
      '-f',
      outputPath,
    ]

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...getWindowsSpawnOptions(),
    }

    const proc = spawn(pgDumpPath, args, spawnOptions)

    let stderr = ''

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      reject(err)
    })

    proc.on('close', async (code) => {
      if (code === 0) {
        // Get file size
        const stats = await stat(outputPath)
        resolve({
          path: outputPath,
          format: format === 'sql' ? 'sql' : 'custom',
          size: stats.size,
        })
      } else {
        const errorMessage = stderr || `pg_dump exited with code ${code}`
        reject(new Error(errorMessage))
      }
    })
  })
}
