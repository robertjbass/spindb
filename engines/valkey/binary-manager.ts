/**
 * Valkey Binary Manager
 *
 * Handles downloading, extracting, and managing Valkey binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

export class ValkeyBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.Valkey,
    engineName: 'valkey',
    displayName: 'Valkey',
    serverBinary: 'valkey-server',
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
    // Extract version from output like "Valkey server v=8.0.6 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=..."
    // or "v=8.0.6" pattern
    const match = stdout.match(/v=(\d+\.\d+\.\d+)/)
    const altMatch = !match ? stdout.match(/(\d+\.\d+\.\d+)/) : null
    return match?.[1] ?? altMatch?.[1] ?? null
  }
}

export const valkeyBinaryManager = new ValkeyBinaryManager()
