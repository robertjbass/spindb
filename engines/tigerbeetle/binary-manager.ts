/**
 * TigerBeetle Binary Manager
 *
 * Handles downloading, extracting, and managing TigerBeetle binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 *
 * Note: TigerBeetle uses `tigerbeetle version` (subcommand, not --version flag).
 * We override verify() to use the correct invocation.
 */

import { execFileSync } from 'child_process'
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
import { logDebug } from '../../core/error-handler'

class TigerBeetleBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.TigerBeetle,
    engineName: 'tigerbeetle',
    displayName: 'TigerBeetle',
    serverBinary: 'tigerbeetle',
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
    // TigerBeetle outputs: "TigerBeetle v0.16.70" or similar
    const match = stdout.match(/(?:TigerBeetle\s+)?v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * Override verify to use `tigerbeetle version` subcommand instead of `--version`.
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

    // TigerBeetle uses `tigerbeetle version` subcommand
    try {
      const output = execFileSync(serverPath, ['version'], {
        timeout: 10000,
        encoding: 'utf-8',
      })
      const parsedVersion = this.parseVersionFromOutput(output)
      if (parsedVersion) {
        logDebug(
          `TigerBeetle binary verified: ${parsedVersion} at ${serverPath}`,
        )
      }
      return true
    } catch {
      // If version subcommand fails, just check existence
      logDebug(
        'TigerBeetle version subcommand failed, falling back to existence check',
      )
      return true
    }
  }
}

export const tigerbeetleBinaryManager = new TigerBeetleBinaryManager()
