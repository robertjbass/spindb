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
import { platformService } from '../../core/platform-service'
import { ferretdbBinaryManager } from './binary-manager'
import {
  normalizeDocumentDBVersion,
  DEFAULT_DOCUMENTDB_VERSION,
} from './version-maps'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Get the path to pg_dump from the postgresql-documentdb installation
 */
function getPgDumpPath(container: ContainerConfig): string {
  const { backendVersion } = container
  const { platform, arch } = platformService.getPlatformInfo()

  const fullBackendVersion = normalizeDocumentDBVersion(
    backendVersion || DEFAULT_DOCUMENTDB_VERSION,
  )
  const documentdbPath = ferretdbBinaryManager.getDocumentDBBinaryPath(
    fullBackendVersion,
    platform,
    arch,
  )

  return join(documentdbPath, 'bin', 'pg_dump')
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

  const pgDump = getPgDumpPath(container)

  if (!existsSync(pgDump)) {
    throw new Error(
      `pg_dump not found at ${pgDump}. Make sure postgresql-documentdb is installed.`,
    )
  }

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
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(pgDump, args, spawnOptions)

    let stderr = ''

    proc.stdout?.on('data', () => {
      // pg_dump outputs to file, stdout is typically empty
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', async (code) => {
      if (code === 0) {
        // Get backup size
        let size = 0
        try {
          const stats = await stat(outputPath)
          size = stats.size
        } catch {
          // Size calculation failed, use 0
        }

        resolve({
          path: outputPath,
          format: format === 'custom' ? 'custom' : 'plain',
          size,
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
  return createBackup(container, outputPath, {
    database: 'ferretdb',
    format: 'custom',
  })
}
