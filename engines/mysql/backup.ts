/**
 * MySQL Backup
 *
 * Creates database backups in SQL or compressed (.dump = gzipped SQL) format using mysqldump.
 */

import { spawn } from 'child_process'
import { createWriteStream } from 'fs'
import { stat } from 'fs/promises'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
import { getMysqldumpPath } from './binary-detection'
import { getEngineDefaults } from '../../config/defaults'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

const engineDef = getEngineDefaults('mysql')

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
  if (!mysqldump) {
    throw new Error(
      'mysqldump not found. Install MySQL client tools:\n' +
        '  macOS: brew install mysql-client\n' +
        '  Ubuntu/Debian: sudo apt install mysql-client',
    )
  }

  if (format === 'sql') {
    return createSqlBackup(mysqldump, port, database, outputPath)
  } else {
    return createCompressedBackup(mysqldump, port, database, outputPath)
  }
}

/**
 * Create a plain SQL backup
 */
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
      '--result-file',
      outputPath,
      database,
    ]

    const proc = spawn(mysqldump, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      safeReject(err)
    })

    proc.on('close', async (code) => {
      if (code === 0) {
        const stats = await stat(outputPath)
        safeResolve({
          path: outputPath,
          format: 'sql',
          size: stats.size,
        })
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
      database,
    ]

    const proc = spawn(mysqldump, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const gzip = createGzip()
    const output = createWriteStream(outputPath)

    let stderr = ''

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    // Pipe mysqldump stdout -> gzip -> file
    pipeline(proc.stdout!, gzip, output)
      .then(async () => {
        const stats = await stat(outputPath)
        safeResolve({
          path: outputPath,
          format: 'compressed',
          size: stats.size,
        })
      })
      .catch(safeReject)

    proc.on('error', (err: NodeJS.ErrnoException) => {
      safeReject(err)
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        const errorMessage = stderr || `mysqldump exited with code ${code}`
        safeReject(new Error(errorMessage))
      }
      // If code is 0, the pipeline promise will resolve
    })
  })
}
