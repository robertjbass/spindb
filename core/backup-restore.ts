/**
 * Core backup and restore functionality
 *
 * This module provides shared backup/restore logic used by:
 * - CLI commands (backup.ts, restore.ts)
 * - Interactive menu handlers (backup-handlers.ts)
 *
 * By centralizing this logic, we avoid duplication and ensure consistency.
 */

import chalk from 'chalk'
import { existsSync, statSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { containerManager } from './container-manager'
import { getMissingDependencies } from './dependency-manager'
import { platformService } from './platform-service'
import { getEngine } from '../engines'
import { createSpinner } from '../cli/ui/spinner'
import { uiSuccess, uiError, formatBytes } from '../cli/ui/theme'
import {
  getBackupExtension,
  getBackupSpinnerLabel,
  LARGE_BACKUP_THRESHOLD,
  VERY_LARGE_BACKUP_THRESHOLD,
} from '../config/backup-formats'
import type { ContainerConfig } from '../types'

/**
 * Generate a timestamp string for backup filenames
 */
export function generateBackupTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/:/g, '').split('.')[0]
}

/**
 * Generate a default backup filename
 */
export function generateBackupFilename(
  containerName: string,
  databaseName: string,
): string {
  const timestamp = generateBackupTimestamp()
  return `${containerName}-${databaseName}-backup-${timestamp}`
}

/**
 * Check if required tools are installed for an engine
 * @returns Array of missing dependencies, or empty if all available
 */
export async function checkBackupDependencies(
  engine: string,
): Promise<{ name: string; binary: string }[]> {
  return getMissingDependencies(engine)
}

/**
 * Get the estimated size of a database for backup
 */
export async function estimateBackupSize(
  config: ContainerConfig,
): Promise<number | null> {
  try {
    const engine = getEngine(config.engine)
    return await engine.getDatabaseSize(config)
  } catch {
    return null
  }
}

/**
 * Options for performing a backup
 */
export type BackupOptions = {
  containerName: string
  databaseName: string
  format: 'sql' | 'dump'
  outputDir: string
  filename: string
  // Show spinner and console output
  interactive?: boolean
  // Callback for progress updates
  onProgress?: (message: string) => void
}

/**
 * Result of a backup operation
 */
export type BackupResult = {
  success: boolean
  path?: string
  size?: number
  format?: string
  error?: string
}

/**
 * Perform a backup operation
 */
export async function performBackup(options: BackupOptions): Promise<BackupResult> {
  const {
    containerName,
    databaseName,
    format,
    outputDir,
    filename,
    interactive = true,
    onProgress,
  } = options

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    return { success: false, error: `Container "${containerName}" not found` }
  }

  const engine = getEngine(config.engine)
  const extension = getBackupExtension(config.engine, format)
  const outputPath = join(outputDir, `${filename}${extension}`)

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  const spinnerLabel = getBackupSpinnerLabel(config.engine, format)
  const spinner = interactive
    ? createSpinner(`Creating ${spinnerLabel} backup of "${databaseName}"...`)
    : null

  spinner?.start()
  onProgress?.(`Creating ${spinnerLabel} backup...`)

  try {
    const result = await engine.backup(config, outputPath, {
      database: databaseName,
      format,
    })

    spinner?.succeed('Backup created successfully')

    if (interactive) {
      console.log()
      console.log(uiSuccess('Backup complete'))
      console.log()
      console.log(chalk.gray('  Saved to:'), chalk.cyan(result.path))
      console.log(chalk.gray('  Size:'), chalk.white(formatBytes(result.size)))
      console.log(chalk.gray('  Format:'), chalk.white(result.format))
      console.log()
    }

    return {
      success: true,
      path: result.path,
      size: result.size,
      format: result.format,
    }
  } catch (error) {
    const e = error as Error
    spinner?.fail('Backup failed')

    if (interactive) {
      console.log()
      console.log(uiError(e.message))
      console.log()
    }

    return { success: false, error: e.message }
  }
}

/**
 * Options for performing a restore
 */
export type RestoreOptions = {
  containerName: string
  databaseName: string
  backupPath: string
  // Create new database if it doesn't exist
  createDatabase?: boolean
  // Force overwrite existing database
  force?: boolean
  // Show spinner and console output
  interactive?: boolean
  // Callback for progress updates
  onProgress?: (message: string) => void
}

/**
 * Result of a restore operation
 */
export type RestoreResult = {
  success: boolean
  databaseName?: string
  connectionString?: string
  warnings?: string[]
  error?: string
}

/**
 * Check backup file size and return warning level
 */
export function checkBackupSize(backupPath: string): {
  size: number
  level: 'normal' | 'large' | 'very_large'
} {
  try {
    const stats = statSync(backupPath)
    const size = stats.size

    if (size >= VERY_LARGE_BACKUP_THRESHOLD) {
      return { size, level: 'very_large' }
    }
    if (size >= LARGE_BACKUP_THRESHOLD) {
      return { size, level: 'large' }
    }
    return { size, level: 'normal' }
  } catch {
    return { size: 0, level: 'normal' }
  }
}

/**
 * Perform a restore operation
 */
export async function performRestore(options: RestoreOptions): Promise<RestoreResult> {
  const {
    containerName,
    databaseName,
    backupPath,
    createDatabase = true,
    interactive = true,
    onProgress,
  } = options

  const config = await containerManager.getConfig(containerName)
  if (!config) {
    return { success: false, error: `Container "${containerName}" not found` }
  }

  const engine = getEngine(config.engine)

  // Create database if needed
  if (createDatabase) {
    const existingDbs = config.databases || [config.database]
    if (!existingDbs.includes(databaseName)) {
      const spinner = interactive
        ? createSpinner(`Creating database "${databaseName}"...`)
        : null
      spinner?.start()
      onProgress?.(`Creating database "${databaseName}"...`)

      try {
        await engine.createDatabase(config, databaseName)
        spinner?.succeed(`Database "${databaseName}" created`)

        // Update container config
        await containerManager.updateConfig(containerName, {
          databases: [...existingDbs, databaseName],
        })
      } catch (error) {
        const e = error as Error
        spinner?.fail('Failed to create database')
        return { success: false, error: e.message }
      }
    }
  }

  // Perform restore
  const spinner = interactive
    ? createSpinner(`Restoring to "${databaseName}"...`)
    : null
  spinner?.start()
  onProgress?.(`Restoring to "${databaseName}"...`)

  try {
    const result = await engine.restore(config, backupPath, {
      database: databaseName,
    })

    const warnings: string[] = []

    if (result.code === 0) {
      spinner?.succeed('Restore completed successfully')
    } else {
      spinner?.warn('Restore completed with warnings')
      if (result.stderr) {
        const lines = result.stderr.split('\n').filter((l) => l.trim())
        warnings.push(...lines.slice(0, 10))
      }
    }

    const connectionString = engine.getConnectionString(config, databaseName)

    if (interactive) {
      console.log()
      console.log(uiSuccess(`Database "${databaseName}" restored`))
      console.log(chalk.gray('  Connection string:'))
      console.log(chalk.cyan(`  ${connectionString}`))

      const copied = await platformService.copyToClipboard(connectionString)
      if (copied) {
        console.log(chalk.gray('  ✓ Connection string copied to clipboard'))
      }
      console.log()

      if (warnings.length > 0) {
        console.log(chalk.yellow('  Warnings:'))
        for (const warning of warnings) {
          console.log(chalk.gray(`  ${warning}`))
        }
        console.log()
      }
    }

    return {
      success: true,
      databaseName,
      connectionString,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  } catch (error) {
    const e = error as Error
    spinner?.fail('Restore failed')

    if (interactive) {
      console.log()
      console.log(uiError(e.message))
      console.log()
    }

    return { success: false, error: e.message }
  }
}

/**
 * Get the default/primary database for a container
 * If there's only one database, returns it; otherwise returns null
 */
export function getDefaultDatabase(config: ContainerConfig): string | null {
  const databases = config.databases || [config.database]
  if (databases.length === 1) {
    return databases[0]
  }
  return null
}
