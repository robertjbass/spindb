/**
 * CockroachDB Binary Manager
 *
 * Handles downloading, extracting, and managing CockroachDB binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class CockroachDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.CockroachDB,
    engineName: 'cockroachdb',
    displayName: 'CockroachDB',
    serverBinary: 'cockroach',
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
    // "Build Tag:        v25.4.2"
    // or "CockroachDB CCL v25.4.2"
    const match = stdout.match(/v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const cockroachdbBinaryManager = new CockroachDBBinaryManager()
