/**
 * Shared Valkey CLI utilities
 *
 * Provides common functions for locating Valkey binaries,
 * used by both backup.ts and restore.ts to avoid duplication.
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'

/**
 * Get the path to valkey-cli binary
 *
 * Lookup order:
 * 1. configManager cache (bundled/downloaded binaries from hostdb)
 * 2. System PATH (fallback for system-installed valkey-tools)
 *
 * @returns Path to valkey-cli or null if not found
 */
export async function getValkeyCliPath(): Promise<string | null> {
  // Check if we have a cached/bundled valkey-cli from hostdb
  const cachedPath = await configManager.getBinaryPath('valkey-cli')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // Fallback to system PATH
  return platformService.findToolPath('valkey-cli')
}

/**
 * Error message for missing valkey-cli
 * Directs users to download via hostdb (preferred) or system package manager (fallback)
 */
export const VALKEY_CLI_NOT_FOUND_ERROR =
  'valkey-cli not found. Download Valkey binaries:\n' +
  '  spindb engines download valkey\n' +
  '\n' +
  'Or install system-wide:\n' +
  '  macOS: brew install valkey\n' +
  '  Ubuntu: sudo apt install valkey-tools'
