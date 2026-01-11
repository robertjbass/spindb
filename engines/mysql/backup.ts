/**
 * MySQL Backup
 *
 * Creates database backups in SQL or compressed (.dump = gzipped SQL) format using mysqldump.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { createWriteStream } from 'fs'
import { stat } from 'fs/promises'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
import { configManager } from '../../core/config-manager'
import { getWindowsSpawnOptions, isWindows } from '../../core/platform-service'
import { getEngineDefaults } from '../../config/defaults'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

const engineDef = getEngineDefaults('mysql')

// Get the mysqldump path from config
async function getMysqldumpPath(): Promise<string> {
  const configPath = await configManager.getBinaryPath('mysqldump')
  if (configPath) return configPath

  throw new Error(
    'mysqldump not found. Ensure MySQL binaries are downloaded:\n' +
      '  spindb engines download mysql',
  )
}

/**
 * Create a backup of a MySQL database
 *
 * CLI equivalent:
 * - SQL format: mysqldump -h 127.0.0.1 -P {port} -u root --result-file={outputPath} {database}
 * - Dump format: mysqldump -h 127.0.0.1 -P {port} -u root {database} | gzip > {outputPath}
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port } = container
  const { database, format } = options

  const mysqldump = await getMysqldumpPath()

  if (format === 'sql') {
    return createSqlBackup(mysqldump, port, database, outputPath)
  } else {
    return createCompressedBackup(mysqldump, port, database, outputPath)
  }
}

// Create a plain SQL backup
async function createSqlBackup(
  mysqldump: string,
  port: number,
  database: string,
  outputPath: string,
): Promise<BackupResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const safeResolve = (value: BackupResult) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    const safeReject = (err: Error) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    }

    const args = [
      '-h',
      '127.0.0.1',
      '-P',
      String(port),
      '-u',
      engineDef.superuser,
      '--set-gtid-purged=OFF', // Allows restoring to different MySQL instances
      '--result-file',
      outputPath,
      database,
    ]

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...getWindowsSpawnOptions(),
    }

    // On Windows with shell: true, paths with spaces must be quoted
    const command = isWindows() ? `"${mysqldump}"` : mysqldump
    const proc = spawn(command, args, spawnOptions)

    let stderr = ''

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      safeReject(err)
    })

    proc.on('close', async (code) => {
      if (code === 0) {
        try {
          const stats = await stat(outputPath)
          safeResolve({
            path: outputPath,
            format: 'sql',
            size: stats.size,
          })
        } catch (error) {
          safeReject(
            new Error(
              `Backup completed but failed to read output file: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
      } else {
        const errorMessage = stderr || `mysqldump exited with code ${code}`
        safeReject(new Error(errorMessage))
      }
    })
  })
}

/**
 * Create a compressed (gzipped) backup
 * Uses Node's zlib for compression instead of relying on system gzip
 */
async function createCompressedBackup(
  mysqldump: string,
  port: number,
  database: string,
  outputPath: string,
): Promise<BackupResult> {
  const args = [
    '-h',
    '127.0.0.1',
    '-P',
    String(port),
    '-u',
    engineDef.superuser,
    '--set-gtid-purged=OFF', // Allows restoring to different MySQL instances
    database,
  ]

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...getWindowsSpawnOptions(),
  }

  // On Windows with shell: true, paths with spaces must be quoted
  const command = isWindows() ? `"${mysqldump}"` : mysqldump
  const proc = spawn(command, args, spawnOptions)

  const gzip = createGzip()
  const output = createWriteStream(outputPath)

  let stderr = ''

  proc.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })

  const pipelinePromise = pipeline(proc.stdout!, gzip, output)

  const exitPromise = new Promise<void>((resolve, reject) => {
    proc.on('error', (err: NodeJS.ErrnoException) => {
      reject(err)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        const errorMessage = stderr || `mysqldump exited with code ${code}`
        reject(new Error(errorMessage))
      }
    })
  })

  // Wait for both pipeline AND process exit to complete
  // Use allSettled to handle case where both reject (avoids unhandled rejection)
  const results = await Promise.allSettled([pipelinePromise, exitPromise])

  // Check for any rejections - prefer exitPromise error as it has more context
  const [pipelineResult, exitResult] = results
  if (exitResult.status === 'rejected') {
    throw exitResult.reason
  }
  if (pipelineResult.status === 'rejected') {
    throw pipelineResult.reason
  }

  try {
    const stats = await stat(outputPath)
    return {
      path: outputPath,
      format: 'compressed',
      size: stats.size,
    }
  } catch (error) {
    throw new Error(
      `Backup completed but failed to read output file: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
