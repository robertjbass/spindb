/**
 * Redis restore module
 * Restores from RDB backup files
 */

import { copyFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Detect backup format from file
 * Redis backups are RDB files (binary format starting with "REDIS")
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
      description: 'Directory found - Redis uses single RDB file backups',
      restoreCommand: 'Redis requires a single dump.rdb file for restore',
    }
  }

  // Check file contents for RDB format
  try {
    const buffer = Buffer.alloc(5)
    const fd = await import('fs').then((fs) => fs.promises.open(filePath, 'r'))
    try {
      await fd.read(buffer, 0, 5, 0)
      const header = buffer.toString('ascii')

      if (header === 'REDIS') {
        return {
          format: 'rdb',
          description: 'Redis RDB snapshot',
          restoreCommand:
            'Copy to data directory and restart Redis (spindb restore handles this)',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`Error reading backup file header: ${error}`)
  }

  // Check file extension as fallback
  if (filePath.endsWith('.rdb')) {
    return {
      format: 'rdb',
      description: 'Redis RDB snapshot (detected by extension)',
      restoreCommand:
        'Copy to data directory and restart Redis (spindb restore handles this)',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Manual restore required - copy dump.rdb to data directory',
  }
}

/**
 * Restore options for Redis
 */
export type RestoreOptions = {
  containerName: string
  dataDir?: string
}

/**
 * Restore from RDB backup
 *
 * IMPORTANT: Redis must be stopped before restore.
 * The RDB file is copied to the data directory, then Redis should be restarted.
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

  if (format.format !== 'rdb') {
    throw new Error(
      `Invalid backup format: ${format.format}. Redis requires RDB format backups.`,
    )
  }

  const targetDir =
    dataDir || paths.getContainerDataPath(containerName, { engine: 'redis' })
  const targetPath = join(targetDir, 'dump.rdb')

  logDebug(`Restoring RDB to: ${targetPath}`)

  // Copy backup to data directory
  await copyFile(backupPath, targetPath)

  return {
    format: 'rdb',
    stdout: `Restored RDB to ${targetPath}. Restart Redis to load the data.`,
    code: 0,
  }
}

/**
 * Parse Redis connection string
 * Format: redis://[user:password@]host[:port][/database]
 *
 * Redis databases are numbered 0-15 (default is 0)
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid Redis connection string: expected a non-empty string',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    // Mask credentials in error message if present
    const sanitized = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//***:***@',
    )
    throw new Error(
      `Invalid Redis connection string: "${sanitized}". ` +
        `Expected format: redis://[password@]host[:port][/database]`,
      { cause: error },
    )
  }

  // Validate protocol
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(
      `Invalid Redis connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "redis://" or "rediss://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 6379

  // Database is in pathname (e.g., /0, /1, etc.)
  const dbStr = url.pathname.replace(/^\//, '') || '0'
  const dbNum = parseInt(dbStr, 10)

  // Validate database number (0-15)
  if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
    throw new Error(
      `Invalid Redis database number: ${dbStr}. Must be 0-15.`,
    )
  }

  // Redis uses password only (no username), but URL might have username field
  const password = url.password || url.username || undefined

  return {
    host,
    port,
    database: String(dbNum),
    password,
  }
}
