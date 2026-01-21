/**
 * Valkey restore module
 * Supports two backup formats:
 * - RDB: Binary snapshot (restored by copying to data dir)
 * - Text: Valkey commands (.valkey file, restored by piping to valkey-cli)
 */

import { spawn } from 'child_process'
import { copyFile, open } from 'fs/promises'
import { existsSync, statSync, createReadStream } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import { getValkeyCliPath, VALKEY_CLI_NOT_FOUND_ERROR } from './cli-utils'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Common Valkey commands used to detect text-based backup files
 * These are the commands typically found at the start of a Valkey command dump
 */
const VALKEY_COMMANDS = [
  'SET',
  'GET',
  'DEL',
  'MSET',
  'MGET',
  'SETNX',
  'SETEX',
  'PSETEX',
  'APPEND',
  'HSET',
  'HGET',
  'HMSET',
  'HDEL',
  'HGETALL',
  'HSETNX',
  'LPUSH',
  'RPUSH',
  'LPOP',
  'RPOP',
  'LSET',
  'LINSERT',
  'LREM',
  'SADD',
  'SREM',
  'SMEMBERS',
  'SPOP',
  'ZADD',
  'ZREM',
  'ZINCRBY',
  'ZRANGE',
  'EXPIRE',
  'EXPIREAT',
  'PEXPIRE',
  'TTL',
  'PERSIST',
  'FLUSHDB',
  'FLUSHALL',
  'SELECT',
  'PFADD',
  'GEOADD',
  'XADD',
]

/**
 * Check if file content looks like Valkey commands
 * Returns true if the first non-comment, non-empty lines start with valid Valkey commands
 * Only reads first 4KB to avoid loading large files into memory
 */
async function looksLikeValkeyCommands(filePath: string): Promise<boolean> {
  try {
    // Read only first 4KB - enough for several lines of Valkey commands
    const HEADER_SIZE = 4096
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
    // Use /\r?\n/ to handle both Unix (\n) and Windows (\r\n) line endings
    const lines = content.split(/\r?\n/)

    let commandsFound = 0
    const linesToCheck = 10 // Check first 10 non-empty, non-comment lines

    for (const line of lines) {
      const trimmed = line.trim()

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) continue

      // Get the first word (command)
      const firstWord = trimmed.split(/\s+/)[0].toUpperCase()

      if (VALKEY_COMMANDS.includes(firstWord)) {
        commandsFound++
        if (commandsFound >= 2) {
          // Found at least 2 valid Valkey commands - likely a Valkey dump
          return true
        }
      } else {
        // Found a line that doesn't start with a Valkey command
        // Could be binary data or different format
        return false
      }

      if (commandsFound >= linesToCheck) break
    }

    // If we found at least one command and no invalid lines, treat as Valkey
    return commandsFound > 0
  } catch {
    return false
  }
}

/**
 * Detect backup format from file
 * Supports:
 * - RDB: Binary format starting with "REDIS" (Valkey uses same RDB format)
 * - Text: Valkey commands (detected by .valkey extension OR content analysis)
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
      description: 'Directory found - Valkey uses single file backups',
      restoreCommand:
        'Valkey requires a single .rdb or .valkey file for restore',
    }
  }

  // Check file extension first for .valkey text files
  if (filePath.endsWith('.valkey')) {
    return {
      format: 'text',
      description: 'Valkey text commands',
      restoreCommand:
        'Pipe commands to valkey-cli (spindb restore handles this)',
    }
  }

  // Check file contents for RDB format (binary, starts with "REDIS")
  // Note: Valkey uses the same RDB format as Redis for compatibility
  try {
    const buffer = Buffer.alloc(5)
    const fd = await open(filePath, 'r')
    try {
      await fd.read(buffer, 0, 5, 0)
      const header = buffer.toString('ascii')

      if (header === 'REDIS') {
        return {
          format: 'rdb',
          description: 'Valkey RDB snapshot',
          restoreCommand:
            'Copy to data directory and restart Valkey (spindb restore handles this)',
        }
      }
    } finally {
      await fd.close().catch(() => {})
    }
  } catch (error) {
    logDebug(`Error reading backup file header: ${error}`)
  }

  // Check file extension as fallback for RDB
  if (filePath.endsWith('.rdb')) {
    return {
      format: 'rdb',
      description: 'Valkey RDB snapshot (detected by extension)',
      restoreCommand:
        'Copy to data directory and restart Valkey (spindb restore handles this)',
    }
  }

  // Content-based detection: check if file contains Valkey commands
  // This allows files like "users.txt" or "data" to be detected as Valkey text dumps
  if (await looksLikeValkeyCommands(filePath)) {
    return {
      format: 'text',
      description: 'Valkey text commands (detected by content)',
      restoreCommand:
        'Pipe commands to valkey-cli (spindb restore handles this)',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use .rdb (RDB snapshot) or file with Valkey commands',
  }
}

// Restore options for Valkey
export type RestoreOptions = {
  containerName: string
  dataDir?: string
  // Port for running Valkey instance (required for text restore)
  port?: number
  // Database number to restore to (default: 0)
  database?: string
  // Clear database before restoring (FLUSHDB)
  flush?: boolean
}

/**
 * Restore from text backup (.valkey file)
 * Streams commands to valkey-cli on the running Valkey instance
 */
async function restoreTextBackup(
  backupPath: string,
  port: number,
  database: string,
  flush: boolean = false,
): Promise<RestoreResult> {
  const valkeyCli = await getValkeyCliPath()
  if (!valkeyCli) {
    throw new Error(VALKEY_CLI_NOT_FOUND_ERROR)
  }

  return new Promise<RestoreResult>((resolve, reject) => {
    const args = ['-h', '127.0.0.1', '-p', String(port), '-n', database]
    const proc = spawn(valkeyCli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let streamError: Error | null = null

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      // If there was a stream error, report it
      if (streamError) {
        reject(streamError)
        return
      }

      if (code === 0) {
        resolve({
          format: 'text',
          stdout: stdout || 'Valkey commands executed successfully',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `valkey-cli exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`Failed to spawn valkey-cli: ${error.message}`))
    })

    // Prepend FLUSHDB if requested (clear database before restore)
    if (flush) {
      logDebug('Prepending FLUSHDB to clear database before restore')
      proc.stdin.write('FLUSHDB\n')
    }

    // Stream backup file to valkey-cli stdin
    const fileStream = createReadStream(backupPath, { encoding: 'utf-8' })

    fileStream.on('error', (error) => {
      streamError = new Error(`Failed to read backup file: ${error.message}`)
      fileStream.destroy()
      proc.stdin.end()
    })

    proc.stdin.on('error', (error) => {
      // Handle stdin errors (e.g., process closed unexpectedly)
      streamError = new Error(`Failed to write to valkey-cli stdin: ${error.message}`)
      fileStream.destroy()
    })

    fileStream.pipe(proc.stdin)
  })
}

/**
 * Restore from RDB backup
 *
 * IMPORTANT: Valkey must be stopped before RDB restore.
 * The RDB file is copied to the data directory, then Valkey should be restarted.
 */
async function restoreRdbBackup(
  backupPath: string,
  containerName: string,
  dataDir?: string,
): Promise<RestoreResult> {
  const targetDir =
    dataDir || paths.getContainerDataPath(containerName, { engine: 'valkey' })
  const targetPath = join(targetDir, 'dump.rdb')

  logDebug(`Restoring RDB to: ${targetPath}`)

  // Copy backup to data directory
  await copyFile(backupPath, targetPath)

  return {
    format: 'rdb',
    stdout: `Restored RDB to ${targetPath}. Restart Valkey to load the data.`,
    code: 0,
  }
}

/**
 * Restore from backup
 * Supports:
 * - RDB: Copy to data directory (requires Valkey to be stopped)
 * - Text: Pipe commands to valkey-cli (requires Valkey to be running)
 */
export async function restoreBackup(
  backupPath: string,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const {
    containerName,
    dataDir,
    port,
    database = '0',
    flush = false,
  } = options

  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  // Detect backup format
  const format = await detectBackupFormat(backupPath)
  logDebug(`Detected backup format: ${format.format}`)

  if (format.format === 'text') {
    // Text format - pipe to valkey-cli (Valkey must be running)
    if (!port) {
      throw new Error(
        'Port is required for restoring .valkey text files. Valkey must be running.',
      )
    }
    return restoreTextBackup(backupPath, port, database, flush)
  }

  if (format.format === 'rdb') {
    // RDB format - copy to data directory (Valkey should be stopped)
    // Note: RDB restore always replaces everything (full snapshot)
    return restoreRdbBackup(backupPath, containerName, dataDir)
  }

  throw new Error(
    `Invalid backup format: ${format.format}. Use .rdb (RDB snapshot) or .valkey (text commands).`,
  )
}

/**
 * Parse Valkey connection string
 * Format: redis://[user:password@]host[:port][/database]
 * (Uses redis:// scheme for client compatibility)
 *
 * Valkey databases are numbered 0-15 (default is 0)
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid Valkey connection string: expected a non-empty string',
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
      `Invalid Valkey connection string: "${sanitized}". ` +
        `Expected format: redis://[password@]host[:port][/database]`,
      { cause: error },
    )
  }

  // Validate protocol - accept both redis:// and rediss:// for compatibility
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(
      `Invalid Valkey connection string: unsupported protocol "${url.protocol}". ` +
        `Expected "redis://" or "rediss://"`,
    )
  }

  const host = url.hostname || '127.0.0.1'
  const port = parseInt(url.port, 10) || 6379

  // Database is in pathname (e.g., /0, /1, etc.)
  const dbStr = url.pathname.replace(/^\//, '') || '0'
  const dbNum = parseInt(dbStr, 10)

  // Validate database number (0-15)
  if (isNaN(dbNum) || dbNum < 0 || dbNum > 15) {
    throw new Error(`Invalid Valkey database number: ${dbStr}. Must be 0-15.`)
  }

  // Valkey uses password only (no username), but URL might have username field
  const password = url.password || url.username || undefined

  return {
    host,
    port,
    database: String(dbNum),
    password,
  }
}
