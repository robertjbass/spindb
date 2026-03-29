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
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { getMongodumpPath, MONGODUMP_NOT_FOUND_ERROR } from './cli-utils'
import { buildMongoUri } from '../mongo-uri'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

function redactMongoUri(uri: string): string {
  try {
    const url = new URL(uri)
    if (!url.username && !url.password) {
      return uri
    }
    return `${url.protocol}//<redacted>@${url.host}${url.pathname}${url.search}`
  } catch {
    return 'mongodb://<redacted>'
  }
}

function sanitizeMongoArgs(args: string[]): string[] {
  const sanitized = [...args]
  const uriIndex = sanitized.indexOf('--uri')
  if (uriIndex >= 0 && uriIndex + 1 < sanitized.length) {
    sanitized[uriIndex + 1] = redactMongoUri(sanitized[uriIndex + 1])
  }
  return sanitized
}

async function getDirectorySize(dirPath: string): Promise<number> {
  const { readdir } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  let total = 0

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += await getDirectorySize(entryPath)
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size
    }
  }

  return total
}

/**
 * Create a backup of a MongoDB database using mongodump
 *
 * Supports two formats:
 * - 'bson': Directory dump with BSON files per collection
 * - 'archive' (default): Single compressed archive file
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { name, port, database, version } = container
  const db = options.database || database

  const mongodump = await getMongodumpPath(version)
  if (!mongodump) {
    throw new Error(MONGODUMP_NOT_FOUND_ERROR)
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  const savedCreds = await loadCredentials(
    name,
    Engine.MongoDB,
    getDefaultUsername(Engine.MongoDB),
  )

  const args: string[] = savedCreds
    ? [
        '--uri',
        buildMongoUri(port, db, {
          username: savedCreds.username,
          password: savedCreds.password,
          authDatabase: savedCreds.database || 'admin',
        }, container.bindAddress ?? '127.0.0.1'),
        '--db',
        db,
      ]
    : [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--db',
        db,
      ]

  // Determine output format (default to 'archive' as per backup-formats.ts)
  const format = options.format ?? 'archive'
  if (format === 'archive') {
    // Archive format: single compressed file
    args.push('--archive=' + outputPath, '--gzip')
  } else {
    // Directory format (bson): output to directory
    args.push('--out', outputPath)
  }

  logDebug(`Running mongodump with args: ${sanitizeMongoArgs(args).join(' ')}`)

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
          if (options.format === 'archive') {
            // Archive file
            const stats = await stat(outputPath)
            size = stats.size
          } else {
            // Directory - sum up all dumped files
            const dbDir = join(outputPath, db)
            if (existsSync(dbDir)) {
              size = await getDirectorySize(dbDir)
            }
          }
        } catch {
          // Size calculation failed, use 0
        }

        resolve({
          path: outputPath,
          format: options.format === 'archive' ? 'archive' : 'directory',
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
    format: 'archive',
  })
}
