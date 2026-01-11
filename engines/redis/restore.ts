/**
 * Redis restore module
 * Supports two backup formats:
 * - RDB: Binary snapshot (restored by copying to data dir)
 * - Text: Redis commands (.redis file, restored by piping to redis-cli)
 */

import { spawn } from 'child_process'
import { copyFile, readFile } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Get the path to redis-cli binary
 * First checks configManager cache, then falls back to system PATH
 */
async function getRedisCliPath(): Promise<string | null> {
  // Import here to avoid circular dependency
  const { configManager } = await import('../../core/config-manager')

  // Check if we have a cached/bundled redis-cli
  const cachedPath = await configManager.getBinaryPath('redis-cli')
  if (cachedPath) {
    return cachedPath
  }

  // Fallback to system PATH
  const { platformService } = await import('../../core/platform-service')
  return platformService.findToolPath('redis-cli')
}

/**
 * Common Redis commands used to detect text-based backup files
 * These are the commands typically found at the start of a Redis command dump
 */
const REDIS_COMMANDS = [
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
 * Check if file content looks like Redis commands
 * Returns true if the first non-comment, non-empty lines start with valid Redis commands
 */
async function looksLikeRedisCommands(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf-8')
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

      if (REDIS_COMMANDS.includes(firstWord)) {
        commandsFound++
        if (commandsFound >= 2) {
          // Found at least 2 valid Redis commands - likely a Redis dump
          return true
        }
      } else {
        // Found a line that doesn't start with a Redis command
        // Could be binary data or different format
        return false
      }

      if (commandsFound >= linesToCheck) break
    }

    // If we found at least one command and no invalid lines, treat as Redis
    return commandsFound > 0
  } catch {
    return false
  }
}

/**
 * Detect backup format from file
 * Supports:
 * - RDB: Binary format starting with "REDIS"
 * - Text: Redis commands (detected by .redis extension OR content analysis)
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
      description: 'Directory found - Redis uses single file backups',
      restoreCommand: 'Redis requires a single .rdb or .redis file for restore',
    }
  }

  // Check file extension first for .redis text files
  if (filePath.endsWith('.redis')) {
    return {
      format: 'redis',
      description: 'Redis text commands',
      restoreCommand:
        'Pipe commands to redis-cli (spindb restore handles this)',
    }
  }

  // Check file contents for RDB format (binary, starts with "REDIS")
  try {
    const buffer = Buffer.alloc(5)
    const fd = await import('fs').then((fs) => fs.promises.open(filePath, 'r'))
    try {
      await fd.read(buffer, 0, 5, 0)
      const header = buffer.toString('ascii')

      if (header === 'REDIS') {
        return {
          format: 'rdb',
          description: 'Redis RDB snapshot',
          restoreCommand:
            'Copy to data directory and restart Redis (spindb restore handles this)',
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
      description: 'Redis RDB snapshot (detected by extension)',
      restoreCommand:
        'Copy to data directory and restart Redis (spindb restore handles this)',
    }
  }

  // Content-based detection: check if file contains Redis commands
  // This allows files like "users.txt" or "data" to be detected as Redis text dumps
  if (await looksLikeRedisCommands(filePath)) {
    return {
      format: 'redis',
      description: 'Redis text commands (detected by content)',
      restoreCommand:
        'Pipe commands to redis-cli (spindb restore handles this)',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Use .rdb (RDB snapshot) or file with Redis commands',
  }
}

/**
 * Restore options for Redis
 */
export type RestoreOptions = {
  containerName: string
  dataDir?: string
  // Port for running Redis instance (required for text restore)
  port?: number
  // Database number to restore to (default: 0)
  database?: string
  // Clear database before restoring (FLUSHDB)
  flush?: boolean
}

/**
 * Restore from text backup (.redis file)
 * Pipes commands to redis-cli on the running Redis instance
 */
async function restoreTextBackup(
  backupPath: string,
  port: number,
  database: string,
  flush: boolean = false,
): Promise<RestoreResult> {
  const redisCli = await getRedisCliPath()
  if (!redisCli) {
    throw new Error(
      'redis-cli not found. Install Redis:\n' +
        '  macOS: brew install redis\n' +
        '  Ubuntu: sudo apt install redis-tools\n',
    )
  }

  // Read the backup file
  let content = await readFile(backupPath, 'utf-8')

  // Prepend FLUSHDB if requested (clear database before restore)
  if (flush) {
    content = 'FLUSHDB\n' + content
    logDebug('Prepending FLUSHDB to clear database before restore')
  }

  // Pipe to redis-cli
  return new Promise<RestoreResult>((resolve, reject) => {
    const args = ['-h', '127.0.0.1', '-p', String(port), '-n', database]
    const proc = spawn(redisCli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({
          format: 'redis',
          stdout: stdout || 'Redis commands executed successfully',
          stderr: stderr || undefined,
          code: 0,
        })
      } else {
        reject(
          new Error(
            `redis-cli exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })

    proc.on('error', (error) => {
      reject(new Error(`Failed to spawn redis-cli: ${error.message}`))
    })

    // Write backup content to stdin
    proc.stdin.write(content)
    proc.stdin.end()
  })
}

/**
 * Restore from RDB backup
 *
 * IMPORTANT: Redis must be stopped before RDB restore.
 * The RDB file is copied to the data directory, then Redis should be restarted.
 */
async function restoreRdbBackup(
  backupPath: string,
  containerName: string,
  dataDir?: string,
): Promise<RestoreResult> {
  const targetDir =
    dataDir || paths.getContainerDataPath(containerName, { engine: 'redis' })
  const targetPath = join(targetDir, 'dump.rdb')

  logDebug(`Restoring RDB to: ${targetPath}`)

  // Copy backup to data directory
  await copyFile(backupPath, targetPath)

  return {
    format: 'rdb',
    stdout: `Restored RDB to ${targetPath}. Restart Redis to load the data.`,
    code: 0,
  }
}

/**
 * Restore from backup
 * Supports:
 * - RDB: Copy to data directory (requires Redis to be stopped)
 * - Text: Pipe commands to redis-cli (requires Redis to be running)
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

  if (format.format === 'redis') {
    // Text format - pipe to redis-cli (Redis must be running)
    if (!port) {
      throw new Error(
        'Port is required for restoring .redis text files. Redis must be running.',
      )
    }
    return restoreTextBackup(backupPath, port, database, flush)
  }

  if (format.format === 'rdb') {
    // RDB format - copy to data directory (Redis should be stopped)
    // Note: RDB restore always replaces everything (full snapshot)
    return restoreRdbBackup(backupPath, containerName, dataDir)
  }

  throw new Error(
    `Invalid backup format: ${format.format}. Use .rdb (RDB snapshot) or .redis (text commands).`,
  )
}

/**
 * Parse Redis connection string
 * Format: redis://[user:password@]host[:port][/database]
 *
 * Redis databases are numbered 0-15 (default is 0)
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  password?: string
} {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      'Invalid Redis connection string: expected a non-empty string',
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
      `Invalid Redis connection string: "${sanitized}". ` +
        `Expected format: redis://[password@]host[:port][/database]`,
      { cause: error },
    )
  }

  // Validate protocol
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(
      `Invalid Redis connection string: unsupported protocol "${url.protocol}". ` +
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
    throw new Error(`Invalid Redis database number: ${dbStr}. Must be 0-15.`)
  }

  // Redis uses password only (no username), but URL might have username field
  const password = url.password || url.username || undefined

  return {
    host,
    port,
    database: String(dbNum),
    password,
  }
}
