/**
 * SurrealDB backup module
 * Supports SurrealQL-based backups using surreal export
 *
 * SurrealDB backup formats:
 * - SurrealQL: Schema + data as SurrealQL statements (portable, human-readable)
 */

import { spawn } from 'child_process'
import { stat, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { requireSurrealPath } from './cli-utils'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Create a SurrealQL backup using surreal export
 */
async function createSurqlBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const { port, version } = container
  // SurrealDB uses namespace/database hierarchy - use container name as namespace
  const namespace = container.name.replace(/-/g, '_')

  const surrealPath = await requireSurrealPath(version)

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  return new Promise<BackupResult>((resolve, reject) => {
    // surreal export command
    const args = [
      'export',
      '--endpoint', `http://127.0.0.1:${port}`,
      '--user', 'root',
      '--pass', 'root',
      '--ns', namespace,
      '--db', database,
      outputPath,
    ]

    logDebug(`Running: surreal ${args.join(' ')}`)

    const proc = spawn(surrealPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let _stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      _stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', async (code) => {
      if (code === 0) {
        try {
          const stats = await stat(outputPath)
          resolve({
            path: outputPath,
            format: 'surql',
            size: stats.size,
          })
        } catch (error) {
          reject(new Error(`Backup file not created: ${error}`))
        }
      } else if (code === null) {
        reject(
          new Error(
            `surreal export was terminated by signal${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      } else {
        reject(
          new Error(
            `surreal export exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })
  })
}

/**
 * Create a backup
 *
 * @param container - Container configuration
 * @param outputPath - Path to write backup file
 * @param options - Backup options
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const database = options.database || container.database || 'default'

  return createSurqlBackup(container, outputPath, database)
}

/**
 * Create a backup for cloning purposes
 * Uses SurrealQL format for reliability
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createSurqlBackup(container, outputPath, container.database || 'default')
}
