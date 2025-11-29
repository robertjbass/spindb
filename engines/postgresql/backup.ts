/**
 * PostgreSQL Backup
 *
 * Creates database backups in SQL or custom (.dump) format using pg_dump.
 */

import { spawn } from 'child_process'
import { stat } from 'fs/promises'
import { configManager } from '../../core/config-manager'
import { defaults } from '../../config/defaults'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

/**
 * Get pg_dump path from config, with helpful error message
 */
async function getPgDumpPath(): Promise<string> {
  const pgDumpPath = await configManager.getBinaryPath('pg_dump')
  if (!pgDumpPath) {
    throw new Error(
      'pg_dump not found. Install PostgreSQL client tools:\n' +
        '  macOS: brew install libpq && brew link --force libpq\n' +
        '  Ubuntu/Debian: apt install postgresql-client\n\n' +
        'Or configure manually: spindb config set pg_dump /path/to/pg_dump',
    )
  }
  return pgDumpPath
}

/**
 * Create a backup of a PostgreSQL database
 *
 * CLI equivalent:
 * - SQL format: pg_dump -Fp -h 127.0.0.1 -p {port} -U postgres -d {database} -f {outputPath}
 * - Dump format: pg_dump -Fc -h 127.0.0.1 -p {port} -U postgres -d {database} -f {outputPath}
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port } = container
  const { database, format } = options

  const pgDumpPath = await getPgDumpPath()

  // -Fp = plain SQL format, -Fc = custom format
  const formatFlag = format === 'sql' ? '-Fp' : '-Fc'

  return new Promise((resolve, reject) => {
    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      defaults.superuser,
      '-d',
      database,
      formatFlag,
      '-f',
      outputPath,
    ]

    const proc = spawn(pgDumpPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      reject(err)
    })

    proc.on('close', async (code) => {
      if (code === 0) {
        // Get file size
        const stats = await stat(outputPath)
        resolve({
          path: outputPath,
          format: format === 'sql' ? 'sql' : 'custom',
          size: stats.size,
        })
      } else {
        const errorMessage = stderr || `pg_dump exited with code ${code}`
        reject(new Error(errorMessage))
      }
    })
  })
}
