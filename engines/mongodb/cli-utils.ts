/**
 * Shared MongoDB CLI utilities
 *
 * Provides common functions for locating MongoDB binaries,
 * used by backup.ts, restore.ts, and index.ts to avoid duplication.
 */

import { existsSync } from 'fs'

/**
 * Get the path to mongodump binary
 *
 * Lookup order:
 * 1. configManager cache (bundled/downloaded binaries from hostdb)
 * 2. System PATH (fallback for system-installed mongodb-database-tools)
 *
 * @returns Path to mongodump or null if not found
 */
export async function getMongodumpPath(): Promise<string | null> {
  // Dynamic imports to avoid circular dependencies
  const { configManager } = await import('../../core/config-manager')

  // Check if we have a cached/bundled mongodump from hostdb
  const cachedPath = await configManager.getBinaryPath('mongodump')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // Fallback to system PATH
  const { platformService } = await import('../../core/platform-service')
  return platformService.findToolPath('mongodump')
}

/**
 * Get the path to mongorestore binary
 *
 * Lookup order:
 * 1. configManager cache (bundled/downloaded binaries from hostdb)
 * 2. System PATH (fallback for system-installed mongodb-database-tools)
 *
 * @returns Path to mongorestore or null if not found
 */
export async function getMongorestorePath(): Promise<string | null> {
  // Dynamic imports to avoid circular dependencies
  const { configManager } = await import('../../core/config-manager')

  // Check if we have a cached/bundled mongorestore from hostdb
  const cachedPath = await configManager.getBinaryPath('mongorestore')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // Fallback to system PATH
  const { platformService } = await import('../../core/platform-service')
  return platformService.findToolPath('mongorestore')
}

/**
 * Error message for missing mongodump
 * Directs users to download via hostdb (preferred) or MongoDB website (fallback)
 */
export const MONGODUMP_NOT_FOUND_ERROR =
  'mongodump not found. Download MongoDB binaries:\n' +
  '  spindb engines download mongodb\n' +
  '\n' +
  'Or download from:\n' +
  '  https://www.mongodb.com/try/download/database-tools'

/**
 * Error message for missing mongorestore
 * Directs users to download via hostdb (preferred) or MongoDB website (fallback)
 */
export const MONGORESTORE_NOT_FOUND_ERROR =
  'mongorestore not found. Download MongoDB binaries:\n' +
  '  spindb engines download mongodb\n' +
  '\n' +
  'Or download from:\n' +
  '  https://www.mongodb.com/try/download/database-tools'
