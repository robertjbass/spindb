/**
 * MariaDB Backup Detection and Restore
 *
 * Handles detecting backup formats and restoring MariaDB dumps.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { createReadStream, existsSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { createGunzip } from 'zlib'
import { validateRestoreCompatibility } from './version-validator'
import { getEngineDefaults } from '../../config/defaults'
import { logDebug, SpinDBError, ErrorCodes } from '../../core/error-handler'
import { platformService } from '../../core/platform-service'
import { Platform, type BackupFormat, type RestoreResult } from '../../types'

const engineDef = getEngineDefaults('mariadb')

// =============================================================================
// Backup Format Detection
// =============================================================================

/**
 * Detect the format of a MariaDB backup file
 *
 * We detect:
 * - MariaDB SQL dump
 * - MySQL SQL dump (compatible with MariaDB)
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
      description: 'PostgreSQL custom format dump (incompatible with MariaDB)',
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
      description: 'PostgreSQL SQL dump (incompatible with MariaDB)',
      restoreCommand: 'psql',
    }
  }

  // Check for gzip compression
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return {
      format: 'compressed',
      description: 'Gzip compressed SQL dump',
      restoreCommand: 'mariadb',
    }
  }

  // Check for MariaDB dump markers
  if (header.includes('-- MariaDB dump')) {
    return {
      format: 'sql',
      description: 'MariaDB SQL dump (mariadb-dump)',
      restoreCommand: 'mariadb',
    }
  }

  // Check for MySQL dump markers (compatible with MariaDB)
  if (header.includes('-- MySQL dump')) {
    return {
      format: 'sql',
      description: 'MySQL SQL dump (compatible with MariaDB)',
      restoreCommand: 'mariadb',
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
      restoreCommand: 'mariadb',
    }
  }

  // Default to SQL format
  return {
    format: 'unknown',
    description: 'Unknown format - will attempt as SQL',
    restoreCommand: 'mariadb',
  }
}

// Check if the backup file is from the wrong engine and throw helpful error
export function assertCompatibleFormat(format: BackupFormat): void {
  if (
    format.format === 'postgresql_custom' ||
    format.format === 'postgresql_sql'
  ) {
    throw new SpinDBError(
      ErrorCodes.WRONG_ENGINE_DUMP,
      `This appears to be a PostgreSQL dump file, but you're trying to restore it to MariaDB.`,
      'fatal',
      `Create a PostgreSQL container instead:\n  spindb create mydb --engine postgresql --from <dump-file>`,
      {
        detectedFormat: format.format,
        expectedEngine: 'mariadb',
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
  binPath: string
}

// Get the path to mariadb or mysql client from the binary path
function getMysqlClientPath(binPath: string): string {
  const { platform } = platformService.getPlatformInfo()
  const ext = platform === Platform.Win32 ? '.exe' : ''

  // Try mariadb first, then mysql
  const mariadb = join(binPath, 'bin', `mariadb${ext}`)
  if (existsSync(mariadb)) {
    return mariadb
  }

  const mysql = join(binPath, 'bin', `mysql${ext}`)
  if (existsSync(mysql)) {
    return mysql
  }

  throw new Error(
    'mariadb or mysql client not found in MariaDB binary directory.\n' +
      'Re-download the MariaDB binaries: spindb engines download mariadb',
  )
}

// =============================================================================
// Restore Functions
// =============================================================================

// Compatibility SQL to handle large row sizes and other edge cases
// - innodb_default_row_format=DYNAMIC: Store long columns off-page to avoid row size limits
// - innodb_strict_mode=OFF: Allow tables that might exceed row size limits in strict mode
// - foreign_key_checks=0: Defer FK checks until after all tables are created
// - unique_checks=0: Speed up bulk inserts
const COMPAT_INIT_SQL = [
  "SET GLOBAL innodb_default_row_format='dynamic';",
  'SET SESSION innodb_strict_mode=OFF;',
  "SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION';",
  'SET SESSION foreign_key_checks=0;',
  'SET SESSION unique_checks=0;',
  '',
].join('\n')

/**
 * Internal restore function with optional compatibility mode
 */
function doRestore(
  backupPath: string,
  mysql: string,
  port: number,
  database: string,
  user: string,
  format: BackupFormat,
  withCompatSettings: boolean,
): Promise<RestoreResult & { rawStderr?: string }> {
  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const args = ['-h', '127.0.0.1', '-P', String(port), '-u', user, database]

    logDebug('Restoring backup with mariadb client', {
      mysql,
      args,
      withCompatSettings,
    })

    const proc = spawn(mysql, args, spawnOptions)

    // Track whether we've already settled the promise to avoid duplicate rejections
    let settled = false
    const fileStream = createReadStream(backupPath)

    const rejectOnce = (err: Error) => {
      if (settled) return
      settled = true
      fileStream.destroy()
      proc.stdin?.end()
      reject(err)
    }

    // Handle file read errors
    fileStream.on('error', (err) => {
      rejectOnce(new Error(`Failed to read backup file: ${err.message}`))
    })

    if (!proc.stdin) {
      rejectOnce(
        new Error(
          'MariaDB process stdin is not available, cannot restore backup',
        ),
      )
      return
    }

    // Handle EPIPE errors on stdin - this happens when mariadb exits due to SQL errors
    // while we're still piping data. The actual error will be in stderr.
    proc.stdin.on('error', (err) => {
      // EPIPE is expected when the process exits early - don't reject here,
      // let the 'close' event handle it with the actual error from stderr
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        rejectOnce(new Error(`Failed to write to MariaDB process: ${err.message}`))
      }
    })

    // Prepend compatibility settings if requested
    if (withCompatSettings) {
      proc.stdin.write(COMPAT_INIT_SQL)
      logDebug('Prepended compatibility settings to restore')
    }

    if (format.format === 'compressed') {
      // Decompress gzipped file before piping to mariadb
      const gunzip = createGunzip()
      fileStream.pipe(gunzip).pipe(proc.stdin)

      // Handle gunzip errors
      gunzip.on('error', (err) => {
        fileStream.unpipe(gunzip)
        gunzip.unpipe(proc.stdin!)
        rejectOnce(
          new Error(`Failed to decompress backup file: ${err.message}`),
        )
      })
    } else {
      fileStream.pipe(proc.stdin)
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
      if (settled) return
      settled = true

      resolve({
        format: format.format,
        stdout,
        stderr,
        rawStderr: stderr,
        code: code ?? undefined,
      })
    })

    proc.on('error', (err) => {
      rejectOnce(err)
    })
  })
}

/**
 * Restore a MariaDB backup to a database
 *
 * CLI equivalent: mariadb -h 127.0.0.1 -P {port} -u root {db} < {file}
 *
 * Uses retry logic: if restore fails with ERROR 1118 (row size too large),
 * automatically retries with compatibility settings that enable DYNAMIC row format.
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
    binPath,
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

  const mysql = getMysqlClientPath(binPath)

  // Detect format and check for wrong engine
  const format = await detectBackupFormat(backupPath)
  logDebug('Detected backup format', { format: format.format })
  assertCompatibleFormat(format)

  // First attempt: try without compatibility settings
  const result = await doRestore(backupPath, mysql, port, database, user, format, false)

  // Check if restore succeeded
  if (result.code === 0) {
    return result
  }

  // Check if it failed with row size error (ERROR 1118)
  // This happens when tables have too many VARCHAR columns for the default row format
  const isRowSizeError = result.rawStderr?.includes('ERROR 1118') ||
    result.rawStderr?.includes('Row size too large')

  if (isRowSizeError) {
    logDebug('Detected row size error, retrying with compatibility settings')

    // Retry with compatibility settings
    const retryResult = await doRestore(backupPath, mysql, port, database, user, format, true)

    if (retryResult.code === 0) {
      return {
        ...retryResult,
        stdout: retryResult.stdout || 'Restore succeeded with compatibility mode (DYNAMIC row format)',
      }
    }

    // Still failed - report the retry error
    const errorMatch = retryResult.rawStderr?.match(/^ERROR\s+\d+.*$/m)
    const errorMessage = errorMatch ? errorMatch[0] : retryResult.rawStderr?.trim() || 'Unknown error'
    throw new Error(`MariaDB restore failed: ${errorMessage}`)
  }

  // Failed with a different error - report it
  const errorMatch = result.rawStderr?.match(/^ERROR\s+\d+.*$/m)
  const errorMessage = errorMatch ? errorMatch[0] : result.rawStderr?.trim() || 'Unknown error'
  throw new Error(`MariaDB restore failed: ${errorMessage}`)
}

/**
 * Parse a MariaDB/MySQL connection string
 *
 * Format: mysql://user:pass@host:port/database
 *         mariadb://user:pass@host:port/database
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: string
  user: string
  password: string
  database: string
} {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid MariaDB connection string: ${message}`)
  }

  const database = url.pathname.slice(1) // Remove leading /
  if (!database) {
    throw new Error(
      'Invalid MariaDB connection string: database name is required (e.g., mysql://user:pass@host:port/database)',
    )
  }

  return {
    host: url.hostname,
    port: url.port || '3306',
    user: url.username || 'root',
    password: url.password || '',
    database,
  }
}
