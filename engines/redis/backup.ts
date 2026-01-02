/**
 * Redis backup module
 * Uses BGSAVE to create RDB snapshots
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { copyFile, stat, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { getRedisCliPath } from './binary-detection'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

const execAsync = promisify(exec)

/**
 * Build a redis-cli command
 */
function buildRedisCliCommand(
  redisCli: string,
  port: number,
  command: string,
): string {
  return `"${redisCli}" -h 127.0.0.1 -p ${port} ${command}`
}

/**
 * Create a backup using BGSAVE
 *
 * Redis backups are RDB files (binary snapshots).
 * The backup process:
 * 1. Trigger BGSAVE command
 * 2. Poll LASTSAVE until timestamp changes (backup complete)
 * 3. Copy dump.rdb to output path
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  _options: BackupOptions,
): Promise<BackupResult> {
  const { port, name } = container

  const redisCli = await getRedisCliPath()
  if (!redisCli) {
    throw new Error(
      'redis-cli not found. Install Redis:\n' +
        '  macOS: brew install redis\n' +
        '  Ubuntu: sudo apt install redis-tools\n',
    )
  }

  // Trigger background save
  const bgsaveCmd = buildRedisCliCommand(redisCli, port, 'BGSAVE')
  const { stdout: bgsaveOutput } = await execAsync(bgsaveCmd)

  logDebug(`BGSAVE response: ${bgsaveOutput.trim()}`)

  // Wait for save to complete by checking rdb_bgsave_in_progress
  // This is more reliable than LASTSAVE timestamp which has 1-second resolution
  const startTime = Date.now()
  const timeout = 60000 // 1 minute timeout

  const infoCmd = buildRedisCliCommand(
    redisCli,
    port,
    'INFO persistence',
  )

  while (Date.now() - startTime < timeout) {
    const { stdout: infoOutput } = await execAsync(infoCmd)

    // Check if BGSAVE is still in progress
    const inProgress = infoOutput.includes('rdb_bgsave_in_progress:1')
    if (!inProgress) {
      // Also check for errors
      const statusMatch = infoOutput.match(/rdb_last_bgsave_status:(\w+)/)
      const status = statusMatch?.[1]
      if (status === 'err') {
        throw new Error('BGSAVE failed. Check Redis logs for details.')
      }
      logDebug('BGSAVE completed successfully')
      break
    }

    await new Promise((r) => setTimeout(r, 100))
  }

  if (Date.now() - startTime >= timeout) {
    throw new Error('BGSAVE timed out after 60 seconds')
  }

  // Get the RDB file path from Redis data directory
  const dataDir = paths.getContainerDataPath(name, { engine: 'redis' })
  const rdbPath = join(dataDir, 'dump.rdb')

  if (!existsSync(rdbPath)) {
    throw new Error(
      `RDB file not found at ${rdbPath} after BGSAVE. Check Redis configuration.`,
    )
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // Copy RDB file to output path
  await copyFile(rdbPath, outputPath)

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'rdb',
    size: stats.size,
  }
}

/**
 * Create a backup for cloning purposes
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createBackup(container, outputPath, {
    database: container.database,
    format: 'dump', // RDB is the only format for Redis
  })
}
