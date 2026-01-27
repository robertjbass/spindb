/**
 * SurrealDB Binary Manager
 *
 * Handles downloading, extracting, and managing SurrealDB binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class SurrealDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.SurrealDB,
    engineName: 'surrealdb',
    displayName: 'SurrealDB',
    serverBinary: 'surreal',
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
    // Extract version from output like:
    // "surreal 2.3.2 for linux on x86_64"
    // or just "2.3.2"
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const surrealdbBinaryManager = new SurrealDBBinaryManager()
