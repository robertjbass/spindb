/**
 * TypeDB backup module
 *
 * TypeDB exports databases as two files: schema (.typeql) and data (.typeql).
 * We use the console's `database export` command which creates both files.
 */

import { spawn } from 'child_process'
import { mkdir } from 'fs/promises'
import { stat } from 'fs/promises'
import { dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { requireTypeDBConsolePath, getConsoleBaseArgs } from './cli-utils'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Create a TypeQL backup using typedb console export
 *
 * TypeDB export creates two files:
 * - {name}-schema.typeql (schema definitions)
 * - {name}-data.typeql (data inserts)
 *
 * We use the provided outputPath as the schema file path and derive the data path.
 */
async function createTypeQLBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const consolePath = await requireTypeDBConsolePath(container.version)
  const { port } = container

  // Ensure output directory exists
  await mkdir(dirname(outputPath), { recursive: true })

  // Derive schema and data paths from output path
  const schemaPath = outputPath.endsWith('.typeql')
    ? outputPath.replace(/\.typeql$/, '-schema.typeql')
    : outputPath + '-schema.typeql'
  const dataPath = outputPath.endsWith('.typeql')
    ? outputPath.replace(/\.typeql$/, '-data.typeql')
    : outputPath + '-data.typeql'

  const args = [
    ...getConsoleBaseArgs(port),
    '--command',
    `database export ${database} ${schemaPath} ${dataPath}`,
  ]

  logDebug(`Running: typedb_console_bin ${args.join(' ')}`)

  return new Promise<BackupResult>((resolve, reject) => {
    const proc = spawn(consolePath, args, {
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
          // Calculate total size of both files
          let totalSize = 0
          try {
            const schemaStats = await stat(schemaPath)
            totalSize += schemaStats.size
          } catch {
            // Schema file may not exist for empty databases
          }
          try {
            const dataStats = await stat(dataPath)
            totalSize += dataStats.size
          } catch {
            // Data file may not exist for empty databases
          }

          resolve({
            path: outputPath,
            format: 'typeql',
            size: totalSize,
          })
        } catch (error) {
          reject(new Error(`Backup files not created: ${error}`))
        }
      } else if (code === null) {
        reject(
          new Error(
            `typedb console export was terminated by signal${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      } else {
        reject(
          new Error(
            `typedb console export exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
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
  const database = options.database || container.database

  return createTypeQLBackup(container, outputPath, database)
}

/**
 * Create a backup for cloning purposes
 * Uses TypeQL format for reliability
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createTypeQLBackup(container, outputPath, container.database)
}
