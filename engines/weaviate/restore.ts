/**
 * Weaviate restore module
 * Supports snapshot-based restore using Weaviate's filesystem backup API.
 *
 * Restore flow:
 * 1. Copy backup directory into target container's BACKUP_FILESYSTEM_PATH/<id>/
 * 2. Start Weaviate (handled by caller)
 * 3. Trigger restore via POST /v1/backups/filesystem/<id>/restore
 */

import { cp, open, mkdir, readFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Detect backup format from file or directory.
 * Weaviate backups are directories containing backup metadata and class data.
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file not found: ${filePath}`)
  }

  const stats = statSync(filePath)

  // Weaviate filesystem backups are directories
  if (stats.isDirectory()) {
    // Check if it contains a backup_config.json (Weaviate backup marker)
    const configPath = join(filePath, 'backup_config.json')
    if (existsSync(configPath)) {
      return {
        format: 'snapshot',
        description: 'Weaviate filesystem backup directory',
        restoreCommand:
          'Copy to backups directory and use Weaviate restore API (spindb restore handles this)',
      }
    }

    return {
      format: 'snapshot',
      description: 'Weaviate backup directory',
      restoreCommand:
        'Copy to backups directory and use Weaviate restore API (spindb restore handles this)',
    }
  }

  // Check file extension for .snapshot files
  if (filePath.endsWith('.snapshot')) {
    return {
      format: 'snapshot',
      description: 'Weaviate snapshot file',
      restoreCommand:
        'Copy to backups directory and use Weaviate API (spindb restore handles this)',
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
          description: 'Weaviate snapshot file (detected by magic bytes)',
          restoreCommand:
            'Copy to backups directory and use Weaviate API (spindb restore handles this)',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`Error reading backup file header: ${error}`)
  }

  // Check for JSON backup metadata
  if (filePath.endsWith('.json')) {
    return {
      format: 'snapshot',
      description: 'Weaviate backup metadata file',
      restoreCommand: 'Use Weaviate restore API (spindb restore handles this)',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use a Weaviate backup directory for restore',
  }
}

// Restore options for Weaviate
export type RestoreOptions = {
  containerName: string
  dataDir?: string
}

/**
 * Restore from snapshot backup.
 *
 * Copies the backup directory into the target container's backups path.
 * The caller must then start Weaviate and trigger the restore via API.
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, dataDir } = options

  if (!existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`)
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  if (format.format !== 'snapshot') {
    throw new Error(
      `Invalid backup format: ${format.format}. Use a Weaviate backup directory for restore.`,
    )
  }

  const targetDir =
    dataDir || paths.getContainerDataPath(containerName, { engine: 'weaviate' })
  const backupsDir = join(targetDir, 'backups')

  // Read the real backup ID from backup_config.json inside the backup directory.
  // Weaviate validates that the directory name matches the internal backup ID.
  let backupId = basename(backupPath)
  const stats = statSync(backupPath)
  if (stats.isDirectory()) {
    const configPath = join(backupPath, 'backup_config.json')
    if (existsSync(configPath)) {
      try {
        const configData = JSON.parse(await readFile(configPath, 'utf-8')) as {
          id?: string
        }
        if (configData.id) {
          backupId = configData.id
          logDebug(`Read backup ID from config: ${backupId}`)
        }
      } catch (error) {
        logDebug(`Failed to read backup_config.json: ${error}`)
      }
    }
  }

  const targetPath = join(backupsDir, backupId)

  logDebug(`Restoring backup to: ${targetPath}`)

  // Ensure backups directory exists
  if (!existsSync(backupsDir)) {
    await mkdir(backupsDir, { recursive: true })
  }

  if (stats.isDirectory()) {
    // Copy entire backup directory
    await cp(backupPath, targetPath, { recursive: true })
  } else {
    // Single file - create directory and copy file into it
    if (!existsSync(targetPath)) {
      await mkdir(targetPath, { recursive: true })
    }
    const { copyFile } = await import('fs/promises')
    await copyFile(backupPath, join(targetPath, basename(backupPath)))
  }

  return {
    format: 'snapshot',
    stdout:
      `Restored backup to ${targetPath}.\n` +
      `After starting Weaviate, restore via: POST /v1/backups/filesystem/${backupId}/restore`,
    code: 0,
  }
}

/**
 * Parse Weaviate connection string
 * Format: http://host[:port], https://host[:port]
 *
 * Weaviate uses classes/collections instead of traditional databases
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  protocol: 'http' | 'https'
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid Weaviate connection string: expected a non-empty string',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `Invalid Weaviate connection string: "${connectionString}". ` +
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
      `Invalid Weaviate connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "http://" or "https://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 8080

  return {
    host,
    port,
    protocol,
  }
}
