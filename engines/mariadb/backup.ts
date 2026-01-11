/**
 * MariaDB Backup
 *
 * Creates database backups in SQL or compressed (.dump = gzipped SQL) format using mariadb-dump.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
import {
  getWindowsSpawnOptions,
  isWindows,
  platformService,
} from '../../core/platform-service'
import { getEngineDefaults } from '../../config/defaults'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

const engineDef = getEngineDefaults('mariadb')

/**
 * Get the path to mariadb-dump or mysqldump from the container's binary path
 */
async function getDumpPath(container: ContainerConfig): Promise<string> {
  const { platform, arch } = platformService.getPlatformInfo()
  const ext = platform === 'win32' ? '.exe' : ''

  // Import dynamically to avoid circular dependency
  const { paths } = await import('../../config/paths')
  const { normalizeVersion } = await import('./version-maps')

  const fullVersion = normalizeVersion(container.version)
  const binPath = paths.getBinaryPath({
    engine: 'mariadb',
    version: fullVersion,
    platform,
    arch,
  })

  // Try mariadb-dump first, then mysqldump
  const mariadbDump = join(binPath, 'bin', `mariadb-dump${ext}`)
  if (existsSync(mariadbDump)) {
    return mariadbDump
  }

  const mysqldump = join(binPath, 'bin', `mysqldump${ext}`)
  if (existsSync(mysqldump)) {
    return mysqldump
  }

  throw new Error(
    'mariadb-dump or mysqldump not found in MariaDB binary directory.\n' +
      'Re-download the MariaDB binaries: spindb engines download mariadb',
  )
}

/**
 * Create a backup of a MariaDB database
 *
 * CLI equivalent:
 * - SQL format: mariadb-dump -h 127.0.0.1 -P {port} -u root --result-file={outputPath} {database}
 * - Dump format: mariadb-dump -h 127.0.0.1 -P {port} -u root {database} | gzip > {outputPath}
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port } = container
  const { database, format } = options

  const dumpPath = await getDumpPath(container)

  if (format === 'sql') {
    return createSqlBackup(dumpPath, port, database, outputPath)
  } else {
    return createCompressedBackup(dumpPath, port, database, outputPath)
  }
}

/**
 * Create a plain SQL backup
 */
async function createSqlBackup(
  dumpPath: string,
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
      '--result-file',
      outputPath,
      database,
    ]

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...getWindowsSpawnOptions(),
    }

    const command = isWindows() ? `"${dumpPath}"` : dumpPath
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
        const errorMessage = stderr || `mariadb-dump exited with code ${code}`
        safeReject(new Error(errorMessage))
      }
    })
  })
}

/**
 * Create a compressed (gzipped) backup
 */
async function createCompressedBackup(
  dumpPath: string,
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
    database,
  ]

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...getWindowsSpawnOptions(),
  }

  const command = isWindows() ? `"${dumpPath}"` : dumpPath
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
        const errorMessage = stderr || `mariadb-dump exited with code ${code}`
        reject(new Error(errorMessage))
      }
    })
  })

  const results = await Promise.allSettled([pipelinePromise, exitPromise])

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
