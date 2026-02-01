import { open } from 'fs/promises'
import { existsSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { configManager } from '../../core/config-manager'
import { findBinary } from '../../core/dependency-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { validateRestoreCompatibility } from './version-validator'
import { normalizeVersion } from './version-maps'
import { SpinDBError, ErrorCodes } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

const execAsync = promisify(exec)

/**
 * Detect the format of a PostgreSQL backup file
 *
 * Also detects MySQL/MariaDB dumps to provide helpful error messages.
 * Only reads the first 263 bytes needed for format detection.
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  // Read only the bytes needed for format detection (up to offset 262 for tar magic)
  const HEADER_SIZE = 263
  const buffer = Buffer.alloc(HEADER_SIZE)

  const fd = await open(filePath, 'r')
  let bytesRead: number
  try {
    const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
    bytesRead = result.bytesRead
  } finally {
    await fd.close()
  }

  const header = buffer.toString('utf8', 0, Math.min(128, bytesRead))

  // Check for MySQL/MariaDB dump markers (before PostgreSQL checks)
  if (header.includes('-- MySQL dump') || header.includes('-- MariaDB dump')) {
    return {
      format: 'mysql_sql',
      description: 'MySQL/MariaDB SQL dump (incompatible with PostgreSQL)',
      restoreCommand: 'mysql',
    }
  }

  // Check for PostgreSQL custom format magic number
  // Custom format starts with "PGDMP"
  if (buffer.toString('ascii', 0, 5) === 'PGDMP') {
    return {
      format: 'custom',
      description: 'PostgreSQL custom format (pg_dump -Fc)',
      restoreCommand: 'pg_restore',
    }
  }

  // Check for tar format (directory dumps are usually tar)
  // Tar files have "ustar" at offset 257
  if (bytesRead > 262) {
    const tarMagic = buffer.toString('ascii', 257, 262)
    if (tarMagic === 'ustar') {
      return {
        format: 'tar',
        description: 'PostgreSQL tar format (pg_dump -Ft)',
        restoreCommand: 'pg_restore',
      }
    }
  }

  // Check for gzip compression
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return {
      format: 'compressed',
      description: 'Gzip compressed (likely SQL or custom format)',
      restoreCommand: 'auto',
    }
  }

  // Check if it looks like SQL (starts with common SQL statements)
  const textStart = buffer.toString('utf8', 0, 16).toLowerCase()
  if (
    textStart.startsWith('--') ||
    textStart.startsWith('/*') ||
    textStart.startsWith('set ') ||
    textStart.startsWith('create') ||
    textStart.startsWith('drop') ||
    textStart.startsWith('begin') ||
    textStart.startsWith('pg_dump')
  ) {
    return {
      format: 'sql',
      description: 'Plain SQL format (pg_dump -Fp)',
      restoreCommand: 'psql',
    }
  }

  // Default to trying custom format
  return {
    format: 'unknown',
    description: 'Unknown format - will attempt custom format restore',
    restoreCommand: 'pg_restore',
  }
}

// Check if the backup file is from the wrong engine and throw helpful error
export function assertCompatibleFormat(format: BackupFormat): void {
  if (format.format === 'mysql_sql') {
    throw new SpinDBError(
      ErrorCodes.WRONG_ENGINE_DUMP,
      `This appears to be a MySQL/MariaDB dump file, but you're trying to restore it to PostgreSQL.`,
      'fatal',
      `Create a MySQL container instead:\n  spindb create mydb --engine mysql --from <dump-file>`,
      {
        detectedFormat: format.format,
        expectedEngine: 'postgresql',
        detectedEngine: 'mysql',
      },
    )
  }
}

export type RestoreOptions = {
  port: number
  database: string
  user?: string
  format?: string
  pgRestorePath?: string
  containerVersion?: string
}

/**
 * Get psql path for a specific PostgreSQL version.
 *
 * Prioritizes SpinDB-managed binaries that match the container's version,
 * falling back to system psql only if no matching version is found.
 *
 * @param containerVersion - The container's PostgreSQL version (e.g., "18" or "18.1.0")
 * @returns Path to the version-matched psql binary
 */
async function getPsqlPath(containerVersion?: string): Promise<string> {
  if (containerVersion) {
    // Normalize to full version (e.g., "18" -> "18.1.0")
    const fullVersion = normalizeVersion(containerVersion)

    // Get platform info for building the binary path
    const platformInfo = platformService.getPlatformInfo()
    const ext = platformInfo.platform === 'win32' ? '.exe' : ''

    // Try to find SpinDB-managed psql for the matching version
    const versionedBinPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedPsql = join(versionedBinPath, 'bin', `psql${ext}`)

    if (existsSync(versionedPsql)) {
      return versionedPsql
    }

    // Try to find any installed version for this major version
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'postgresql',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedPsql = join(installed.path, 'bin', `psql${ext}`)
      if (existsSync(installedPsql)) {
        return installedPsql
      }
    }
  }

  // Fall back to globally registered psql (system binary)
  const systemPsql = await configManager.getBinaryPath('psql')
  if (systemPsql) {
    return systemPsql
  }

  throw new Error(
    'psql not found. Install PostgreSQL client tools:\n' +
      '  macOS: brew install libpq && brew link --force libpq\n' +
      '  Ubuntu/Debian: apt install postgresql-client\n\n' +
      'Or configure manually: spindb config set psql /path/to/psql',
  )
}

/**
 * Get pg_restore path for a specific PostgreSQL version.
 *
 * Prioritizes SpinDB-managed binaries that match the container's version,
 * falling back to system pg_restore only if no matching version is found.
 *
 * @param containerVersion - The container's PostgreSQL version (e.g., "18" or "18.1.0")
 * @returns Path to the version-matched pg_restore binary
 */
async function getPgRestorePath(containerVersion?: string): Promise<string> {
  if (containerVersion) {
    // Normalize to full version (e.g., "18" -> "18.1.0")
    const fullVersion = normalizeVersion(containerVersion)

    // Get platform info for building the binary path
    const platformInfo = platformService.getPlatformInfo()
    const ext = platformInfo.platform === 'win32' ? '.exe' : ''

    // Try to find SpinDB-managed pg_restore for the matching version
    const versionedBinPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedPgRestore = join(versionedBinPath, 'bin', `pg_restore${ext}`)

    if (existsSync(versionedPgRestore)) {
      return versionedPgRestore
    }

    // Try to find any installed version for this major version
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'postgresql',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedPgRestore = join(installed.path, 'bin', `pg_restore${ext}`)
      if (existsSync(installedPgRestore)) {
        return installedPgRestore
      }
    }
  }

  // Fall back to globally registered pg_restore (system binary)
  const configPath = await configManager.getBinaryPath('pg_restore')
  if (configPath) {
    return configPath
  }

  // Fall back to finding it on the system PATH
  const result = await findBinary('pg_restore')
  if (!result) {
    throw new Error(
      'pg_restore not found. Download PostgreSQL binaries:\n' +
        '  spindb engines download postgresql\n\n' +
        'Or configure manually: spindb config set pg_restore /path/to/pg_restore',
    )
  }
  return result.path
}

// Restore a backup to a PostgreSQL database
export async function restoreBackup(
  _binPath: string, // Not used - using config manager instead
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const {
    port,
    database,
    user = 'postgres',
    format,
    pgRestorePath,
    containerVersion,
  } = options

  // Detect format and check for wrong engine
  const detectedBackupFormat = await detectBackupFormat(backupPath)
  assertCompatibleFormat(detectedBackupFormat)

  const detectedFormat = format || detectedBackupFormat.format

  // For pg_restore formats, validate version compatibility
  if (detectedFormat !== 'sql') {
    const restorePath =
      pgRestorePath || (await getPgRestorePath(containerVersion))

    // This will throw SpinDBError if versions are incompatible
    await validateRestoreCompatibility({
      dumpPath: backupPath,
      format: detectedFormat,
      pgRestorePath: restorePath,
    })
  }

  if (detectedFormat === 'sql') {
    const psqlPath = await getPsqlPath(containerVersion)

    const result = await execAsync(
      `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${user} -d ${database} -f "${backupPath}"`,
      { maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer for large dumps
    )

    return {
      format: 'sql',
      ...result,
    }
  } else {
    // Use custom path if provided, otherwise find version-matched binary
    const restorePath =
      pgRestorePath || (await getPgRestorePath(containerVersion))

    try {
      const formatFlag =
        detectedFormat === 'custom'
          ? '-Fc'
          : detectedFormat === 'tar'
            ? '-Ft'
            : ''
      const result = await execAsync(
        `"${restorePath}" -h 127.0.0.1 -p ${port} -U ${user} -d ${database} --no-owner --no-privileges ${formatFlag} "${backupPath}"`,
        { maxBuffer: 50 * 1024 * 1024 },
      )

      return {
        format: detectedFormat,
        ...result,
      }
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string }
      // pg_restore often returns non-zero even on partial success
      return {
        format: detectedFormat,
        stdout: e.stdout || '',
        stderr: e.stderr || e.message,
        code: 1,
      }
    }
  }
}
