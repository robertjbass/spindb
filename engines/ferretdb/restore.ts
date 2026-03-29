/**
 * FerretDB restore module
 *
 * Restores backups using pg_restore or psql on the embedded PostgreSQL backend.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { logDebug, logWarning } from '../../core/error-handler'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { buildMongoUri } from '../mongo-uri'
import { ferretdbBinaryManager } from './binary-manager'
import { getMongorestorePath, MONGORESTORE_NOT_FOUND_ERROR } from '../mongodb/cli-utils'
import {
  DEFAULT_DOCUMENTDB_VERSION,
  DEFAULT_V1_POSTGRESQL_VERSION,
  isV1,
} from './version-maps'
import {
  Engine,
  type ContainerConfig,
  type BinaryTool,
  type BackupFormat,
  type RestoreResult,
} from '../../types'

/**
 * Resolve the path to a PostgreSQL client binary (pg_restore, psql, etc.)
 *
 * Searches with fallbacks:
 * 1. Container's specific backend binary directory
 * 2. Any installed PostgreSQL version (newest first) — client tools are forward-compatible
 * 3. postgresql-documentdb installations
 * 4. System binary registered via `spindb config set`
 */
async function findBackendBinary(
  container: ContainerConfig,
  binaryName: BinaryTool,
): Promise<string> {
  const { version, backendVersion } = container
  const { platform, arch } = platformService.getPlatformInfo()
  const v1 = isV1(version)
  const ext = platformService.getExecutableExtension()

  const effectiveBackendVersion = v1
    ? backendVersion || DEFAULT_V1_POSTGRESQL_VERSION
    : backendVersion || DEFAULT_DOCUMENTDB_VERSION

  // 1. Try the container's own backend path
  const backendPath = ferretdbBinaryManager.getBackendBinaryPath(
    version,
    effectiveBackendVersion,
    platform,
    arch,
  )
  const primaryPath = join(backendPath, 'bin', `${binaryName}${ext}`)
  if (existsSync(primaryPath)) {
    return primaryPath
  }

  logDebug(
    `${binaryName} not found at ${primaryPath}, searching other installed PostgreSQL versions`,
  )

  // 2. Search all installed PostgreSQL versions (newest first)
  const installed = paths.findInstalledBinaries('postgresql', platform, arch)
  for (const entry of installed) {
    const candidate = join(entry.path, 'bin', `${binaryName}${ext}`)
    if (existsSync(candidate)) {
      logDebug(`Found ${binaryName} in PostgreSQL ${entry.version}`)
      return candidate
    }
  }

  // 3. Check postgresql-documentdb installations
  const documentdbInstalled = paths.findInstalledBinaries(
    'postgresql-documentdb',
    platform,
    arch,
  )
  for (const entry of documentdbInstalled) {
    const candidate = join(entry.path, 'bin', `${binaryName}${ext}`)
    if (existsSync(candidate)) {
      logDebug(`Found ${binaryName} in postgresql-documentdb ${entry.version}`)
      return candidate
    }
  }

  // 4. Fall back to system binary
  const systemBinary = await configManager.getBinaryPath(binaryName)
  if (systemBinary) {
    return systemBinary
  }

  const backendName = v1 ? 'PostgreSQL' : 'postgresql-documentdb'
  throw new Error(
    `${binaryName} not found. The ${backendName} installation at ${backendPath} does not include client tools.\n` +
      'Install PostgreSQL client tools:\n' +
      '  macOS: brew install libpq && brew link --force libpq\n' +
      '  Ubuntu/Debian: apt install postgresql-client\n\n' +
      `Or configure manually: spindb config set ${binaryName} /path/to/${binaryName}`,
  )
}

/**
 * Get the path to pg_restore
 */
async function getPgRestorePath(container: ContainerConfig): Promise<string> {
  return findBackendBinary(container, 'pg_restore')
}

/**
 * Get the path to psql
 */
async function getPsqlPath(container: ContainerConfig): Promise<string> {
  return findBackendBinary(container, 'psql')
}

function addNamespaceRemapArgs(
  args: string[],
  sourceDatabase: string | undefined,
  targetDatabase: string,
): void {
  if (sourceDatabase) {
    args.push(
      `--nsFrom=${sourceDatabase}.$collection$`,
      `--nsTo=${targetDatabase}.$collection$`,
    )
    return
  }

  args.push(
    '--nsFrom=$db$.$collection$',
    `--nsTo=${targetDatabase}.$collection$`,
  )
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
      description: 'MongoDB directory dump (BSON files)',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE ${filePath}`,
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
        description: 'Legacy PostgreSQL custom format backup',
        restoreCommand: `pg_restore -h 127.0.0.1 -p PORT -U postgres -d ferretdb ${filePath}`,
      }
    }

    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      return {
        format: 'archive-gzip',
        description: 'MongoDB archive (gzip compressed)',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath} --gzip`,
      }
    }

    const mongoHeader = buffer.toString('utf8', 0, 16)
    if (mongoHeader.startsWith('mtools') || mongoHeader.includes('mongo')) {
      return {
        format: 'archive',
        description: 'MongoDB archive',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath}`,
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
        description: 'Legacy plain SQL backup',
        restoreCommand: `psql -h 127.0.0.1 -p PORT -U postgres -d ferretdb -f ${filePath}`,
      }
    }

    // Check file extension as fallback
    if (filePath.endsWith('.bson')) {
      return {
        format: 'bson',
        description: 'MongoDB BSON file',
        restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE ${filePath}`,
      }
    }

    if (filePath.endsWith('.dump')) {
      return {
        format: 'custom',
        description: 'Legacy PostgreSQL custom format backup (by extension)',
        restoreCommand: `pg_restore -h 127.0.0.1 -p PORT -U postgres -d ferretdb ${filePath}`,
      }
    }

    if (filePath.endsWith('.sql')) {
      return {
        format: 'sql',
        description: 'Legacy plain SQL backup (by extension)',
        restoreCommand: `psql -h 127.0.0.1 -p PORT -U postgres -d ferretdb -f ${filePath}`,
      }
    }

    return {
      format: 'unknown',
      description: 'Unknown format - attempting MongoDB archive restore',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath}`,
    }
  } catch {
    return {
      format: 'unknown',
      description: 'Could not detect format',
      restoreCommand: `mongorestore --host 127.0.0.1 --port PORT --db DATABASE --archive=${filePath}`,
    }
  }
}

// Restore options
export type RestoreOptions = {
  containerName?: string
  port: number
  database: string
  drop?: boolean
  timeoutMs?: number // Timeout in milliseconds (default: 5 minutes)
  sourceDatabase?: string
  containerVersion?: string
}

// Default timeout for restore operations (5 minutes)
const DEFAULT_RESTORE_TIMEOUT_MS = 5 * 60 * 1000

async function restoreViaMongo(
  backupPath: string,
  options: RestoreOptions,
  format: BackupFormat,
): Promise<RestoreResult> {
  const { port, database, drop = true, sourceDatabase, containerVersion } =
    options

  const mongorestore = await getMongorestorePath(containerVersion)
  if (!mongorestore) {
    throw new Error(MONGORESTORE_NOT_FOUND_ERROR)
  }

  const savedCreds = options.containerName
    ? await loadCredentials(
        options.containerName,
        Engine.FerretDB,
        getDefaultUsername(Engine.FerretDB),
      )
    : null

  const args: string[] = savedCreds
    ? [
        '--uri',
        buildMongoUri(port, database, {
          username: savedCreds.username,
          password: savedCreds.password,
          authDatabase: savedCreds.database || 'admin',
        }),
      ]
    : ['--host', '127.0.0.1', '--port', String(port)]

  if (drop) {
    args.push('--drop')
  }

  const isArchiveFormat =
    format.format === 'archive-gzip' ||
    format.format === 'archive' ||
    format.format === 'unknown'

  if (!isArchiveFormat) {
    args.push('--db', database)
  }

  if (format.format === 'directory') {
    const targetDbDir = join(backupPath, database)
    if (existsSync(targetDbDir)) {
      args.push(targetDbDir)
    } else {
      let restorePath = backupPath

      try {
        const entries = readdirSync(backupPath, { withFileTypes: true })
        const dbDirs = entries.filter((entry) => entry.isDirectory())

        if (dbDirs.length === 1) {
          restorePath = join(backupPath, dbDirs[0].name)
        } else if (dbDirs.length > 1) {
          const dbWithBson = dbDirs.find((entry) => {
            const files = readdirSync(join(backupPath, entry.name))
            return files.some((file) => file.endsWith('.bson'))
          })
          if (dbWithBson) {
            restorePath = join(backupPath, dbWithBson.name)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logWarning(
          `Failed to inspect FerretDB backup directory "${backupPath}": ${message}. Falling back to root directory restore.`,
        )
      }

      args.push(restorePath)
    }
  } else if (format.format === 'archive-gzip') {
    args.push('--archive=' + backupPath, '--gzip')
    addNamespaceRemapArgs(args, sourceDatabase, database)
  } else if (format.format === 'archive') {
    args.push('--archive=' + backupPath)
    addNamespaceRemapArgs(args, sourceDatabase, database)
  } else if (format.format === 'bson') {
    args.push(backupPath)
  } else {
    args.push('--archive=' + backupPath, '--gzip')
    addNamespaceRemapArgs(args, sourceDatabase, database)
  }

  logDebug(`Running mongorestore with args: ${args.join(' ')}`)

  return new Promise((resolve, reject) => {
    const proc = spawn(mongorestore, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ format: format.format, stdout, stderr, code })
      } else {
        reject(new Error(stderr || `mongorestore exited with code ${code}`))
      }
    })
  })
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
  const { database, drop = true, timeoutMs = DEFAULT_RESTORE_TIMEOUT_MS } =
    options

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  if (
    format.format === 'archive-gzip' ||
    format.format === 'archive' ||
    format.format === 'directory' ||
    format.format === 'bson' ||
    format.format === 'unknown'
  ) {
    return restoreViaMongo(backupPath, options, format)
  }

  if (!backendPort) {
    throw new Error(
      'Backend port not set. Make sure the container is running before restoring.',
    )
  }

  // Choose restore tool based on format
  const isSqlFormat = format.format === 'sql'
  const toolPath = isSqlFormat
    ? await getPsqlPath(container)
    : await getPgRestorePath(container)

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
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    // Helper to clean up and mark finished
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      finished = true
    }

    // Start timeout timer
    timeoutId = setTimeout(() => {
      if (finished) return
      cleanup()
      // Defensively kill the process - it may have already exited between
      // the finished check and this call, so wrap in try-catch
      try {
        if (proc.exitCode === null && !proc.killed) {
          proc.kill('SIGTERM')
        }
      } catch {
        // Process already exited or otherwise not killable - ignore
      }
      reject(
        new Error(
          `Restore timed out after ${timeoutMs}ms. The ${isSqlFormat ? 'psql' : 'pg_restore'} process was killed.`,
        ),
      )
    }, timeoutMs)

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      // Immediately reject and mark finished to prevent race with close handler
      if (finished) return
      cleanup()
      reject(err)
    })

    proc.on('close', (code) => {
      if (finished) return
      cleanup()

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

        const isWarningOnly =
          allLinesAreWarnings || pgRestoreCompletedWithIgnoredErrors

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
