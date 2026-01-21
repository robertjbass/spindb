/**
 * Qdrant restore module
 * Supports snapshot-based restore using Qdrant's snapshot files
 */

import { copyFile, open, mkdir, rm } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, dirname, basename } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Detect backup format from file
 * Qdrant uses snapshot files which are tar.gz archives
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
      description: 'Directory found - Qdrant uses single snapshot files',
      restoreCommand:
        'Qdrant requires a single .snapshot file for restore',
    }
  }

  // Check file extension for .snapshot files
  if (filePath.endsWith('.snapshot')) {
    return {
      format: 'snapshot',
      description: 'Qdrant snapshot file',
      restoreCommand:
        'Copy to snapshots directory and use Qdrant API (spindb restore handles this)',
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
          description: 'Qdrant snapshot file (detected by magic bytes)',
          restoreCommand:
            'Copy to snapshots directory and use Qdrant API (spindb restore handles this)',
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

// Restore options for Qdrant
export type RestoreOptions = {
  containerName: string
  dataDir?: string
  // Port for running Qdrant instance (required for API-based restore)
  port?: number
}

/**
 * Restore from snapshot backup
 *
 * IMPORTANT: Qdrant should be stopped before snapshot restore.
 * The snapshot file is copied to the snapshots directory, then Qdrant should be restarted.
 * On startup, Qdrant will automatically restore from the snapshot.
 */
async function restoreSnapshotBackup(
  backupPath: string,
  containerName: string,
  dataDir?: string,
): Promise<RestoreResult> {
  const targetDir =
    dataDir || paths.getContainerDataPath(containerName, { engine: 'qdrant' })
  const snapshotsDir = join(targetDir, 'snapshots')
  const snapshotName = basename(backupPath)
  const targetPath = join(snapshotsDir, snapshotName)

  logDebug(`Restoring snapshot to: ${targetPath}`)

  // Ensure snapshots directory exists
  if (!existsSync(snapshotsDir)) {
    await mkdir(snapshotsDir, { recursive: true })
  }

  // Remove existing data to allow clean restore
  const collectionsDir = join(targetDir, 'collections')
  if (existsSync(collectionsDir)) {
    logDebug('Removing existing collections for clean restore')
    await rm(collectionsDir, { recursive: true, force: true })
  }

  // Copy backup to snapshots directory
  await copyFile(backupPath, targetPath)

  return {
    format: 'snapshot',
    stdout: `Restored snapshot to ${targetPath}. Restart Qdrant to load the data.\n` +
      `Use: POST http://127.0.0.1:PORT/snapshots/recover to trigger recovery.`,
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
 * Parse Qdrant connection string
 * Format: http://host[:port] or grpc://host[:port]
 *
 * Qdrant uses collections instead of traditional databases
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'grpc'
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid Qdrant connection string: expected a non-empty string',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `Invalid Qdrant connection string: "${connectionString}". ` +
        `Expected format: http://host[:port] or grpc://host[:port]`,
      { cause: error },
    )
  }

  // Validate protocol
  let protocol: 'http' | 'grpc'
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    protocol = 'http'
  } else if (url.protocol === 'grpc:') {
    protocol = 'grpc'
  } else {
    throw new Error(
      `Invalid Qdrant connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "http://" or "grpc://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const defaultPort = protocol === 'http' ? 6333 : 6334
  const port = parseInt(url.port, 10) || defaultPort

  return {
    host,
    port,
    protocol,
  }
}
