/**
 * Weaviate Binary Manager
 *
 * Handles downloading, extracting, and managing Weaviate binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 *
 * Note: Weaviate doesn't support --version flag (as of v1.35.x). We override
 * verify() to just check binary existence instead of running it.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch } from '../../types'
import { paths } from '../../config/paths'

class WeaviateBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.Weaviate,
    engineName: 'weaviate',
    displayName: 'Weaviate',
    serverBinary: 'weaviate',
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
    // Extract version from output like "weaviate v1.35.7" or "1.35.7"
    const match = stdout.match(/(?:weaviate\s+)?v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * Override verify to just check binary existence.
   * Weaviate doesn't support --version flag (as of v1.35.x).
   * See: https://github.com/weaviate/weaviate/issues/6571
   */
  async verify(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })

    const ext = platform === Platform.Win32 ? '.exe' : ''
    const serverPath = join(binPath, 'bin', `${this.config.serverBinary}${ext}`)

    if (!existsSync(serverPath)) {
      throw new Error(
        `${this.config.displayName} binary not found at ${binPath}/bin/`,
      )
    }

    // Just verify the binary exists - we can't run --version on Weaviate
    return true
  }
}

export const weaviateBinaryManager = new WeaviateBinaryManager()
