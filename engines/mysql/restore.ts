/**
 * MySQL/MariaDB Backup Detection and Restore
 *
 * Handles detecting backup formats and restoring MySQL dumps.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { createReadStream } from 'fs'
import { open } from 'fs/promises'
import { createGunzip } from 'zlib'
import { getMysqlClientPath } from './binary-detection'
import { validateRestoreCompatibility } from './version-validator'
import { getEngineDefaults } from '../../config/defaults'
import { logDebug, SpinDBError, ErrorCodes } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

const engineDef = getEngineDefaults('mysql')

/**
 * Check if running on Windows
 */
function isWindows(): boolean {
  return process.platform === 'win32'
}

// =============================================================================
// Backup Format Detection
// =============================================================================

/**
 * Detect the format of a MySQL backup file
 *
 * MySQL primarily uses SQL dumps (unlike PostgreSQL which has multiple formats).
 * We detect:
 * - MySQL SQL dump (mysqldump output)
 * - MariaDB SQL dump
 * - PostgreSQL dumps (to provide helpful error)
 * - Generic SQL files
 * - Compressed files (gzip)
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  const buffer = Buffer.alloc(128)
  const file = await open(filePath, 'r')
  await file.read(buffer, 0, 128, 0)
  await file.close()

  const header = buffer.toString('utf8')

  // Check for PostgreSQL custom format (PGDMP magic bytes)
  if (buffer.toString('ascii', 0, 5) === 'PGDMP') {
    return {
      format: 'postgresql_custom',
      description: 'PostgreSQL custom format dump (incompatible with MySQL)',
      restoreCommand: 'pg_restore',
    }
  }

  // Check for PostgreSQL SQL dump markers
  if (
    header.includes('-- PostgreSQL database dump') ||
    header.includes('pg_dump') ||
    header.includes('Dumped from database version')
  ) {
    return {
      format: 'postgresql_sql',
      description: 'PostgreSQL SQL dump (incompatible with MySQL)',
      restoreCommand: 'psql',
    }
  }

  // Check for gzip compression
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return {
      format: 'compressed',
      description: 'Gzip compressed SQL dump',
      restoreCommand: 'mysql',
    }
  }

  // Check for MySQL dump markers
  if (header.includes('-- MySQL dump')) {
    return {
      format: 'sql',
      description: 'MySQL SQL dump (mysqldump)',
      restoreCommand: 'mysql',
    }
  }

  // Check for MariaDB dump markers
  if (header.includes('-- MariaDB dump')) {
    return {
      format: 'sql',
      description: 'MariaDB SQL dump (mysqldump)',
      restoreCommand: 'mysql',
    }
  }

  // Check if it looks like SQL (starts with common SQL statements)
  const textStart = header.toLowerCase()
  if (
    textStart.startsWith('--') ||
    textStart.startsWith('/*') ||
    textStart.startsWith('set ') ||
    textStart.startsWith('create') ||
    textStart.startsWith('drop') ||
    textStart.startsWith('begin') ||
    textStart.startsWith('use ')
  ) {
    return {
      format: 'sql',
      description: 'SQL file',
      restoreCommand: 'mysql',
    }
  }

  // Default to SQL format
  return {
    format: 'unknown',
    description: 'Unknown format - will attempt as SQL',
    restoreCommand: 'mysql',
  }
}

/**
 * Check if the backup file is from the wrong engine and throw helpful error
 */
export function assertCompatibleFormat(format: BackupFormat): void {
  if (
    format.format === 'postgresql_custom' ||
    format.format === 'postgresql_sql'
  ) {
    throw new SpinDBError(
      ErrorCodes.WRONG_ENGINE_DUMP,
      `This appears to be a PostgreSQL dump file, but you're trying to restore it to MySQL.`,
      'fatal',
      `Create a PostgreSQL container instead:\n  spindb create mydb --engine postgresql --from <dump-file>`,
      {
        detectedFormat: format.format,
        expectedEngine: 'mysql',
        detectedEngine: 'postgresql',
      },
    )
  }
}

// =============================================================================
// Restore Options
// =============================================================================

export type RestoreOptions = {
  port: number
  database: string
  user?: string
  createDatabase?: boolean
  validateVersion?: boolean
}

// =============================================================================
// Restore Functions
// =============================================================================

/**
 * Restore a MySQL backup to a database
 *
 * CLI equivalent: mysql -h 127.0.0.1 -P {port} -u root {db} < {file}
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const {
    port,
    database,
    user = engineDef.superuser,
    validateVersion = true,
  } = options

  // Validate version compatibility if requested
  if (validateVersion) {
    try {
      await validateRestoreCompatibility({ dumpPath: backupPath })
    } catch (error) {
      // Re-throw SpinDBError, log and continue for other errors
      if (error instanceof Error && error.name === 'SpinDBError') {
        throw error
      }
      logDebug('Version validation failed, proceeding anyway', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const mysql = await getMysqlClientPath()
  if (!mysql) {
    throw new Error(
      'mysql client not found. Install MySQL client tools:\n' +
        '  macOS: brew install mysql-client\n' +
        '  Ubuntu/Debian: sudo apt install mysql-client',
    )
  }

  // Detect format and check for wrong engine
  const format = await detectBackupFormat(backupPath)
  logDebug('Detected backup format', { format: format.format })
  assertCompatibleFormat(format)

  // Restore using mysql client
  // CLI: mysql -h 127.0.0.1 -P {port} -u root {db} < {file}
  // For compressed files: gunzip -c {file} | mysql ...

  // Windows requires shell: true for proper process spawning
  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(isWindows() && { shell: true }),
  }

  return new Promise((resolve, reject) => {
    const args = ['-h', '127.0.0.1', '-P', String(port), '-u', user, database]

    const proc = spawn(mysql, args, spawnOptions)

    // Pipe backup file to stdin, decompressing if necessary
    const fileStream = createReadStream(backupPath)

    if (format.format === 'compressed') {
      // Decompress gzipped file before piping to mysql
      const gunzip = createGunzip()
      if (proc.stdin) {
        fileStream.pipe(gunzip).pipe(proc.stdin)
      }

      // Handle gunzip errors
      gunzip.on('error', (err) => {
        reject(new Error(`Failed to decompress backup file: ${err.message}`))
      })
    } else {
      if (proc.stdin) {
        fileStream.pipe(proc.stdin)
      }
    }

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      resolve({
        format: format.format,
        stdout,
        stderr,
        code: code ?? undefined,
      })
    })

    proc.on('error', reject)
  })
}

/**
 * Parse a MySQL connection string
 *
 * Format: mysql://user:pass@host:port/database
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: string
  user: string
  password: string
  database: string
} {
  const url = new URL(connectionString)
  return {
    host: url.hostname,
    port: url.port || '3306',
    user: url.username || 'root',
    password: url.password || '',
    database: url.pathname.slice(1), // Remove leading /
  }
}
