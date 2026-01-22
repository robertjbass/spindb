/**
 * Meilisearch Binary Manager
 *
 * Handles downloading, extracting, and managing Meilisearch binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class MeilisearchBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.Meilisearch,
    engineName: 'meilisearch',
    displayName: 'Meilisearch',
    serverBinary: 'meilisearch',
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
    // Extract version from output like "meilisearch 1.33.1" or "v1.33.1"
    const match = stdout.match(/(?:meilisearch\s+)?v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const meilisearchBinaryManager = new MeilisearchBinaryManager()
