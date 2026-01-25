/**
 * FerretDB restore module
 *
 * Restores backups using pg_restore or psql on the embedded PostgreSQL backend.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { logDebug, logWarning } from '../../core/error-handler'
import { platformService } from '../../core/platform-service'
import { ferretdbBinaryManager } from './binary-manager'
import {
  normalizeDocumentDBVersion,
  DEFAULT_DOCUMENTDB_VERSION,
} from './version-maps'
import type { ContainerConfig, BackupFormat, RestoreResult } from '../../types'

/**
 * Resolve the path to a postgresql-documentdb binary
 * Shared helper to avoid duplication between getPgRestorePath and getPsqlPath
 */
function getDocumentDBBinaryPath(
  container: ContainerConfig,
  binaryName: string,
): string {
  const { backendVersion } = container
  const { platform, arch } = platformService.getPlatformInfo()

  const fullBackendVersion = normalizeDocumentDBVersion(
    backendVersion || DEFAULT_DOCUMENTDB_VERSION,
  )
  const documentdbPath = ferretdbBinaryManager.getDocumentDBBinaryPath(
    fullBackendVersion,
    platform,
    arch,
  )

  const ext = platformService.getExecutableExtension()
  return join(documentdbPath, 'bin', `${binaryName}${ext}`)
}

/**
 * Get the path to pg_restore from the postgresql-documentdb installation
 */
function getPgRestorePath(container: ContainerConfig): string {
  return getDocumentDBBinaryPath(container, 'pg_restore')
}

/**
 * Get the path to psql from the postgresql-documentdb installation
 */
function getPsqlPath(container: ContainerConfig): string {
  return getDocumentDBBinaryPath(container, 'psql')
}

/**
 * Detect the format of a backup file
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file not found: ${filePath}`)
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'directory',
      description: 'PostgreSQL directory format backup',
      restoreCommand: `pg_restore -h 127.0.0.1 -p PORT -U postgres -d DATABASE ${filePath}`,
    }
  }

  // Check file header to determine format
  try {
    const buffer = Buffer.alloc(256)
    const fd = await open(filePath, 'r')
    let bytesRead = 0
    try {
      const result = await fd.read(buffer, 0, 256, 0)
      bytesRead = result.bytesRead
    } finally {
      await fd.close().catch(() => {})
    }

    // PostgreSQL custom format starts with "PGDMP"
    const header = buffer.toString('ascii', 0, 5)
    if (header === 'PGDMP') {
      return {
        format: 'custom',
        description: 'PostgreSQL custom format backup',
        restoreCommand: `pg_restore -h 127.0.0.1 -p PORT -U postgres -d DATABASE ${filePath}`,
      }
    }

    // Check for SQL format using a larger buffer with word-boundary checks
    // Strip BOM (Byte Order Mark) if present to avoid false negatives
    const textHeader = buffer
      .toString('utf8', 0, bytesRead)
      .replace(/^\uFEFF/, '')
      .toLowerCase()
    const isSqlFormat =
      textHeader.startsWith('--') ||
      textHeader.startsWith('/*') ||
      textHeader.includes('\n--') ||
      textHeader.includes('\n/*') ||
      /(?:^|\s)create\s/.test(textHeader) ||
      /(?:^|\s)insert\s/.test(textHeader) ||
      /(?:^|\s)drop\s/.test(textHeader) ||
      textHeader.includes('pg_dump')
    if (isSqlFormat) {
      return {
        format: 'sql',
        description: 'Plain SQL backup',
        restoreCommand: `psql -h 127.0.0.1 -p PORT -U postgres -d DATABASE -f ${filePath}`,
      }
    }

    // Check file extension as fallback
    if (filePath.endsWith('.dump')) {
      return {
        format: 'custom',
        description: 'PostgreSQL custom format backup (by extension)',
        restoreCommand: `pg_restore -h 127.0.0.1 -p PORT -U postgres -d DATABASE ${filePath}`,
      }
    }

    if (filePath.endsWith('.sql')) {
      return {
        format: 'sql',
        description: 'Plain SQL backup (by extension)',
        restoreCommand: `psql -h 127.0.0.1 -p PORT -U postgres -d DATABASE -f ${filePath}`,
      }
    }

    return {
      format: 'unknown',
      description: 'Unknown format - attempting as custom format',
      restoreCommand: `pg_restore -h 127.0.0.1 -p PORT -U postgres -d DATABASE ${filePath}`,
    }
  } catch {
    return {
      format: 'unknown',
      description: 'Could not detect format',
      restoreCommand: `pg_restore -h 127.0.0.1 -p PORT -U postgres -d DATABASE ${filePath}`,
    }
  }
}

// Restore options
export type RestoreOptions = {
  database: string
  drop?: boolean
}

/**
 * Restore a backup to a FerretDB container
 *
 * Uses pg_restore for custom format backups, psql for SQL format
 */
export async function restoreBackup(
  container: ContainerConfig,
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { backendPort } = container
  const { database, drop = true } = options

  if (!backendPort) {
    throw new Error(
      'Backend port not set. Make sure the container is running before restoring.',
    )
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  // Choose restore tool based on format
  const isSqlFormat = format.format === 'sql'
  const toolPath = isSqlFormat
    ? getPsqlPath(container)
    : getPgRestorePath(container)

  if (!existsSync(toolPath)) {
    const toolName = isSqlFormat ? 'psql' : 'pg_restore'
    throw new Error(
      `${toolName} not found at ${toolPath}. Make sure postgresql-documentdb is installed.`,
    )
  }

  const args: string[] = [
    '-h',
    '127.0.0.1',
    '-p',
    String(backendPort),
    '-U',
    'postgres',
    '-d',
    database,
  ]

  if (isSqlFormat) {
    // psql: use -f flag for file input
    args.push('-f', backupPath)
    if (drop) {
      logWarning(
        'SQL format restore: --clean is not supported. ' +
          'If you need to drop existing objects, ensure the SQL dump was created with pg_dump --clean.',
      )
    }
  } else {
    // pg_restore: add options for custom/directory format
    if (drop) {
      args.push('--clean', '--if-exists')
    }
    args.push(backupPath)
  }

  logDebug(
    `Running ${isSqlFormat ? 'psql' : 'pg_restore'} with args: ${args.join(' ')}`,
  )

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(toolPath, args, spawnOptions)

    let stdout = ''
    let stderr = ''
    let finished = false
    let spawnError: Error | null = null

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      spawnError = err
    })

    proc.on('close', (code) => {
      if (finished) return
      finished = true

      // If spawn itself failed, reject with that error
      if (spawnError) {
        reject(spawnError)
        return
      }

      if (code === 0) {
        resolve({
          format: format.format,
          stdout,
          stderr,
          code,
        })
      } else {
        // pg_restore may exit with non-zero but still restore some data
        // Only treat as warning-only if ALL non-empty lines match warning patterns
        // This prevents real errors mixed with warnings from being suppressed
        const stderrLines = stderr
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)

        const warningPatterns = [
          /\balready exists\b/,
          /^WARNING:/i,
          /^pg_restore: warning:/i,
        ]

        const allLinesAreWarnings =
          stderrLines.length > 0 &&
          stderrLines.every((line) =>
            warningPatterns.some((pattern) => pattern.test(line)),
          )

        // pg_restore outputs "errors ignored on restore: N" when it completes
        // despite encountering errors - this means the restore finished
        const pgRestoreCompletedWithIgnoredErrors =
          /pg_restore: warning: errors ignored on restore: \d+/i.test(stderr)

        const isWarningOnly = allLinesAreWarnings || pgRestoreCompletedWithIgnoredErrors

        if (isWarningOnly) {
          logWarning(`Restore completed with warnings: ${stderr}`)
          resolve({
            format: format.format,
            stdout,
            stderr,
            code: code ?? undefined,
          })
        } else {
          reject(
            new Error(
              stderr ||
                `${isSqlFormat ? 'psql' : 'pg_restore'} exited with code ${code}`,
            ),
          )
        }
      }
    })
  })
}
