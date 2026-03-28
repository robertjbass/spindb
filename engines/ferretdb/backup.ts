/**
 * FerretDB backup module
 *
 * Creates backups using mongodump on the MongoDB-compatible proxy.
 * This preserves FerretDB's document model correctly and works when SCRAM auth
 * is enabled, unlike the old pg_dump-based backend backup.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { mkdir } from 'fs/promises'
import { logDebug } from '../../core/error-handler'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { buildMongoUri } from '../mongo-uri'
import { getMongodumpPath, MONGODUMP_NOT_FOUND_ERROR } from '../mongodb/cli-utils'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

/**
 * Create a backup of a FerretDB database using pg_dump
 *
 * Supports two formats:
 * - 'sql': Plain SQL text format
 * - 'custom' (default): PostgreSQL custom format (.dump)
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { name, port, version } = container
  const database = options.database || container.database || 'test'
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
    Engine.FerretDB,
    getDefaultUsername(Engine.FerretDB),
  )

  const args: string[] = savedCreds
    ? [
        '--uri',
        buildMongoUri(port, database, {
          username: savedCreds.username,
          password: savedCreds.password,
          authDatabase: savedCreds.database || 'admin',
        }),
        '--db',
        database,
      ]
    : [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--db',
        database,
      ]

  // FerretDB now uses Mongo-compatible backup formats under the hood:
  // - archive: single compressed file
  // - bson: directory dump
  const format = options.format ?? 'archive'
  if (format === 'archive') {
    args.push('--archive=' + outputPath, '--gzip')
  } else {
    args.push('--out', outputPath)
  }

  logDebug(`Running mongodump with args: ${args.join(' ')}`)

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(mongodump, args, spawnOptions)

    let stderr = ''
    let finished = false

    proc.stdout?.on('data', () => {
      // mongodump typically writes progress to stderr
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      if (finished) return
      finished = true
      reject(err)
    })

    proc.on('close', (code) => {
      if (finished) return
      finished = true

      if (code === 0) {
        // Get backup size
        stat(outputPath)
          .then((stats) => {
            resolve({
              path: outputPath,
              format,
              size: stats.size,
            })
          })
          .catch(() => {
            // Size calculation failed, use 0
            resolve({
              path: outputPath,
              format,
              size: 0,
            })
          })
      } else {
        reject(new Error(stderr || `mongodump exited with code ${code}`))
      }
    })
  })
}

/**
 * Create a backup for cloning purposes
 * Uses custom format by default for reliability and smaller size
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
