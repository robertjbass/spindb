/**
 * Shared Redis CLI utilities
 *
 * Provides common functions for locating Redis binaries,
 * used by both backup.ts and restore.ts to avoid duplication.
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'

/**
 * Get the path to redis-cli binary
 *
 * Lookup order:
 * 1. configManager cache (bundled/downloaded binaries from hostdb)
 * 2. System PATH (fallback for system-installed redis-tools)
 *
 * @returns Path to redis-cli or null if not found
 */
export async function getRedisCliPath(): Promise<string | null> {
  // Check if we have a cached/bundled redis-cli from hostdb
  const cachedPath = await configManager.getBinaryPath('redis-cli')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // Fallback to system PATH
  return platformService.findToolPath('redis-cli')
}

/**
 * Error message for missing redis-cli
 * Directs users to download via hostdb (preferred) or system package manager (fallback)
 */
export const REDIS_CLI_NOT_FOUND_ERROR =
  'redis-cli not found. Download Redis binaries:\n' +
  '  spindb engines download redis\n' +
  '\n' +
  'Or install system-wide:\n' +
  '  macOS: brew install redis\n' +
  '  Ubuntu: sudo apt install redis-tools'
