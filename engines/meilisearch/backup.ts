/**
 * Meilisearch backup module
 * Supports snapshot-based backup using Meilisearch's REST API
 */

import { mkdir, stat, copyFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import { meilisearchApiRequest } from './api-client'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

// Backup operations may take longer than the default timeout
const BACKUP_TIMEOUT_MS = 600000 // 10 minutes

/**
 * Create a snapshot backup using Meilisearch's REST API
 * This creates a full snapshot of the entire Meilisearch instance
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  _options: BackupOptions,
): Promise<BackupResult> {
  const { port, name } = container

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // Trigger snapshot creation via REST API
  logDebug(`Creating Meilisearch snapshot via REST API on port ${port}`)

  const response = await meilisearchApiRequest(
    port,
    'POST',
    '/snapshots',
    undefined,
    BACKUP_TIMEOUT_MS,
  )

  // Meilisearch returns 202 Accepted for snapshot creation
  if (response.status !== 202 && response.status !== 200) {
    throw new Error(
      `Failed to create Meilisearch snapshot: ${JSON.stringify(response.data)}`,
    )
  }

  // Meilisearch creates snapshots asynchronously and returns a task
  // We need to wait for the task to complete
  const taskData = response.data as { taskUid?: number }
  const taskUid = taskData?.taskUid

  if (taskUid !== undefined) {
    logDebug(`Meilisearch snapshot task created: ${taskUid}`)
    // Wait for task to complete
    await waitForTask(port, taskUid, BACKUP_TIMEOUT_MS)
  }

  // The snapshot is stored in the snapshots folder (sibling of data, not inside it)
  // IMPORTANT: Meilisearch fails if --snapshot-dir is inside --db-path
  const containerDir = paths.getContainerPath(name, { engine: 'meilisearch' })
  const snapshotsDir = join(containerDir, 'snapshots')

  // Wait for the snapshot file to appear
  const maxWait = 60000 // 60 seconds
  const startTime = Date.now()
  let snapshotPath: string | null = null

  while (Date.now() - startTime < maxWait) {
    if (existsSync(snapshotsDir)) {
      const files = await readdir(snapshotsDir)
      const snapshotFiles = files.filter((f) => f.endsWith('.snapshot'))
      if (snapshotFiles.length > 0) {
        // Get the most recent snapshot
        snapshotFiles.sort().reverse()
        snapshotPath = join(snapshotsDir, snapshotFiles[0])
        break
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!snapshotPath || !existsSync(snapshotPath)) {
    throw new Error(
      `Meilisearch snapshot file not found in ${snapshotsDir} after timeout`,
    )
  }

  // Wait for file to be fully written (size stabilizes)
  let lastSize = -1
  let stabilized = false
  const writeWaitStart = Date.now()
  while (Date.now() - writeWaitStart < 30000) {
    const currentStats = await stat(snapshotPath)
    if (currentStats.size > 0 && currentStats.size === lastSize) {
      stabilized = true
      break
    }
    lastSize = currentStats.size
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!stabilized) {
    throw new Error(
      `Meilisearch snapshot did not stabilize within 30 seconds. ` +
        `File may still be writing: ${snapshotPath}`,
    )
  }

  // Copy snapshot to output path
  await copyFile(snapshotPath, outputPath)

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'snapshot',
    size: stats.size,
  }
}

/**
 * Wait for a Meilisearch task to complete
 */
async function waitForTask(
  port: number,
  taskUid: number,
  timeoutMs: number,
): Promise<void> {
  const startTime = Date.now()
  const checkInterval = 500

  while (Date.now() - startTime < timeoutMs) {
    const response = await meilisearchApiRequest(
      port,
      'GET',
      `/tasks/${taskUid}`,
    )

    if (response.status === 200) {
      const task = response.data as { status?: string }
      if (task.status === 'succeeded') {
        logDebug(`Meilisearch task ${taskUid} succeeded`)
        return
      }
      if (task.status === 'failed') {
        throw new Error(`Meilisearch task ${taskUid} failed: ${JSON.stringify(task)}`)
      }
    }

    await new Promise((r) => setTimeout(r, checkInterval))
  }

  throw new Error(`Meilisearch task ${taskUid} did not complete within timeout`)
}

/**
 * Create a backup for cloning purposes
 * Uses snapshot format for reliable data transfer
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createBackup(container, outputPath, { database: 'default' })
}

/**
 * List available snapshots for a container
 */
export async function listSnapshots(container: ContainerConfig): Promise<
  Array<{
    name: string
    createdAt: string
    size: number
  }>
> {
  const { name } = container
  // Snapshots directory is sibling of data, not inside it
  const containerDir = paths.getContainerPath(name, { engine: 'meilisearch' })
  const snapshotsDir = join(containerDir, 'snapshots')

  if (!existsSync(snapshotsDir)) {
    return []
  }

  const files = await readdir(snapshotsDir)
  const snapshotFiles = files.filter((file) => file.endsWith('.snapshot'))

  // Stat all snapshot files in parallel for better performance
  // Filter out any files that fail to stat (e.g., deleted during iteration)
  const statsResults = await Promise.all(
    snapshotFiles.map(async (file) => {
      const filePath = join(snapshotsDir, file)
      try {
        const stats = await stat(filePath)
        return {
          name: file,
          createdAt: stats.mtime.toISOString(),
          size: stats.size,
        }
      } catch {
        // File may have been deleted between readdir and stat
        return null
      }
    }),
  )

  return statsResults.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  )
}
