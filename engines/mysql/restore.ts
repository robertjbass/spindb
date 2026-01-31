/**
 * MySQL/MariaDB Backup Detection and Restore
 *
 * Handles detecting backup formats and restoring MySQL dumps.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { createReadStream, existsSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { createGunzip } from 'zlib'
import { validateRestoreCompatibility } from './version-validator'
import { getEngineDefaults } from '../../config/defaults'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { logDebug, SpinDBError, ErrorCodes } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

const engineDef = getEngineDefaults('mysql')

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

// Check if the backup file is from the wrong engine and throw helpful error
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
  binPath?: string // Optional path to MySQL binaries directory
  containerVersion?: string // Container's MySQL version for version-matched lookup
}

// =============================================================================
// Restore Functions
// =============================================================================

/**
 * Get the mysql client path for a specific MySQL version.
 *
 * Prioritizes SpinDB-managed binaries that match the container's version,
 * falling back to system mysql only if no matching version is found.
 *
 * Lookup order:
 * 1. binPath/bin/mysql (if explicitly provided)
 * 2. SpinDB-managed mysql matching the container version
 * 3. SpinDB-managed mysql matching the major version
 * 4. Config manager cached path
 * 5. System PATH
 *
 * @param binPath - Optional explicit path to MySQL binary directory
 * @param containerVersion - Container's MySQL version for version-matched lookup
 */
async function getMysqlClientPath(
  binPath?: string,
  containerVersion?: string,
): Promise<string> {
  const ext = platformService.getExecutableExtension()

  // First check if binPath is provided and has mysql client
  // hostdb packages MySQL binaries in a bin/ subdirectory
  if (binPath) {
    const mysqlPath = join(binPath, 'bin', `mysql${ext}`)
    if (existsSync(mysqlPath)) {
      return mysqlPath
    }
  }

  // Try version-matched SpinDB binary if containerVersion is provided
  if (containerVersion) {
    // Dynamic imports to avoid circular dependencies
    const { paths } = await import('../../config/paths')
    const { normalizeVersion } = await import('./version-maps')

    const fullVersion = normalizeVersion(containerVersion)
    const platformInfo = platformService.getPlatformInfo()

    // Try exact version match
    const versionedBinPath = paths.getBinaryPath({
      engine: 'mysql',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedMysql = join(versionedBinPath, 'bin', `mysql${ext}`)
    if (existsSync(versionedMysql)) {
      return versionedMysql
    }

    // Try major version match
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'mysql',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedMysql = join(installed.path, 'bin', `mysql${ext}`)
      if (existsSync(installedMysql)) {
        return installedMysql
      }
    }
  }

  // Fall back to config manager (verify file exists)
  const configPath = await configManager.getBinaryPath('mysql')
  if (configPath && existsSync(configPath)) {
    return configPath
  }

  // Fall back to system PATH
  const systemPath = await platformService.findToolPath('mysql')
  if (systemPath) {
    return systemPath
  }

  throw new Error(
    'mysql client not found. Ensure MySQL binaries are downloaded:\n' +
      '  spindb engines download mysql',
  )
}

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

    logDebug('Restoring backup with mysql', {
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
          'MySQL process stdin is not available, cannot restore backup',
        ),
      )
      return
    }

    // Handle EPIPE errors on stdin - this happens when mysql exits due to SQL errors
    // while we're still piping data. The actual error will be in stderr.
    proc.stdin.on('error', (err) => {
      // EPIPE is expected when the process exits early - don't reject here,
      // let the 'close' event handle it with the actual error from stderr
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        rejectOnce(
          new Error(`Failed to write to MySQL process: ${err.message}`),
        )
      }
    })

    // Prepend compatibility settings if requested
    if (withCompatSettings) {
      proc.stdin.write(COMPAT_INIT_SQL)
      logDebug('Prepended compatibility settings to restore')
    }

    if (format.format === 'compressed') {
      // Decompress gzipped file before piping to mysql
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
 * Restore a MySQL backup to a database
 *
 * CLI equivalent: mysql -h 127.0.0.1 -P {port} -u root {db} < {file}
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
    containerVersion,
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

  const mysql = await getMysqlClientPath(binPath, containerVersion)

  // Detect format and check for wrong engine
  const format = await detectBackupFormat(backupPath)
  logDebug('Detected backup format', { format: format.format })
  assertCompatibleFormat(format)

  // First attempt: try without compatibility settings
  const result = await doRestore(
    backupPath,
    mysql,
    port,
    database,
    user,
    format,
    false,
  )

  // Check if restore succeeded
  if (result.code === 0) {
    return result
  }

  // Check if it failed with row size error (ERROR 1118)
  // This happens when tables have too many VARCHAR columns for the default row format
  const isRowSizeError =
    result.rawStderr?.includes('ERROR 1118') ||
    result.rawStderr?.includes('Row size too large')

  if (isRowSizeError) {
    logDebug('Detected row size error, retrying with compatibility settings')

    // Retry with compatibility settings
    const retryResult = await doRestore(
      backupPath,
      mysql,
      port,
      database,
      user,
      format,
      true,
    )

    if (retryResult.code === 0) {
      return {
        ...retryResult,
        stdout:
          retryResult.stdout ||
          'Restore succeeded with compatibility mode (DYNAMIC row format)',
      }
    }

    // Still failed - report the retry error
    const errorMatch = retryResult.rawStderr?.match(/^ERROR\s+\d+.*$/m)
    const errorMessage = errorMatch
      ? errorMatch[0]
      : retryResult.rawStderr?.trim() || 'Unknown error'
    throw new Error(`MySQL restore failed: ${errorMessage}`)
  }

  // Failed with a different error - report it
  const errorMatch = result.rawStderr?.match(/^ERROR\s+\d+.*$/m)
  const errorMessage = errorMatch
    ? errorMatch[0]
    : result.rawStderr?.trim() || 'Unknown error'
  throw new Error(`MySQL restore failed: ${errorMessage}`)
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
