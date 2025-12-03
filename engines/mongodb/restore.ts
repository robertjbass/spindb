/**
 * MongoDB restore functionality using mongorestore
 *
 * Supports restoring from:
 * - Archive files (.archive, .dump)
 * - Dump directories (created by mongodump --out)
 * - JSON files (individual collection exports)
 */

import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { stat, readdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { getBinaryPath } from './binary-detection'
import type { ContainerConfig, RestoreResult, BackupFormat } from '../../types'

const execAsync = promisify(exec)

/**
 * Detected backup format
 */
export type MongoDBBackupType =
  | 'archive'
  | 'directory'
  | 'json'
  | 'bson'
  | 'unknown'

/**
 * Detect the format of a backup file or directory
 */
export async function detectBackupFormat(
  backupPath: string,
): Promise<BackupFormat> {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup path does not exist: ${backupPath}`)
  }

  const stats = await stat(backupPath)

  if (stats.isDirectory()) {
    // Check if it's a mongodump directory structure
    const files = await readdir(backupPath)

    // Look for BSON files or database subdirectories
    const hasBson = files.some((f) => f.endsWith('.bson'))
    const hasMetadata = files.some((f) => f.endsWith('.metadata.json'))

    if (hasBson || hasMetadata) {
      return {
        format: 'directory',
        description: 'MongoDB dump directory (BSON)',
        restoreCommand: 'mongorestore',
      }
    }

    // Check for database subdirectories
    const hasSubdirs = await Promise.all(
      files.map(async (f) => {
        try {
          const subStats = await stat(join(backupPath, f))
          return subStats.isDirectory()
        } catch {
          return false
        }
      }),
    )

    if (hasSubdirs.some((v) => v)) {
      // Check first subdirectory for BSON files
      const firstDir = files.find(
        (f, i) =>
          hasSubdirs[i] && !f.startsWith('.') && f !== 'admin' && f !== 'local',
      )
      if (firstDir) {
        const subFiles = await readdir(join(backupPath, firstDir))
        const subHasBson = subFiles.some((f) => f.endsWith('.bson'))
        if (subHasBson) {
          return {
            format: 'directory',
            description: 'MongoDB dump directory (multiple databases)',
            restoreCommand: 'mongorestore',
          }
        }
      }
    }

    // Check for JSON files (might be a JSON export)
    const hasJson = files.some((f) => f.endsWith('.json'))
    if (hasJson) {
      return {
        format: 'json',
        description: 'JSON export directory',
        restoreCommand: 'mongoimport',
      }
    }

    return {
      format: 'unknown',
      description: 'Unknown directory format',
      restoreCommand: 'mongorestore',
    }
  }

  // It's a file
  const filename = backupPath.toLowerCase()

  if (filename.endsWith('.archive') || filename.endsWith('.dump')) {
    return {
      format: 'archive',
      description: 'MongoDB archive file',
      restoreCommand: 'mongorestore --archive',
    }
  }

  if (filename.endsWith('.json')) {
    // Try to determine if it's a valid MongoDB JSON export
    try {
      const content = await readFile(backupPath, 'utf-8')
      // Check if it's JSON array or line-delimited JSON
      if (content.trim().startsWith('[') || content.trim().startsWith('{')) {
        return {
          format: 'json',
          description: 'JSON export file',
          restoreCommand: 'mongoimport',
        }
      }
    } catch {
      // Not a readable JSON file
    }
    return {
      format: 'json',
      description: 'JSON file',
      restoreCommand: 'mongoimport',
    }
  }

  if (filename.endsWith('.bson')) {
    return {
      format: 'bson',
      description: 'BSON file',
      restoreCommand: 'mongorestore',
    }
  }

  // Try to detect by magic bytes for archive files
  try {
    const fd = await import('fs').then((fs) =>
      fs.promises.open(backupPath, 'r'),
    )
    const buffer = Buffer.alloc(4)
    await fd.read(buffer, 0, 4, 0)
    await fd.close()

    // MongoDB archives don't have specific magic bytes, but we can check for common patterns
    // Archives typically start with BSON data
    if (buffer[0] !== 0 && buffer[0] !== 0x7b && buffer[0] !== 0x5b) {
      // Not starting with { or [ (JSON), might be binary
      return {
        format: 'archive',
        description: 'MongoDB archive (detected)',
        restoreCommand: 'mongorestore --archive',
      }
    }
  } catch {
    // Magic byte detection failed
  }

  return {
    format: 'unknown',
    description: 'Unknown format - assuming archive',
    restoreCommand: 'mongorestore',
  }
}

/**
 * Restore a backup to a MongoDB container
 */
export async function restore(
  container: ContainerConfig,
  backupPath: string,
  options: {
    database?: string
    createDatabase?: boolean
    drop?: boolean
  } = {},
): Promise<RestoreResult> {
  const mongorestorePath = await getBinaryPath('mongorestore')
  if (!mongorestorePath) {
    throw new Error(
      'mongorestore not found. Install MongoDB Database Tools: brew install mongodb-database-tools',
    )
  }

  const format = await detectBackupFormat(backupPath)
  const database = options.database || container.database

  // Build connection URI
  const uri = `mongodb://127.0.0.1:${container.port}/${database}`

  // Build command arguments
  const args: string[] = ['--uri', uri]

  // Drop existing collections before restore
  if (options.drop !== false) {
    args.push('--drop')
  }

  // Handle different formats
  const stats = await stat(backupPath)
  if (stats.isFile()) {
    if (
      format.format === 'archive' ||
      backupPath.endsWith('.archive') ||
      backupPath.endsWith('.dump')
    ) {
      args.push('--archive=' + backupPath)
    } else if (format.format === 'json') {
      // For JSON files, use mongoimport instead
      return await importJsonFile(container, backupPath, {
        database,
        collection: options.database, // Use database name as collection if not specified
      })
    } else if (format.format === 'bson') {
      // For single BSON files
      args.push(backupPath)
    } else {
      // Try as archive
      args.push('--archive=' + backupPath)
    }
  } else {
    // Directory
    args.push(backupPath)
  }

  try {
    const { stdout, stderr } = await execAsync(
      `"${mongorestorePath}" ${args.join(' ')}`,
    )

    return {
      format: format.format,
      stdout,
      stderr,
      code: 0,
    }
  } catch (err) {
    const e = err as Error & { code?: number; stderr?: string; stdout?: string }
    return {
      format: format.format,
      stdout: e.stdout,
      stderr: e.stderr || e.message,
      code: e.code || 1,
    }
  }
}

/**
 * Import a JSON file using mongoimport
 */
async function importJsonFile(
  container: ContainerConfig,
  jsonPath: string,
  options: {
    database?: string
    collection?: string
  } = {},
): Promise<RestoreResult> {
  // Try to find mongoimport (part of mongodb-database-tools)
  const { stdout: whichOutput } = await execAsync('which mongoimport').catch(
    () => ({ stdout: '' }),
  )
  const mongoimportPath = whichOutput.trim()

  if (!mongoimportPath) {
    // Fall back to trying it directly
    throw new Error(
      'mongoimport not found. Install MongoDB Database Tools: brew install mongodb-database-tools',
    )
  }

  const database = options.database || container.database
  const collection =
    options.collection || jsonPath.split('/').pop()?.replace('.json', '') || 'imported'

  const uri = `mongodb://127.0.0.1:${container.port}/${database}`

  // Detect if it's a JSON array or line-delimited JSON
  const content = await readFile(jsonPath, 'utf-8')
  const isArray = content.trim().startsWith('[')

  const args: string[] = [
    '--uri',
    uri,
    '--collection',
    collection,
    '--file',
    jsonPath,
  ]

  if (isArray) {
    args.push('--jsonArray')
  }

  args.push('--drop') // Drop existing collection

  try {
    const { stdout, stderr } = await execAsync(
      `"${mongoimportPath}" ${args.join(' ')}`,
    )

    return {
      format: 'json',
      stdout,
      stderr,
      code: 0,
    }
  } catch (err) {
    const e = err as Error & { code?: number; stderr?: string; stdout?: string }
    return {
      format: 'json',
      stdout: e.stdout,
      stderr: e.stderr || e.message,
      code: e.code || 1,
    }
  }
}

/**
 * Restore with progress monitoring
 */
export async function restoreWithProgress(
  container: ContainerConfig,
  backupPath: string,
  options: {
    database?: string
    drop?: boolean
    onProgress?: (message: string) => void
  } = {},
): Promise<RestoreResult> {
  const mongorestorePath = await getBinaryPath('mongorestore')
  if (!mongorestorePath) {
    throw new Error(
      'mongorestore not found. Install MongoDB Database Tools: brew install mongodb-database-tools',
    )
  }

  const format = await detectBackupFormat(backupPath)
  const database = options.database || container.database
  const uri = `mongodb://127.0.0.1:${container.port}/${database}`

  const args: string[] = ['--uri', uri]

  if (options.drop !== false) {
    args.push('--drop')
  }

  const stats = await stat(backupPath)
  if (stats.isFile()) {
    if (
      format.format === 'archive' ||
      backupPath.endsWith('.archive') ||
      backupPath.endsWith('.dump')
    ) {
      args.push('--archive=' + backupPath)
    } else {
      args.push('--archive=' + backupPath)
    }
  } else {
    args.push(backupPath)
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(mongorestorePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
      if (options.onProgress) {
        options.onProgress(data.toString().trim())
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
      // mongorestore writes progress to stderr
      if (options.onProgress) {
        options.onProgress(data.toString().trim())
      }
    })

    proc.on('close', (code) => {
      resolve({
        format: format.format,
        stdout,
        stderr,
        code: code || 0,
      })
    })

    proc.on('error', (err) => {
      reject(new Error(`mongorestore failed: ${err.message}`))
    })
  })
}
