/**
 * libSQL restore module
 * Supports binary (file copy) and SQL import restore formats
 */

import { existsSync } from 'fs'
import { copyFile, readFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import {
  loadCredentials,
  getDefaultUsername,
} from '../../core/credential-manager'
import { libsqlQuery } from './api-client'
import {
  Engine,
  type BackupFormat,
  type RestoreResult,
  type LibSQLFormat,
} from '../../types'

/**
 * Detect the backup format from a file path
 */
export function detectBackupFormat(filePath: string): BackupFormat {
  if (filePath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'SQL dump',
      restoreCommand: `spindb restore <container> ${filePath}`,
    }
  }

  if (filePath.endsWith('.db')) {
    return {
      format: 'binary',
      description: 'Binary database copy',
      restoreCommand: `spindb restore <container> ${filePath}`,
    }
  }

  // Default to binary format for unknown extensions
  return {
    format: 'binary',
    description: 'Binary database copy (assumed)',
    restoreCommand: `spindb restore <container> ${filePath}`,
  }
}

/**
 * Restore a libSQL backup
 */
export async function restoreBackup(
  backupPath: string,
  options: {
    containerName: string
    dataDir: string
    port?: number
    format?: LibSQLFormat
  },
): Promise<RestoreResult> {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  const format = options.format || detectBackupFormat(backupPath).format

  if (format === 'sql') {
    return restoreSqlBackup(backupPath, options)
  }

  return restoreBinaryBackup(backupPath, options)
}

/**
 * Restore from a binary backup by copying the database file
 * Requires the server to be stopped
 */
async function restoreBinaryBackup(
  backupPath: string,
  options: { containerName: string; dataDir: string },
): Promise<RestoreResult> {
  const containerDir = paths.getContainerPath(options.containerName, {
    engine: 'libsql',
  })
  const dataDir = join(containerDir, 'data')
  const dbPath = join(dataDir, 'data.db')

  logDebug(`Restoring binary backup to ${dbPath}`)

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true })
  }

  await copyFile(backupPath, dbPath)

  return {
    format: 'binary',
    stdout: `Restored binary backup to ${dbPath}. Start the container to use it.`,
  }
}

/**
 * Restore from a SQL dump via the HTTP API
 * Requires the server to be running
 */
async function restoreSqlBackup(
  backupPath: string,
  options: { containerName: string; port?: number },
): Promise<RestoreResult> {
  const port = options.port
  if (!port) {
    throw new Error(
      'SQL restore requires a running container. Start the container first, then retry.',
    )
  }

  logDebug(`Restoring SQL backup via HTTP API on port ${port}`)

  // Load auth token if credentials are stored
  const username = getDefaultUsername(Engine.LibSQL)
  const creds = await loadCredentials(
    options.containerName,
    Engine.LibSQL,
    username,
  )
  const authToken = creds?.apiKey ?? undefined

  const content = await readFile(backupPath, 'utf-8')

  // Split into individual statements, filtering comments and empty lines
  const statements = content
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('--'))

  let executed = 0
  for (const stmt of statements) {
    // Skip transaction control statements - sqld handles transactions differently
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(stmt)) continue

    try {
      await libsqlQuery(port, `${stmt};`, { authToken })
      executed++
    } catch (error) {
      logDebug(
        `Warning: statement failed during restore: ${(error as Error).message}`,
      )
    }
  }

  return {
    format: 'sql',
    stdout: `Restored ${executed} SQL statements from backup.`,
  }
}
