/**
 * SQLite Binary Manager
 *
 * Handles downloading, extracting, and managing SQLite binaries from hostdb.
 * Unlike other engines, SQLite is an embedded database (not a server).
 * This manager handles the sqlite3 CLI and related tools.
 */

import {
  BaseEmbeddedBinaryManager,
  type EmbeddedBinaryManagerConfig,
} from '../../core/base-embedded-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

export const SQLITE_EXECUTABLES = [
  'sqlite3',
  'sqldiff',
  'sqlite3_analyzer',
  'sqlite3_rsync',
]

class SQLiteBinaryManager extends BaseEmbeddedBinaryManager {
  protected readonly config: EmbeddedBinaryManagerConfig = {
    engine: Engine.SQLite,
    engineName: 'sqlite',
    displayName: 'SQLite',
    primaryBinary: 'sqlite3',
    executableNames: SQLITE_EXECUTABLES,
  }

  protected getBinaryUrlFromModule(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return getBinaryUrl(version, platform, arch)
  }

  protected normalizeVersionFromModule(version: string): string {
    return normalizeVersion(version)
  }

  protected parseVersionFromOutput(stdout: string): string | null {
    // Extract version from output like "3.51.2 2025-01-08 12:00:00 ..."
    const match = stdout.match(/^(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const sqliteBinaryManager = new SQLiteBinaryManager()
