import { readFile } from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { configManager } from '@/core/config-manager'
import { findBinaryPathFresh } from '@/core/postgres-binary-manager'
import type { BackupFormat, RestoreResult } from '@/types'

const execAsync = promisify(exec)

/**
 * Detect the format of a PostgreSQL backup file
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  // Read the first few bytes to detect format
  const file = await readFile(filePath)
  const buffer = Buffer.alloc(16)

  // Copy first bytes
  file.copy(buffer, 0, 0, Math.min(16, file.length))

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
  if (file.length > 262) {
    const tarMagic = file.toString('ascii', 257, 262)
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

export type RestoreOptions = {
  port: number
  database: string
  user?: string
  format?: string
  pgRestorePath?: string
}

/**
 * Get psql path from config, with helpful error message
 */
async function getPsqlPath(): Promise<string> {
  const psqlPath = await configManager.getBinaryPath('psql')
  if (!psqlPath) {
    throw new Error(
      'psql not found. Install PostgreSQL client tools:\n' +
        '  macOS: brew install libpq && brew link --force libpq\n' +
        '  Ubuntu/Debian: apt install postgresql-client\n\n' +
        'Or configure manually: spindb config set psql /path/to/psql',
    )
  }
  return psqlPath
}

/**
 * Get pg_restore path from config or system PATH, with helpful error message
 */
async function getPgRestorePath(): Promise<string> {
  // First try to get from config (in case user has set a custom path)
  const configPath = await configManager.getBinaryPath('pg_restore')
  if (configPath) {
    return configPath
  }

  // Fall back to finding it on the system PATH with cache refresh
  const systemPath = await findBinaryPathFresh('pg_restore')
  if (!systemPath) {
    throw new Error(
      'pg_restore not found. Install PostgreSQL client tools:\n' +
        '  macOS: brew install libpq && brew link --force libpq\n' +
        '  Ubuntu/Debian: apt install postgresql-client\n' +
        '  CentOS/RHEL/Fedora: yum install postgresql\n\n' +
        'Or configure manually: spindb config set pg_restore /path/to/pg_restore',
    )
  }
  return systemPath
}

/**
 * Restore a backup to a PostgreSQL database
 */
export async function restoreBackup(
  _binPath: string, // Not used - using config manager instead
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database, user = 'postgres', format, pgRestorePath } = options

  const detectedFormat = format || (await detectBackupFormat(backupPath)).format

  if (detectedFormat === 'sql') {
    const psqlPath = await getPsqlPath()

    const result = await execAsync(
      `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${user} -d ${database} -f "${backupPath}"`,
      { maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer for large dumps
    )

    return {
      format: 'sql',
      ...result,
    }
  } else {
    // Use custom path if provided, otherwise find it dynamically
    const restorePath = pgRestorePath || (await getPgRestorePath())

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
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string }
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
