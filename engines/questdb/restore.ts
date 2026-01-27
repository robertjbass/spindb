/**
 * QuestDB Restore Implementation
 *
 * Restores SQL backups to QuestDB using PostgreSQL wire protocol.
 * QuestDB is compatible with psql for executing SQL statements.
 */

import { open, readFile } from 'fs/promises'
import { spawn, spawnSync } from 'child_process'
import { configManager } from '../../core/config-manager'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

// Read only the first 8KB for format detection
const HEADER_SIZE = 8192

/**
 * Detect the backup format from file content
 */
export async function detectBackupFormat(filePath: string): Promise<BackupFormat> {
  // Check extension first
  const lowerPath = filePath.toLowerCase()
  if (lowerPath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'SQL dump file',
      restoreCommand: 'psql',
    }
  }

  // Read file header for content-based detection
  const buffer = Buffer.alloc(HEADER_SIZE)
  const fd = await open(filePath, 'r')
  let bytesRead: number

  try {
    const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
    bytesRead = result.bytesRead
  } finally {
    await fd.close()
  }

  const content = buffer.toString('utf-8', 0, bytesRead)
  const lines = content.split(/\r?\n/)

  // Check for SQL patterns
  for (const line of lines.slice(0, 20)) {
    const trimmed = line.trim().toUpperCase()
    if (
      trimmed.startsWith('CREATE TABLE') ||
      trimmed.startsWith('INSERT INTO') ||
      trimmed.startsWith('-- QUESTDB') ||
      trimmed.startsWith('-- TABLE:')
    ) {
      return {
        format: 'sql',
        description: 'SQL dump file',
        restoreCommand: 'psql',
      }
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown format',
    restoreCommand: '',
  }
}

/**
 * Parse a QuestDB/PostgreSQL connection string
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  user: string
  password?: string
} {
  // Support both postgresql:// and questdb:// schemes
  let url: URL
  try {
    // Replace questdb:// with postgresql:// for URL parsing
    const normalized = connectionString.replace(/^questdb:\/\//, 'postgresql://')
    url = new URL(normalized)
  } catch {
    throw new Error(
      `Invalid connection string: ${connectionString}\n` +
        'Expected format: postgresql://user:password@host:port/database',
    )
  }

  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? parseInt(url.port, 10) : 8812,
    database: url.pathname.replace(/^\//, '') || 'qdb',
    user: url.username || 'admin',
    password: url.password || 'quest',
  }
}

export type RestoreOptions = {
  containerName: string
  port: number
  database: string
  version: string
  clean?: boolean
}

/**
 * Restore a backup to QuestDB
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database, clean } = options

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  if (format.format === 'unknown') {
    throw new Error(
      `Cannot detect backup format for: ${backupPath}\n` +
        'Supported formats: .sql (SQL dump)',
    )
  }

  logDebug(`Restoring ${format.format} backup to QuestDB database ${database}`)

  // Find psql binary
  let psqlPath = await configManager.getBinaryPath('psql')
  if (!psqlPath) {
    psqlPath = 'psql'
  }

  // Build restore command args
  const args = [
    '-h', '127.0.0.1',
    '-p', String(port),
    '-U', 'admin',
    '-d', database,
    '-f', backupPath,
  ]

  // For clean restore, drop existing tables before restoring
  if (clean) {
    logDebug('Clean restore requested - extracting table names from backup')

    // Read the SQL file and extract table names from CREATE TABLE statements
    const sqlContent = await readFile(backupPath, 'utf-8')
    // Match CREATE TABLE "table_name" or CREATE TABLE table_name
    const tableRegex = /CREATE\s+TABLE\s+(?:"([^"]+)"|(\w+))/gi
    const tables: string[] = []
    let match

    while ((match = tableRegex.exec(sqlContent)) !== null) {
      const tableName = match[1] || match[2]
      if (tableName && !tables.includes(tableName)) {
        tables.push(tableName)
      }
    }

    if (tables.length > 0) {
      logDebug(`Found ${tables.length} tables to drop: ${tables.join(', ')}`)

      // Execute DROP TABLE IF EXISTS for each table
      for (const table of tables) {
        const dropQuery = `DROP TABLE IF EXISTS "${table}";`
        logDebug(`Executing: ${dropQuery}`)

        const dropResult = spawnSync(psqlPath!, [
          '-h', '127.0.0.1',
          '-p', String(port),
          '-U', 'admin',
          '-d', database,
          '-c', dropQuery,
        ], {
          env: { ...process.env, PGPASSWORD: 'quest' },
        })

        if (dropResult.error) {
          logDebug(`Warning: Failed to drop table ${table}: ${dropResult.error.message}`)
        } else if (dropResult.status !== 0) {
          logDebug(`Warning: DROP TABLE ${table} exited with code ${dropResult.status}`)
        }
      }
    } else {
      logDebug('No CREATE TABLE statements found in backup')
    }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(psqlPath!, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PGPASSWORD: 'quest' },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({
          format: format.format,
          stdout,
          stderr,
          code: 0,
        })
      } else if (stderr.includes('already exists')) {
        // Treat "already exists" as non-fatal (table recreation during restore)
        resolve({
          format: format.format,
          stdout,
          stderr,
          code: code ?? 1,
        })
      } else {
        reject(new Error(`Restore failed: ${stderr || `exit code ${code}`}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to execute psql: ${err.message}`))
    })
  })
}
