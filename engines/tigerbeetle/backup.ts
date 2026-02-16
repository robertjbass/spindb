/**
 * TigerBeetle backup module
 * Supports stop-and-copy backup of the single data file.
 *
 * TigerBeetle stores all data in a single file (e.g., 0_0.tigerbeetle).
 * Backup requires the server to be stopped first since the data file
 * is exclusively locked by the running process.
 */

import { copyFile, mkdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { logDebug } from '../../core/error-handler'
import type { BackupOptions, BackupResult } from '../../types'

/**
 * Create a backup by copying the TigerBeetle data file.
 * The server MUST be stopped before calling this function.
 */
export async function createBackup(
  dataDir: string,
  outputPath: string,
  _options: BackupOptions,
): Promise<BackupResult> {
  const dataFile = join(dataDir, '0_0.tigerbeetle')

  if (!existsSync(dataFile)) {
    throw new Error(
      `TigerBeetle data file not found at ${dataFile}. Has the database been initialized?`,
    )
  }

  // Ensure output parent directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  logDebug(`Copying TigerBeetle data file to ${outputPath}`)
  await copyFile(dataFile, outputPath)

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'binary',
    size: stats.size,
  }
}
