/**
 * Qdrant Binary Manager
 *
 * Handles downloading, extracting, and managing Qdrant binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class QdrantBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.Qdrant,
    engineName: 'qdrant',
    displayName: 'Qdrant',
    serverBinary: 'qdrant',
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
    // Extract version from output like "qdrant 1.16.3" or "v1.16.3"
    const match = stdout.match(/(?:qdrant\s+)?v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const qdrantBinaryManager = new QdrantBinaryManager()
