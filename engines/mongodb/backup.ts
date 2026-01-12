/**
 * MongoDB backup module
 * Wraps mongodump for creating database backups
 */

import { spawn, type SpawnOptions } from 'child_process'
import { stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { mkdir } from 'fs/promises'
import { logDebug } from '../../core/error-handler'
import { getMongodumpPath, MONGODUMP_NOT_FOUND_ERROR } from './cli-utils'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Create a backup of a MongoDB database using mongodump
 *
 * Supports two formats:
 * - 'sql' (plain): Directory dump with BSON files
 * - 'dump' (archive): Single compressed archive file
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port, database } = container
  const db = options.database || database

  const mongodump = await getMongodumpPath()
  if (!mongodump) {
    throw new Error(MONGODUMP_NOT_FOUND_ERROR)
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  const args: string[] = [
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--db',
    db,
  ]

  // Determine output format
  if (options.format === 'dump') {
    // Archive format: single compressed file
    args.push('--archive=' + outputPath, '--gzip')
  } else {
    // Directory format: output to directory
    args.push('--out', outputPath)
  }

  logDebug(`Running mongodump with args: ${args.join(' ')}`)

  // Note: Don't use shell mode - spawn handles paths with spaces correctly
  // when shell: false (the default). Shell mode breaks paths like "C:\Program Files\..."
  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(mongodump, args, spawnOptions)

    let stderr = ''

    proc.stdout?.on('data', () => {
      // mongodump outputs progress to stderr, stdout is typically empty
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', async (code) => {
      if (code === 0) {
        // Get backup size
        let size = 0
        try {
          if (options.format === 'dump') {
            // Archive file
            const stats = await stat(outputPath)
            size = stats.size
          } else {
            // Directory - sum up all files (simplified)
            const dbDir = join(outputPath, db)
            if (existsSync(dbDir)) {
              const stats = await stat(dbDir)
              size = stats.size
            }
          }
        } catch {
          // Size calculation failed, use 0
        }

        resolve({
          path: outputPath,
          format: options.format === 'dump' ? 'archive' : 'directory',
          size,
        })
      } else {
        reject(new Error(stderr || `mongodump exited with code ${code}`))
      }
    })
  })
}

/**
 * Create a backup for cloning purposes
 * Uses archive format by default for reliability
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createBackup(container, outputPath, {
    database: container.database,
    format: 'dump',
  })
}
