/**
 * Qdrant backup module
 * Supports snapshot-based backup using Qdrant's REST API
 */

import { mkdir, stat, copyFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Make an HTTP request to Qdrant REST API
 */
async function qdrantApiRequest(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  const response = await fetch(url, options)
  const data = await response.json()

  return { status: response.status, data }
}

/**
 * Create a snapshot backup using Qdrant's REST API
 * This creates a full snapshot of the entire Qdrant instance
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
  logDebug(`Creating Qdrant snapshot via REST API on port ${port}`)

  const response = await qdrantApiRequest(port, 'POST', '/snapshots')

  if (response.status !== 200) {
    throw new Error(
      `Failed to create Qdrant snapshot: ${JSON.stringify(response.data)}`,
    )
  }

  const snapshotData = response.data as { result?: { name?: string } }
  const snapshotName = snapshotData?.result?.name

  if (!snapshotName) {
    throw new Error(
      `Qdrant snapshot creation failed: no snapshot name returned`,
    )
  }

  logDebug(`Qdrant snapshot created: ${snapshotName}`)

  // The snapshot is stored in the data directory's snapshots folder
  const dataDir = paths.getContainerDataPath(name, { engine: 'qdrant' })
  const snapshotsDir = join(dataDir, 'snapshots')
  const snapshotPath = join(snapshotsDir, snapshotName)

  // Wait for the snapshot file to be ready
  const maxWait = 60000 // 60 seconds
  const startTime = Date.now()

  while (Date.now() - startTime < maxWait) {
    if (existsSync(snapshotPath)) {
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!existsSync(snapshotPath)) {
    throw new Error(
      `Qdrant snapshot file not found at ${snapshotPath} after timeout`,
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
  const dataDir = paths.getContainerDataPath(name, { engine: 'qdrant' })
  const snapshotsDir = join(dataDir, 'snapshots')

  if (!existsSync(snapshotsDir)) {
    return []
  }

  const files = await readdir(snapshotsDir)
  const snapshots: Array<{ name: string; createdAt: string; size: number }> = []

  for (const file of files) {
    if (file.endsWith('.snapshot')) {
      const filePath = join(snapshotsDir, file)
      const stats = await stat(filePath)
      snapshots.push({
        name: file,
        createdAt: stats.mtime.toISOString(),
        size: stats.size,
      })
    }
  }

  return snapshots
}
