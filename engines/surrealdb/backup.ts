/**
 * SurrealDB backup module
 * Supports SurrealQL-based backups using surreal export
 *
 * SurrealDB backup formats:
 * - SurrealQL: Schema + data as SurrealQL statements (portable, human-readable)
 */

import { spawn } from 'child_process'
import { readFile, rename, rm, stat, mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import { logDebug } from '../../core/error-handler'
import { getDefaultUsername, loadCredentials } from '../../core/credential-manager'
import {
  addSurrealAuthArgs,
  getBootstrapSurrealAuth,
  inferSurrealAuthLevel,
  sanitizeSurrealAuthArgs,
} from './auth'
import { requireSurrealPath } from './cli-utils'
import { Engine, type ContainerConfig, type BackupOptions, type BackupResult } from '../../types'

function shouldStripSurrealStatement(statement: string): boolean {
  const normalized = statement.trim().replace(/\s+/g, ' ').toUpperCase()
  return (
    normalized.startsWith('DEFINE USER ') ||
    normalized.startsWith('DEFINE ACCESS ') ||
    normalized === 'OPTION IMPORT;' ||
    normalized.startsWith('USE NS ') ||
    normalized.startsWith('USE DB ')
  )
}

export function sanitizeBackupContent(content: string): string {
  let result = ''
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false

  for (const char of content) {
    current += char

    if (escaped) {
      escaped = false
      continue
    }

    if (quote) {
      if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    if (char === ';') {
      result += shouldStripSurrealStatement(current) ? '\n' : current
      current = ''
    }
  }

  if (current.length > 0) {
    result += shouldStripSurrealStatement(current) ? '\n' : current
  }

  return result
}

/**
 * Create a SurrealQL backup using surreal export
 */
async function createSurqlBackup(
  container: ContainerConfig,
  outputPath: string,
  database: string,
): Promise<BackupResult> {
  const { name, port, version } = container
  // SurrealDB uses namespace/database hierarchy - use container name as namespace
  const namespace = container.name.replace(/-/g, '_')
  const savedCreds = await loadCredentials(
    name,
    Engine.SurrealDB,
    getDefaultUsername(Engine.SurrealDB),
  )
  const auth = savedCreds
    ? {
        username: savedCreds.username,
        password: savedCreds.password,
        authLevel: inferSurrealAuthLevel({
          username: savedCreds.username,
          database: savedCreds.database,
          connectionString: savedCreds.connectionString,
        }),
      }
    : getBootstrapSurrealAuth()

  const surrealPath = await requireSurrealPath(version)

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  return new Promise<BackupResult>((resolve, reject) => {
    // surreal export command
    const args = addSurrealAuthArgs(
      [
        'export',
        '--endpoint',
        `http://127.0.0.1:${port}`,
        '--ns',
        namespace,
        '--db',
        database,
        outputPath,
      ],
      auth,
    )

    logDebug(`Running: surreal ${sanitizeSurrealAuthArgs(args).join(' ')}`)

    const proc = spawn(surrealPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let _stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      _stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', reject)

    proc.on('close', async (code) => {
      if (code === 0) {
        try {
          const sanitized = sanitizeBackupContent(
            await readFile(outputPath, 'utf-8'),
          )
          const tempPath = `${outputPath}.tmp`
          try {
            await writeFile(tempPath, sanitized, 'utf-8')
            await rename(tempPath, outputPath)
          } catch (error) {
            await rm(tempPath, { force: true }).catch(() => {})
            throw error
          }
          const stats = await stat(outputPath)
          resolve({
            path: outputPath,
            format: 'surql',
            size: stats.size,
          })
        } catch (error) {
          reject(new Error(`Backup file not created: ${error}`))
        }
      } else if (code === null) {
        reject(
          new Error(
            `surreal export was terminated by signal${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      } else {
        reject(
          new Error(
            `surreal export exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        )
      }
    })
  })
}

/**
 * Create a backup
 *
 * @param container - Container configuration
 * @param outputPath - Path to write backup file
 * @param options - Backup options
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const database = options.database || container.database || 'default'

  return createSurqlBackup(container, outputPath, database)
}

/**
 * Create a backup for cloning purposes
 * Uses SurrealQL format for reliability
 */
export async function createCloneBackup(
  container: ContainerConfig,
  outputPath: string,
): Promise<BackupResult> {
  return createSurqlBackup(
    container,
    outputPath,
    container.database || 'default',
  )
}
