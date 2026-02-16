/**
 * Weaviate backup module
 * Supports snapshot-based backup using Weaviate's filesystem backup API.
 *
 * Weaviate's filesystem backup creates a directory at BACKUP_FILESYSTEM_PATH/<id>/
 * containing backup metadata and class data. We copy this entire directory
 * as the "snapshot" for backup/restore.
 */

import { mkdir, stat, cp, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import { weaviateApiRequest } from './api-client'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Create a snapshot backup using Weaviate's REST API.
 * Triggers a filesystem backup, polls for completion, then copies the
 * backup directory to the output path.
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  _options: BackupOptions,
): Promise<BackupResult> {
  const { port, name } = container

  // Ensure output parent directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // Generate a unique backup ID
  const backupId = `spindb-backup-${Date.now()}`

  // Trigger backup creation via REST API
  logDebug(
    `Creating Weaviate backup '${backupId}' via REST API on port ${port}`,
  )

  const response = await weaviateApiRequest(
    port,
    'POST',
    '/v1/backups/filesystem',
    { id: backupId },
    600000, // 10 minute timeout
  )

  if (response.status !== 200) {
    throw new Error(
      `Failed to create Weaviate backup: ${JSON.stringify(response.data)}`,
    )
  }

  logDebug(`Weaviate backup initiated: ${backupId}`)

  // Poll for backup completion
  const maxWait = 300000 // 5 minutes
  const startTime = Date.now()

  while (Date.now() - startTime < maxWait) {
    const statusResponse = await weaviateApiRequest(
      port,
      'GET',
      `/v1/backups/filesystem/${backupId}`,
    )

    if (statusResponse.status === 200) {
      const statusData = statusResponse.data as {
        status?: string
        path?: string
      }

      if (statusData.status === 'SUCCESS') {
        logDebug(`Weaviate backup completed: ${backupId}`)
        break
      }

      if (statusData.status === 'FAILED') {
        throw new Error(`Weaviate backup failed: ${JSON.stringify(statusData)}`)
      }

      logDebug(`Backup status: ${statusData.status}, waiting...`)
    }

    await new Promise((r) => setTimeout(r, 1000))
  }

  // Weaviate stores backup at BACKUP_FILESYSTEM_PATH/<backupId>/
  // BACKUP_FILESYSTEM_PATH is set to <dataDir>/backups in start()
  const dataDir = paths.getContainerDataPath(name, { engine: 'weaviate' })
  const backupDir = join(dataDir, 'backups', backupId)

  if (!existsSync(backupDir)) {
    throw new Error(
      `Weaviate backup directory not found at ${backupDir} after completion`,
    )
  }

  // Copy entire backup directory to output path
  await cp(backupDir, outputPath, { recursive: true })

  // Get total size of backup directory
  const files = await readdir(backupDir, { recursive: true })
  let totalSize = 0
  for (const file of files) {
    try {
      const filePath = join(backupDir, String(file))
      const stats = await stat(filePath)
      if (stats.isFile()) {
        totalSize += stats.size
      }
    } catch {
      // Skip inaccessible files
    }
  }

  return {
    path: outputPath,
    format: 'snapshot',
    size: totalSize,
  }
}

/**
 * Create a backup for cloning purposes
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createBackup(container, outputPath, { database: 'default' })
}
