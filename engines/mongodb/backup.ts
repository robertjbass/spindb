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
import {
  getDefaultUsername,
  loadCredentials,
} from '../../core/credential-manager'
import { getMongodumpPath, MONGODUMP_NOT_FOUND_ERROR } from './cli-utils'
import {
  buildMongoUri,
  resolveMongoAuthSources,
  isMongoAuthError,
} from '../mongo-uri'
import {
  Engine,
  type ContainerConfig,
  type BackupOptions,
  type BackupResult,
} from '../../types'

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

  // Determine output format (default to 'archive' as per backup-formats.ts)
  const format = options.format ?? 'archive'
  const isSingleFileArchive = format === 'archive' || format === 'archive-plain'
  const formatArgs: string[] =
    format === 'archive'
      ? // Archive format: single compressed file
        ['--archive=' + outputPath, '--gzip']
      : format === 'archive-plain'
        ? // Uncompressed single-file archive (no --gzip), for consumers whose
          // restore path does not pass --gzip (e.g. a plain `mongorestore
          // --archive`). The restore side auto-detects gzip vs plain.
          ['--archive=' + outputPath]
        : // Directory format (bson): output to directory
          ['--out', outputPath]

  // Build mongodump args for a given authSource. With saved credentials the auth
  // user may live in <database> (spindb's own createUser) OR in `admin` (an
  // external provisioner's root user, e.g. the cloud's MONGO_INITDB_ROOT) - so we
  // try the candidate authSources in order and retry on an authentication failure.
  const host = container.bindAddress ?? '127.0.0.1'
  const argsForAuthSource = (authDatabase: string | null): string[] => {
    const connection = authDatabase
      ? [
          '--uri',
          buildMongoUri(
            port,
            db,
            {
              username: savedCreds!.username,
              password: savedCreds!.password,
              authDatabase,
            },
            host,
          ),
          '--db',
          db,
        ]
      : ['--host', '127.0.0.1', '--port', String(port), '--db', db]
    return [...connection, ...formatArgs]
  }

  const authSources: (string | null)[] = savedCreds
    ? resolveMongoAuthSources({
        authSource: savedCreds.authSource,
        database: savedCreds.database,
      })
    : [null]

  const runMongodump = (args: string[]): Promise<BackupResult> => {
    logDebug(
      `Running mongodump with args: ${sanitizeMongoArgs(args).join(' ')}`,
    )

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
            if (isSingleFileArchive) {
              // Archive file (compressed or plain)
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
            format: isSingleFileArchive ? 'archive' : 'directory',
            size,
          })
        } else {
          reject(new Error(stderr || `mongodump exited with code ${code}`))
        }
      })
    })
  }

  // Try each candidate authSource, retrying ONLY on authentication failures.
  let lastError: Error | undefined
  for (let i = 0; i < authSources.length; i++) {
    try {
      return await runMongodump(argsForAuthSource(authSources[i]))
    } catch (error) {
      lastError = error as Error
      const isLastAttempt = i === authSources.length - 1
      if (!isLastAttempt && isMongoAuthError(lastError.message)) {
        logDebug(
          `mongodump auth failed against authSource=${authSources[i]}; retrying with next candidate`,
        )
        continue
      }
      throw lastError
    }
  }
  // Unreachable (the loop returns or throws); satisfies the type checker.
  throw lastError ?? new Error('mongodump failed')
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
