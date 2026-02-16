/**
 * Shared Weaviate CLI utilities
 *
 * Provides common functions for locating Weaviate binaries,
 * used by both backup.ts and restore.ts to avoid duplication.
 */

import { existsSync } from 'fs'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'

/**
 * Get the path to weaviate binary
 *
 * Lookup order:
 * 1. configManager cache (bundled/downloaded binaries from hostdb)
 * 2. System PATH (fallback for system-installed weaviate)
 *
 * @returns Path to weaviate or null if not found
 */
export async function getWeaviatePath(): Promise<string | null> {
  // Check if we have a cached/bundled weaviate from hostdb
  const cachedPath = await configManager.getBinaryPath('weaviate')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // Fallback to system PATH
  return platformService.findToolPath('weaviate')
}

/**
 * Error message for missing weaviate binary
 * Directs users to download via hostdb (preferred) or system package manager (fallback)
 */
export const WEAVIATE_NOT_FOUND_ERROR =
  'weaviate not found. Download Weaviate binaries:\n' +
  '  spindb engines download weaviate\n' +
  '\n' +
  'Or run via Docker:\n' +
  '  docker run -p 8080:8080 semitechnologies/weaviate\n' +
  '\n' +
  'See: https://weaviate.io/developers/weaviate/installation'
