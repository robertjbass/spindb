/**
 * libSQL Binary Manager
 *
 * Handles downloading, extracting, and managing libSQL (sqld) binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class LibSQLBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.LibSQL,
    engineName: 'libsql',
    displayName: 'libSQL',
    serverBinary: 'sqld',
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
    // Extract version from output like "sqld 0.24.32" or "v0.24.32"
    const match = stdout.match(/(?:sqld\s+)?v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const libsqlBinaryManager = new LibSQLBinaryManager()
