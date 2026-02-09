/**
 * TypeDB restore module
 * Supports TypeQL-based restores using typedb console import
 */

import { spawn } from 'child_process'
import { open } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { logDebug } from '../../core/error-handler'
import {
  requireTypeDBConsolePath,
  getConsoleBaseArgs,
  validateTypeDBIdentifier,
} from './cli-utils'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * TypeQL keywords that indicate a TypeDB backup
 */
const TYPEQL_KEYWORDS = [
  'DEFINE',
  'MATCH',
  'INSERT',
  'DELETE',
  'PUT',
  'UNDEFINE',
  'RULE',
  'TYPE',
  'ENTITY',
  'RELATION',
  'ATTRIBUTE',
  'OWNS',
  'PLAYS',
  'RELATES',
  'SUB',
  'ISA',
  'HAS',
]

/**
 * Check if file content looks like TypeQL
 * Only reads first 8KB to avoid loading large files into memory
 */
async function looksLikeTypeQL(filePath: string): Promise<boolean> {
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

    let typeqlStatementsFound = 0
    const linesToCheck = 20
    let checkedLines = 0

    for (const line of lines) {
      if (checkedLines >= linesToCheck) break

      const trimmed = line.trim().toUpperCase()

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))
        continue

      checkedLines++

      // Check for TypeQL keywords
      for (const keyword of TYPEQL_KEYWORDS) {
        if (trimmed.startsWith(keyword) || trimmed.includes(` ${keyword} `)) {
          typeqlStatementsFound++
          break
        }
      }

      if (typeqlStatementsFound >= 2) {
        return true
      }
    }

    return typeqlStatementsFound > 0
  } catch {
    return false
  }
}

/**
 * Check if a .typeql backup path has companion schema/data pair files
 */
function hasSchemaDataPair(filePath: string): boolean {
  return (
    filePath.endsWith('.typeql') &&
    (existsSync(filePath.replace(/\.typeql$/, '-schema.typeql')) ||
      existsSync(filePath.replace(/\.typeql$/, '-data.typeql')))
  )
}

/**
 * Detect backup format from file
 * Supports:
 * - TypeQL: Schema + data statements
 */
export async function detectBackupFormat(
  filePath: string,
): Promise<BackupFormat> {
  // TypeDB backup creates schema/data pair files (-schema.typeql, -data.typeql)
  // rather than a single file, so also check for those variants
  const hasPair = hasSchemaDataPair(filePath)

  if (!existsSync(filePath) && !hasPair) {
    throw new Error(`Backup file not found: ${filePath}`)
  }

  // If schema/data pair exists, it's a TypeQL backup
  if (hasPair) {
    return {
      format: 'typeql',
      description: 'TypeDB TypeQL backup (schema + data pair)',
      restoreCommand:
        'Import TypeQL via typedb console (spindb restore handles this)',
    }
  }

  const stats = statSync(filePath)

  if (stats.isDirectory()) {
    return {
      format: 'unknown',
      description: 'Directory found - TypeDB restore expects TypeQL files',
      restoreCommand: 'TypeDB requires .typeql files for restore',
    }
  }

  // Check file extension first for .typeql files
  if (filePath.endsWith('.typeql') || filePath.endsWith('.tql')) {
    return {
      format: 'typeql',
      description: 'TypeDB TypeQL backup',
      restoreCommand:
        'Import TypeQL via typedb console (spindb restore handles this)',
    }
  }

  // Content-based detection
  if (await looksLikeTypeQL(filePath)) {
    return {
      format: 'typeql',
      description: 'TypeDB TypeQL backup (detected by content)',
      restoreCommand:
        'Import TypeQL via typedb console (spindb restore handles this)',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use .typeql file with TypeQL statements',
  }
}

// Restore options for TypeDB
export type RestoreOptions = {
  containerName: string
  port: number
  database?: string
  version?: string
}

/**
 * Restore from TypeQL backup using typedb console import
 *
 * TypeDB import expects schema and data files.
 * We check for both `-schema.typeql` and `-data.typeql` variants.
 */
async function restoreTypeQLBackup(
  backupPath: string,
  port: number,
  database: string,
  version?: string,
): Promise<RestoreResult> {
  validateTypeDBIdentifier(database)
  const consolePath = await requireTypeDBConsolePath(version)

  // Derive base name by stripping known extensions (.typeql or .tql)
  const baseName = backupPath.replace(/\.(typeql|tql)$/, '')
  const schemaPath = `${baseName}-schema.typeql`
  const dataPath = `${baseName}-data.typeql`

  const hasSchema = existsSync(schemaPath)
  const hasData = existsSync(dataPath)

  if (hasSchema || hasData) {
    // Import schema and data separately
    // NOTE: Do NOT quote paths here. TypeDB console's --command parser treats
    // double quotes as literal characters, not delimiters. Quoting breaks all imports.
    const paths = [
      ...(hasSchema ? [schemaPath] : []),
      ...(hasData ? [dataPath] : []),
    ]
    const command = `database import ${database} ${paths.join(' ')}`

    return runConsoleCommand(consolePath, port, command)
  }

  // Single file import - treat as schema
  const command = `database import ${database} ${backupPath}`
  return runConsoleCommand(consolePath, port, command)
}

/**
 * Run a TypeDB console command and return the result
 */
async function runConsoleCommand(
  consolePath: string,
  port: number,
  command: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<RestoreResult> {
  return new Promise<RestoreResult>((resolve, reject) => {
    const args = [...getConsoleBaseArgs(port), '--command', command]

    logDebug(`Running: typedb_console_bin ${args.join(' ')}`)

    const proc = spawn(consolePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      reject(
        new Error(
          `typedb console timed out after ${Math.round(timeoutMs / 1000)}s running: ${command}`,
        ),
      )
    }, timeoutMs)

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({
          format: 'typeql',
          stdout: stdout || 'TypeQL statements imported successfully',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `typedb console exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Failed to spawn typedb console: ${error.message}`))
    })
  })
}

/**
 * Restore from backup
 * Supports:
 * - TypeQL: Import via typedb console
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const { port, database = 'default', version } = options

  // TypeDB backup creates schema/data pair files (-schema.typeql, -data.typeql)
  // rather than a single file at backupPath, so check for those too
  if (!existsSync(backupPath) && !hasSchemaDataPair(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  if (format.format === 'typeql') {
    return restoreTypeQLBackup(backupPath, port, database, version)
  }

  throw new Error(
    `Invalid backup format: ${format.format}. Use .typeql file with TypeQL statements.`,
  )
}

/**
 * Parse TypeDB connection string
 * Format: typedb://host[:port][/database]
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid TypeDB connection string: expected a non-empty string',
    )
  }

  let url: URL
  try {
    url = new URL(connectionString)
  } catch (error) {
    throw new Error(
      `Invalid TypeDB connection string: "${connectionString}". ` +
        `Expected format: typedb://host[:port][/database]`,
      { cause: error },
    )
  }

  // Validate protocol
  if (url.protocol !== 'typedb:') {
    throw new Error(
      `Invalid TypeDB connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "typedb://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 1729
  const database = url.pathname.replace(/^\//, '') || 'default'

  return {
    host,
    port,
    database,
  }
}
