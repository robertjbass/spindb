/**
 * MongoDB backup functionality using mongodump
 *
 * MongoDB backups use BSON format (binary JSON) stored in directories.
 * We also support archive format (.archive) for single-file backups.
 */

import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { mkdir, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { getBinaryPath } from './binary-detection'
import type { ContainerConfig, BackupResult, DumpResult } from '../../types'

const execAsync = promisify(exec)

/**
 * MongoDB backup format types
 */
export type MongoDBBackupFormat = 'archive' | 'directory'

/**
 * Create a backup of a MongoDB database
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: {
    database?: string
    format?: MongoDBBackupFormat
  } = {},
): Promise<BackupResult> {
  const mongodumpPath = await getBinaryPath('mongodump')
  if (!mongodumpPath) {
    throw new Error(
      'mongodump not found. Install MongoDB Database Tools: brew install mongodb-database-tools',
    )
  }

  const format = options.format || 'archive'
  const database = options.database || container.database

  // Build connection URI
  const uri = `mongodb://127.0.0.1:${container.port}/${database}`

  // Build command arguments
  const args: string[] = ['--uri', uri]

  let actualOutputPath = outputPath

  if (format === 'archive') {
    // Single-file archive format
    if (!outputPath.endsWith('.archive') && !outputPath.endsWith('.dump')) {
      actualOutputPath = `${outputPath}.archive`
    }
    args.push('--archive=' + actualOutputPath)
  } else {
    // Directory format (default mongodump behavior)
    args.push('--out', actualOutputPath)
  }

  // Ensure output directory exists
  const outputDir =
    format === 'archive' ? dirname(actualOutputPath) : actualOutputPath
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  // Execute mongodump
  try {
    const { stderr } = await execAsync(`"${mongodumpPath}" ${args.join(' ')}`)

    // Get file/directory size
    let size = 0
    try {
      const stats = await stat(actualOutputPath)
      size = stats.size
    } catch {
      // Size detection failed, continue
    }

    return {
      path: actualOutputPath,
      format: format === 'archive' ? 'MongoDB Archive' : 'MongoDB Dump Directory',
      size,
    }
  } catch (err) {
    const e = err as Error & { stderr?: string }
    throw new Error(`mongodump failed: ${e.stderr || e.message}`)
  }
}

/**
 * Create a dump from a remote MongoDB connection string
 */
export async function dumpFromConnectionString(
  connectionString: string,
  outputPath: string,
  options: {
    database?: string
    format?: MongoDBBackupFormat
  } = {},
): Promise<DumpResult> {
  const mongodumpPath = await getBinaryPath('mongodump')
  if (!mongodumpPath) {
    throw new Error(
      'mongodump not found. Install MongoDB Database Tools: brew install mongodb-database-tools',
    )
  }

  const format = options.format || 'archive'

  // Parse database from connection string if not provided
  let database = options.database
  if (!database) {
    // MongoDB connection string format: mongodb://host:port/database
    const match = connectionString.match(/mongodb:\/\/[^/]+\/([^?]+)/)
    if (match) {
      database = match[1]
    }
  }

  // Build command arguments
  const args: string[] = ['--uri', `"${connectionString}"`]

  let actualOutputPath = outputPath

  if (format === 'archive') {
    if (!outputPath.endsWith('.archive') && !outputPath.endsWith('.dump')) {
      actualOutputPath = `${outputPath}.archive`
    }
    args.push('--archive=' + actualOutputPath)
  } else {
    args.push('--out', actualOutputPath)
  }

  // Ensure output directory exists
  const outputDir =
    format === 'archive' ? dirname(actualOutputPath) : actualOutputPath
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  try {
    const { stdout, stderr } = await execAsync(
      `"${mongodumpPath}" ${args.join(' ')}`,
    )

    return {
      filePath: actualOutputPath,
      stdout,
      stderr,
      code: 0,
    }
  } catch (err) {
    const e = err as Error & { code?: number; stderr?: string; stdout?: string }
    return {
      filePath: actualOutputPath,
      stdout: e.stdout,
      stderr: e.stderr || e.message,
      code: e.code || 1,
    }
  }
}

/**
 * Stream backup output for progress monitoring
 */
export async function createBackupWithProgress(
  container: ContainerConfig,
  outputPath: string,
  options: {
    database?: string
    format?: MongoDBBackupFormat
    onProgress?: (message: string) => void
  } = {},
): Promise<BackupResult> {
  const mongodumpPath = await getBinaryPath('mongodump')
  if (!mongodumpPath) {
    throw new Error(
      'mongodump not found. Install MongoDB Database Tools: brew install mongodb-database-tools',
    )
  }

  const format = options.format || 'archive'
  const database = options.database || container.database

  const uri = `mongodb://127.0.0.1:${container.port}/${database}`

  const args: string[] = ['--uri', uri]

  let actualOutputPath = outputPath

  if (format === 'archive') {
    if (!outputPath.endsWith('.archive') && !outputPath.endsWith('.dump')) {
      actualOutputPath = `${outputPath}.archive`
    }
    args.push('--archive=' + actualOutputPath)
  } else {
    args.push('--out', actualOutputPath)
  }

  // Ensure output directory exists
  const outputDir =
    format === 'archive' ? dirname(actualOutputPath) : actualOutputPath
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(mongodumpPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      const message = data.toString()
      if (options.onProgress) {
        options.onProgress(message.trim())
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
      const message = data.toString()
      // mongodump writes progress to stderr
      if (options.onProgress) {
        options.onProgress(message.trim())
      }
    })

    proc.on('close', async (code) => {
      if (code === 0) {
        let size = 0
        try {
          const stats = await stat(actualOutputPath)
          size = stats.size
        } catch {
          // Size detection failed
        }

        resolve({
          path: actualOutputPath,
          format:
            format === 'archive' ? 'MongoDB Archive' : 'MongoDB Dump Directory',
          size,
        })
      } else {
        reject(new Error(`mongodump failed with code ${code}: ${stderr}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`mongodump failed: ${err.message}`))
    })
  })
}

/**
 * Get the size of a backup directory
 */
export async function getBackupSize(backupPath: string): Promise<number> {
  try {
    const stats = await stat(backupPath)

    if (stats.isDirectory()) {
      // For directories, we need to calculate total size
      const { stdout } = await execAsync(`du -sb "${backupPath}"`)
      const match = stdout.match(/^(\d+)/)
      if (match) {
        return parseInt(match[1], 10)
      }
    }

    return stats.size
  } catch {
    return 0
  }
}

/**
 * Remove a backup
 */
export async function removeBackup(backupPath: string): Promise<void> {
  await rm(backupPath, { recursive: true, force: true })
}
