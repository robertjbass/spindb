/**
 * Meilisearch restore module
 * Supports snapshot-based restore using Meilisearch's snapshot files
 */

import { copyFile, open, mkdir, rm } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Detect backup format from file
 * Meilisearch uses snapshot files which are compressed archives
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file not found: ${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: 'Directory found - Meilisearch uses single snapshot files',
      restoreCommand:
        'Meilisearch requires a single .snapshot file for restore',
    }
  }

  // Check file extension for .snapshot files
  if (filePath.endsWith('.snapshot')) {
    return {
      format: 'snapshot',
      description: 'Meilisearch snapshot file',
      restoreCommand:
        'Copy to snapshots directory and restart Meilisearch (spindb restore handles this)',
    }
  }

  // Check file contents for gzip magic bytes (snapshot files are compressed)
  try {
    const buffer = Buffer.alloc(4)
    const fd = await open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 4, 0)
      // Gzip magic bytes: 1f 8b
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return {
          format: 'snapshot',
          description: 'Meilisearch snapshot file (detected by magic bytes)',
          restoreCommand:
            'Copy to snapshots directory and restart Meilisearch (spindb restore handles this)',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`Error reading backup file header: ${error}`)
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use .snapshot file for restore',
  }
}

// Restore options for Meilisearch
export type RestoreOptions = {
  containerName: string
  dataDir?: string
}

/**
 * Restore from snapshot backup
 *
 * IMPORTANT: Meilisearch should be stopped before snapshot restore.
 * The snapshot file is copied to the snapshots directory, then Meilisearch should be restarted.
 * Meilisearch can be started with --import-snapshot flag to restore from the snapshot.
 */
async function restoreSnapshotBackup(
  backupPath: string,
  containerName: string,
  dataDir?: string,
): Promise<RestoreResult> {
  const targetDir =
    dataDir ||
    paths.getContainerDataPath(containerName, { engine: 'meilisearch' })
  const snapshotsDir = join(targetDir, 'snapshots')
  const snapshotName = basename(backupPath)
  const targetPath = join(snapshotsDir, snapshotName)

  logDebug(`Restoring snapshot to: ${targetPath}`)

  // Ensure snapshots directory exists
  if (!existsSync(snapshotsDir)) {
    await mkdir(snapshotsDir, { recursive: true })
  }

  // Copy backup to snapshots directory FIRST to ensure it succeeds
  // before removing any existing data (prevents data loss if copy fails)
  await copyFile(backupPath, targetPath)

  // Remove existing indexes after successful copy for clean restore
  const indexesDir = join(targetDir, 'indexes')
  if (existsSync(indexesDir)) {
    logDebug('Removing existing indexes for clean restore')
    await rm(indexesDir, { recursive: true, force: true })
  }

  // Also remove tasks database
  const tasksDir = join(targetDir, 'tasks')
  if (existsSync(tasksDir)) {
    logDebug('Removing existing tasks for clean restore')
    await rm(tasksDir, { recursive: true, force: true })
  }

  return {
    format: 'snapshot',
    stdout:
      `Restored snapshot to ${targetPath}. Restart Meilisearch with --import-snapshot flag to load the data.\n` +
      `Or restart normally and the snapshot will be available for import.`,
    code: 0,
  }
}

/**
 * Restore from backup
 * Supports snapshot format only
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, dataDir } = options

  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  if (format.format === 'snapshot') {
    return restoreSnapshotBackup(backupPath, containerName, dataDir)
  }

  throw new Error(
    `Invalid backup format: ${format.format}. Use .snapshot file for restore.`,
  )
}

/**
 * Parse Meilisearch connection string
 * Format: http://host[:port] or https://host[:port]
 *
 * Meilisearch uses indexes instead of traditional databases
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'https'
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid Meilisearch connection string: expected a non-empty string',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `Invalid Meilisearch connection string: "${connectionString}". ` +
        `Expected format: http://host[:port]`,
      { cause: error },
    )
  }

  // Validate protocol
  let protocol: 'http' | 'https'
  if (url.protocol === 'http:') {
    protocol = 'http'
  } else if (url.protocol === 'https:') {
    protocol = 'https'
  } else {
    throw new Error(
      `Invalid Meilisearch connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "http://" or "https://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 7700

  return {
    host,
    port,
    protocol,
  }
}
