/**
 * TigerBeetle restore module
 * Supports restoring from a TigerBeetle data file backup.
 *
 * Restore copies the backup data file into the container's data directory.
 * The server must be stopped before restore.
 */

import { copyFile, mkdir } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Detect backup format from a file path.
 * TigerBeetle backups are single binary data files.
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file not found: ${filePath}`)
  }

  const stats = statSync(filePath)

  // TigerBeetle data files are regular files (not directories)
  if (stats.isFile()) {
    if (filePath.endsWith('.tigerbeetle')) {
      return {
        format: 'binary',
        description: 'TigerBeetle data file',
        restoreCommand: 'Copy to data directory (spindb restore handles this)',
      }
    }

    // Check for common backup naming patterns
    return {
      format: 'binary',
      description: 'TigerBeetle data file (assumed from file)',
      restoreCommand: 'Copy to data directory (spindb restore handles this)',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use a TigerBeetle data file (.tigerbeetle) for restore',
  }
}

// Restore options for TigerBeetle
export type RestoreOptions = {
  containerName: string
  dataDir: string
}

/**
 * Restore from a TigerBeetle data file backup.
 * Copies the backup file into the container's data directory.
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { dataDir } = options

  if (!existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`)
  }

  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true })
  }

  const targetPath = join(dataDir, '0_0.tigerbeetle')

  logDebug(`Restoring TigerBeetle data file to: ${targetPath}`)
  await copyFile(backupPath, targetPath)

  return {
    format: 'binary',
    stdout: `Restored TigerBeetle data file to ${targetPath}`,
    code: 0,
  }
}

/**
 * Parse TigerBeetle connection string
 * Format: host:port or 127.0.0.1:port
 *
 * TigerBeetle uses a custom binary protocol (no URI scheme).
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid TigerBeetle connection string: expected a non-empty string',
    )
  }

  const trimmed = connectionString.trim()

  // Parse host:port format
  const parts = trimmed.split(':')
  if (parts.length !== 2) {
    throw new Error(
      `Invalid TigerBeetle connection string: "${trimmed}". ` +
        'Expected format: host:port (e.g., 127.0.0.1:3000)',
    )
  }

  const host = parts[0] || '127.0.0.1'
  const port = parseInt(parts[1], 10)

  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid TigerBeetle port: "${parts[1]}". Expected a number between 1 and 65535.`,
    )
  }

  return { host, port }
}
