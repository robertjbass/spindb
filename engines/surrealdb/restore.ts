/**
 * SurrealDB restore module
 * Supports SurrealQL-based restores using surreal import
 */

import { spawn } from 'child_process'
import { open } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { logDebug } from '../../core/error-handler'
import { requireSurrealPath } from './cli-utils'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * SurrealQL keywords that indicate a SurrealDB backup
 */
const SURREALQL_KEYWORDS = [
  'DEFINE',
  'CREATE',
  'INSERT',
  'UPDATE',
  'SELECT',
  'DELETE',
  'RELATE',
  'LET',
  'BEGIN',
  'COMMIT',
  'USE NS',
  'USE DB',
  'OPTION IMPORT',
]

/**
 * Check if file content looks like SurrealQL
 * Only reads first 8KB to avoid loading large files into memory
 */
async function looksLikeSurql(filePath: string): Promise<boolean> {
  try {
    const HEADER_SIZE = 8192
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

    let surqlStatementsFound = 0
    const linesToCheck = 20
    let checkedLines = 0

    for (const line of lines) {
      if (checkedLines >= linesToCheck) break

      const trimmed = line.trim().toUpperCase()

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('#')) continue

      checkedLines++

      // Check for SurrealQL keywords
      for (const keyword of SURREALQL_KEYWORDS) {
        if (trimmed.startsWith(keyword)) {
          surqlStatementsFound++
          break
        }
      }

      if (surqlStatementsFound >= 2) {
        return true
      }
    }

    return surqlStatementsFound > 0
  } catch {
    return false
  }
}

/**
 * Detect backup format from file
 * Supports:
 * - SurrealQL: Schema + data statements
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
      format: 'unknown',
      description: 'Directory found - SurrealDB restore expects a single file',
      restoreCommand:
        'SurrealDB requires a single .surql file for restore',
    }
  }

  // Check file extension first for .surql files
  if (filePath.endsWith('.surql')) {
    return {
      format: 'surql',
      description: 'SurrealDB SurrealQL backup',
      restoreCommand:
        'Execute SurrealQL statements via surreal import (spindb restore handles this)',
    }
  }

  // Content-based detection
  if (await looksLikeSurql(filePath)) {
    return {
      format: 'surql',
      description: 'SurrealDB SurrealQL backup (detected by content)',
      restoreCommand:
        'Execute SurrealQL statements via surreal import (spindb restore handles this)',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use .surql file with SurrealQL statements',
  }
}

// Restore options for SurrealDB
export type RestoreOptions = {
  containerName: string
  port: number
  database?: string
  version?: string
}

/**
 * Restore from SurrealQL backup using surreal import
 */
async function restoreSurqlBackup(
  backupPath: string,
  port: number,
  namespace: string,
  database: string,
  version?: string,
): Promise<RestoreResult> {
  const surrealPath = await requireSurrealPath(version)

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = [
      'import',
      '--endpoint', `http://127.0.0.1:${port}`,
      '--user', 'root',
      '--pass', 'root',
      '--ns', namespace,
      '--db', database,
      backupPath,
    ]

    logDebug(`Running: surreal ${args.join(' ')}`)

    const proc = spawn(surrealPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
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
          format: 'surql',
          stdout: stdout || 'SurrealQL statements imported successfully',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `surreal import exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`Failed to spawn surreal import: ${error.message}`))
    })
  })
}

/**
 * Restore from backup
 * Supports:
 * - SurrealQL: Execute statements via surreal import
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { containerName, port, database = 'default', version } = options
  // Use container name as namespace (convert dashes to underscores)
  const namespace = containerName.replace(/-/g, '_')

  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  if (format.format === 'surql') {
    return restoreSurqlBackup(backupPath, port, namespace, database, version)
  }

  throw new Error(
    `Invalid backup format: ${format.format}. Use .surql file with SurrealQL statements.`,
  )
}

/**
 * Parse SurrealDB connection string
 * Format: surrealdb://[user:password@]host[:port][/namespace/database]
 * Or: ws://host:port or http://host:port
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  namespace: string
  database: string
  user?: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid SurrealDB connection string: expected a non-empty string',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    // Mask credentials in error message if present
    const sanitized = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//***:***@',
    )
    throw new Error(
      `Invalid SurrealDB connection string: "${sanitized}". ` +
        `Expected format: surrealdb://[user:password@]host[:port][/namespace/database]`,
      { cause: error },
    )
  }

  // Validate protocol
  const validProtocols = ['surrealdb:', 'ws:', 'wss:', 'http:', 'https:']
  if (!validProtocols.includes(url.protocol)) {
    throw new Error(
      `Invalid SurrealDB connection string: unsupported protocol "${url.protocol}". ` +
        `Expected one of: ${validProtocols.join(', ')}`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 8000

  // Parse namespace/database from pathname (e.g., /myns/mydb)
  const pathParts = url.pathname.split('/').filter(Boolean)
  const namespace = pathParts[0] || 'test'
  const database = pathParts[1] || 'test'

  return {
    host,
    port,
    namespace,
    database,
    user: url.username || undefined,
    password: url.password || undefined,
  }
}
