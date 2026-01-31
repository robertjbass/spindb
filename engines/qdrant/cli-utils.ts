/**
 * Shared Qdrant CLI utilities
 *
 * Provides common functions for locating Qdrant binaries,
 * used by both backup.ts and restore.ts to avoid duplication.
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'

/**
 * Get the path to qdrant binary
 *
 * Lookup order:
 * 1. configManager cache (bundled/downloaded binaries from hostdb)
 * 2. System PATH (fallback for system-installed qdrant)
 *
 * @returns Path to qdrant or null if not found
 */
export async function getQdrantPath(): Promise<string | null> {
  // Check if we have a cached/bundled qdrant from hostdb
  const cachedPath = await configManager.getBinaryPath('qdrant')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // Fallback to system PATH
  return platformService.findToolPath('qdrant')
}

/**
 * Error message for missing qdrant binary
 * Directs users to download via hostdb (preferred) or system package manager (fallback)
 */
export const QDRANT_NOT_FOUND_ERROR =
  'qdrant not found. Download Qdrant binaries:\n' +
  '  spindb engines download qdrant\n' +
  '\n' +
  'Or run via Docker:\n' +
  '  docker run -p 6333:6333 qdrant/qdrant\n' +
  '\n' +
  'See: https://qdrant.tech/documentation/guides/installation/'
