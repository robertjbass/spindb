/**
 * FerretDB backup module
 *
 * Creates backups using pg_dump on the embedded PostgreSQL backend.
 * This backs up the ferretdb database which contains all MongoDB-compatible data.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { mkdir } from 'fs/promises'
import { logDebug } from '../../core/error-handler'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { ferretdbBinaryManager } from './binary-manager'
import {
  DEFAULT_DOCUMENTDB_VERSION,
  DEFAULT_V1_POSTGRESQL_VERSION,
  isV1,
} from './version-maps'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Get the path to pg_dump from the backend installation.
 *
 * Searches with fallbacks:
 * 1. Container's specific backend binary directory
 * 2. Any installed PostgreSQL version (newest first) — pg_dump is forward-compatible
 * 3. System binary registered via `spindb config set pg_dump`
 */
async function getPgDumpPath(container: ContainerConfig): Promise<string> {
  const { version, backendVersion } = container
  const { platform, arch } = platformService.getPlatformInfo()
  const v1 = isV1(version)
  const ext = platformService.getExecutableExtension()

  const effectiveBackendVersion = v1
    ? backendVersion || DEFAULT_V1_POSTGRESQL_VERSION
    : backendVersion || DEFAULT_DOCUMENTDB_VERSION

  // 1. Try the container's own backend path
  const backendPath = ferretdbBinaryManager.getBackendBinaryPath(
    version,
    effectiveBackendVersion,
    platform,
    arch,
  )
  const primaryPath = join(backendPath, 'bin', `pg_dump${ext}`)
  if (existsSync(primaryPath)) {
    return primaryPath
  }

  logDebug(
    `pg_dump not found at ${primaryPath}, searching other installed PostgreSQL versions`,
  )

  // 2. Search all installed PostgreSQL versions (newest first)
  const installed = paths.findInstalledBinaries('postgresql', platform, arch)
  for (const entry of installed) {
    const candidate = join(entry.path, 'bin', `pg_dump${ext}`)
    if (existsSync(candidate)) {
      logDebug(`Found pg_dump in PostgreSQL ${entry.version}`)
      return candidate
    }
  }

  // Also check postgresql-documentdb installations
  const documentdbInstalled = paths.findInstalledBinaries(
    'postgresql-documentdb',
    platform,
    arch,
  )
  for (const entry of documentdbInstalled) {
    const candidate = join(entry.path, 'bin', `pg_dump${ext}`)
    if (existsSync(candidate)) {
      logDebug(`Found pg_dump in postgresql-documentdb ${entry.version}`)
      return candidate
    }
  }

  // 3. Fall back to system binary
  const systemPgDump = await configManager.getBinaryPath('pg_dump')
  if (systemPgDump) {
    return systemPgDump
  }

  const backendName = v1 ? 'PostgreSQL' : 'postgresql-documentdb'
  throw new Error(
    `pg_dump not found. The ${backendName} installation at ${backendPath} does not include client tools.\n` +
      'Install PostgreSQL client tools:\n' +
      '  macOS: brew install libpq && brew link --force libpq\n' +
      '  Ubuntu/Debian: apt install postgresql-client\n\n' +
      'Or configure manually: spindb config set pg_dump /path/to/pg_dump',
  )
}

/**
 * Create a backup of a FerretDB database using pg_dump
 *
 * Supports two formats:
 * - 'sql': Plain SQL text format
 * - 'custom' (default): PostgreSQL custom format (.dump)
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { backendPort } = container
  const database = options.database || 'ferretdb'

  if (!backendPort) {
    throw new Error(
      'Backend port not set. Make sure the container is running before creating a backup.',
    )
  }

  const pgDump = await getPgDumpPath(container)

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  const args: string[] = [
    '-h',
    '127.0.0.1',
    '-p',
    String(backendPort),
    '-U',
    'postgres',
    '--no-password',
    '-d',
    database,
  ]

  // Determine output format (default to 'sql' as per backup-formats.ts)
  const format = options.format ?? 'sql'
  if (format === 'custom') {
    // Custom format: binary, compressed, supports parallel restore
    args.push('-Fc', '-f', outputPath)
  } else {
    // SQL format: plain text, human-readable
    args.push('-f', outputPath)
  }

  logDebug(`Running pg_dump with args: ${args.join(' ')}`)

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'ignore', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(pgDump, args, spawnOptions)

    let stderr = ''
    let finished = false

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      if (finished) return
      finished = true
      reject(err)
    })

    proc.on('close', (code) => {
      if (finished) return
      finished = true

      if (code === 0) {
        // Get backup size
        stat(outputPath)
          .then((stats) => {
            resolve({
              path: outputPath,
              format,
              size: stats.size,
            })
          })
          .catch(() => {
            // Size calculation failed, use 0
            resolve({
              path: outputPath,
              format,
              size: 0,
            })
          })
      } else {
        reject(new Error(stderr || `pg_dump exited with code ${code}`))
      }
    })
  })
}

/**
 * Create a backup for cloning purposes
 * Uses custom format by default for reliability and smaller size
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  // FerretDB stores all MongoDB-compatible document data in a PostgreSQL database
  // named 'ferretdb'. This is the backend database that pg_dump targets.
  // See CLAUDE.md "FerretDB (Composite Engine)" section for architecture details.
  return createBackup(container, outputPath, {
    database: 'ferretdb',
    format: 'custom',
  })
}
