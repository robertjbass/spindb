/**
 * libSQL restore module
 * Supports binary (file copy) and SQL import restore formats
 */

import { existsSync } from 'fs'
import { readFile, mkdir, cp, rm } from 'fs/promises'
import { join } from 'path'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import {
  loadCredentials,
  getDefaultUsername,
} from '../../core/credential-manager'
import { libsqlQuery } from './api-client'
import {
  Engine,
  type BackupFormat,
  type RestoreResult,
  type LibSQLFormat,
} from '../../types'

/**
 * Split SQL content into individual statements, respecting quoted strings
 * and comments. Avoids breaking on semicolons inside string literals.
 */
function splitSqlStatements(content: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let inLineComment = false
  let inBlockComment = false
  let i = 0

  while (i < content.length) {
    const ch = content[i]
    const next = content[i + 1]

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
      }
      i++
      continue
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }

    if (inSingleQuote) {
      current += ch
      if (ch === "'" && next === "'") {
        current += next
        i += 2
        continue
      }
      if (ch === "'") {
        inSingleQuote = false
      }
      i++
      continue
    }

    if (inDoubleQuote) {
      current += ch
      if (ch === '"' && next === '"') {
        current += next
        i += 2
        continue
      }
      if (ch === '"') {
        inDoubleQuote = false
      }
      i++
      continue
    }

    // Not inside any quote or comment
    if (ch === '-' && next === '-') {
      inLineComment = true
      i += 2
      continue
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }

    if (ch === "'") {
      inSingleQuote = true
      current += ch
      i++
      continue
    }

    if (ch === '"') {
      inDoubleQuote = true
      current += ch
      i++
      continue
    }

    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed) {
        statements.push(trimmed)
      }
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }

  const trimmed = current.trim()
  if (trimmed) {
    statements.push(trimmed)
  }

  return statements
}

/**
 * Detect the backup format from a file path
 */
export function detectBackupFormat(filePath: string): BackupFormat {
  if (filePath.endsWith('.sql')) {
    return {
      format: 'sql',
      description: 'SQL dump',
      restoreCommand: `spindb restore <container> ${filePath}`,
    }
  }

  if (filePath.endsWith('.db')) {
    return {
      format: 'binary',
      description: 'Binary database copy',
      restoreCommand: `spindb restore <container> ${filePath}`,
    }
  }

  // Default to binary format for unknown extensions
  return {
    format: 'binary',
    description: 'Binary database copy (assumed)',
    restoreCommand: `spindb restore <container> ${filePath}`,
  }
}

/**
 * Restore a libSQL backup
 */
export async function restoreBackup(
  backupPath: string,
  options: {
    containerName: string
    dataDir: string
    port?: number
    format?: LibSQLFormat
  },
): Promise<RestoreResult> {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  const format = options.format || detectBackupFormat(backupPath).format

  if (format === 'sql') {
    return restoreSqlBackup(backupPath, options)
  }

  return restoreBinaryBackup(backupPath, options)
}

/**
 * Restore from a binary backup by copying the database directory.
 * sqld's data.db is a directory tree, not a single file.
 * Requires the server to be stopped.
 */
async function restoreBinaryBackup(
  backupPath: string,
  options: { containerName: string; dataDir: string },
): Promise<RestoreResult> {
  const dataDir =
    options.dataDir ||
    join(
      paths.getContainerPath(options.containerName, { engine: 'libsql' }),
      'data',
    )
  const dbPath = join(dataDir, 'data.db')

  logDebug(`Restoring binary backup to ${dbPath}`)

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true })
  }

  // Remove existing data.db directory/file before restoring
  if (existsSync(dbPath)) {
    await rm(dbPath, { recursive: true, force: true })
  }

  // Copy the backup directory tree
  await cp(backupPath, dbPath, { recursive: true })

  return {
    format: 'binary',
    stdout: `Restored binary backup to ${dbPath}. Start the container to use it.`,
  }
}

/**
 * Restore from a SQL dump via the HTTP API
 * Requires the server to be running
 */
async function restoreSqlBackup(
  backupPath: string,
  options: { containerName: string; port?: number },
): Promise<RestoreResult> {
  const port = options.port
  if (!port) {
    throw new Error(
      'SQL restore requires a running container. Start the container first, then retry.',
    )
  }

  logDebug(`Restoring SQL backup via HTTP API on port ${port}`)

  // Load auth token if credentials are stored
  const username = getDefaultUsername(Engine.LibSQL)
  const creds = await loadCredentials(
    options.containerName,
    Engine.LibSQL,
    username,
  )
  const authToken = creds?.apiKey ?? undefined

  const content = await readFile(backupPath, 'utf-8')

  // Split into individual statements using a state machine that respects
  // quoted strings and comments (avoids breaking on semicolons inside literals)
  const statements = splitSqlStatements(content)

  let executed = 0
  const failures: Array<{ statement: string; error: string }> = []

  for (const stmt of statements) {
    // Skip transaction control statements - sqld handles transactions differently
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(stmt)) continue

    try {
      await libsqlQuery(port, `${stmt};`, { authToken })
      executed++
    } catch (error) {
      const message = (error as Error).message
      const preview = stmt.length > 80 ? `${stmt.slice(0, 80)}...` : stmt
      failures.push({ statement: preview, error: message })
      logDebug(`Warning: statement failed during restore: ${message}`)
    }
  }

  let summary = `Restored ${executed} SQL statements from backup.`
  if (failures.length > 0) {
    summary += ` ${failures.length} statement(s) failed.`
    logDebug(
      `Restore failures:\n${failures.map((f) => `  ${f.statement}: ${f.error}`).join('\n')}`,
    )
  }

  return {
    format: 'sql',
    stdout: summary,
  }
}
