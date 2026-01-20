/**
 * Redis Binary Manager
 *
 * Handles downloading, extracting, and managing Redis binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class RedisBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.Redis,
    engineName: 'redis',
    displayName: 'Redis',
    serverBinary: 'redis-server',
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
    // Extract version from output like "Redis server v=7.4.7 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=..."
    const match = stdout.match(/v=(\d+\.\d+\.\d+)/)
    const altMatch = !match ? stdout.match(/(\d+\.\d+\.\d+)/) : null
    return match?.[1] ?? altMatch?.[1] ?? null
  }
}

export const redisBinaryManager = new RedisBinaryManager()
