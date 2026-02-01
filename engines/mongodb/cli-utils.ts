/**
 * Shared MongoDB CLI utilities
 *
 * Provides common functions for locating MongoDB binaries,
 * used by backup.ts, restore.ts, and index.ts to avoid duplication.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { paths } from '../../config/paths'
import { normalizeVersion } from './version-maps'

/**
 * Get the path to mongodump binary for a specific MongoDB version.
 *
 * Prioritizes SpinDB-managed binaries that match the container's version,
 * falling back to system mongodump only if no matching version is found.
 *
 * Lookup order:
 * 1. SpinDB-managed mongodump matching exact container version
 * 2. SpinDB-managed mongodump matching major version
 * 3. configManager cache (bundled/downloaded binaries from hostdb)
 * 4. System PATH (fallback for system-installed mongodb-database-tools)
 *
 * @param containerVersion - Optional container's MongoDB version for version-matched lookup
 * @returns Path to mongodump or null if not found
 */
export async function getMongodumpPath(
  containerVersion?: string,
): Promise<string | null> {
  // Try version-matched SpinDB binary if containerVersion is provided
  if (containerVersion) {
    const fullVersion = normalizeVersion(containerVersion)
    const platformInfo = platformService.getPlatformInfo()
    const ext = platformInfo.platform === 'win32' ? '.exe' : ''

    // Try exact version match
    const versionedBinPath = paths.getBinaryPath({
      engine: 'mongodb',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedMongodump = join(versionedBinPath, 'bin', `mongodump${ext}`)
    if (existsSync(versionedMongodump)) {
      return versionedMongodump
    }

    // Try major version match
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'mongodb',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedMongodump = join(installed.path, 'bin', `mongodump${ext}`)
      if (existsSync(installedMongodump)) {
        return installedMongodump
      }
    }
  }

  // Check if we have a cached/bundled mongodump from hostdb
  const cachedPath = await configManager.getBinaryPath('mongodump')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // Fallback to system PATH
  return platformService.findToolPath('mongodump')
}

/**
 * Get the path to mongorestore binary for a specific MongoDB version.
 *
 * Prioritizes SpinDB-managed binaries that match the container's version,
 * falling back to system mongorestore only if no matching version is found.
 *
 * Lookup order:
 * 1. SpinDB-managed mongorestore matching exact container version
 * 2. SpinDB-managed mongorestore matching major version
 * 3. configManager cache (bundled/downloaded binaries from hostdb)
 * 4. System PATH (fallback for system-installed mongodb-database-tools)
 *
 * @param containerVersion - Optional container's MongoDB version for version-matched lookup
 * @returns Path to mongorestore or null if not found
 */
export async function getMongorestorePath(
  containerVersion?: string,
): Promise<string | null> {
  // Try version-matched SpinDB binary if containerVersion is provided
  if (containerVersion) {
    const fullVersion = normalizeVersion(containerVersion)
    const platformInfo = platformService.getPlatformInfo()
    const ext = platformInfo.platform === 'win32' ? '.exe' : ''

    // Try exact version match
    const versionedBinPath = paths.getBinaryPath({
      engine: 'mongodb',
      version: fullVersion,
      platform: platformInfo.platform,
      arch: platformInfo.arch,
    })

    const versionedMongorestore = join(
      versionedBinPath,
      'bin',
      `mongorestore${ext}`,
    )
    if (existsSync(versionedMongorestore)) {
      return versionedMongorestore
    }

    // Try major version match
    const majorVersion = containerVersion.split('.')[0]
    const installed = paths.findInstalledBinaryForMajor(
      'mongodb',
      majorVersion,
      platformInfo.platform,
      platformInfo.arch,
    )

    if (installed) {
      const installedMongorestore = join(
        installed.path,
        'bin',
        `mongorestore${ext}`,
      )
      if (existsSync(installedMongorestore)) {
        return installedMongorestore
      }
    }
  }

  // Check if we have a cached/bundled mongorestore from hostdb
  const cachedPath = await configManager.getBinaryPath('mongorestore')
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath
  }

  // Fallback to system PATH
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
