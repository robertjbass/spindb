/**
 * CouchDB Binary Manager
 *
 * Handles downloading, extracting, and managing CouchDB binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 *
 * Note: CouchDB doesn't support --version flag. It's an Erlang application that
 * tries to start the server when run, so we override verify() to just check
 * binary existence instead of running it.
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

class CouchDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.CouchDB,
    engineName: 'couchdb',
    displayName: 'CouchDB',
    serverBinary: 'couchdb',
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
    // Extract version from output like "couchdb 3.5.1" or "Apache CouchDB 3.5.1"
    const match = stdout.match(/(?:couchdb\s+)?(?:Apache CouchDB\s+)?v?(\d+\.\d+\.\d+)/i)
    return match?.[1] ?? null
  }

  /**
   * Override verify to just check binary existence.
   * CouchDB doesn't support --version flag - it's an Erlang application that
   * tries to start the server when run with any arguments.
   *
   * Note: On Windows, CouchDB uses a .cmd batch file, not .exe
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

    // CouchDB on Windows uses .cmd batch file, not .exe
    const ext = platform === Platform.Win32 ? '.cmd' : ''
    const serverPath = join(binPath, 'bin', `${this.config.serverBinary}${ext}`)

    if (!existsSync(serverPath)) {
      throw new Error(
        `${this.config.displayName} binary not found at ${binPath}/bin/`,
      )
    }

    // Just verify the binary exists - we can't run --version on CouchDB
    return true
  }
}

export const couchdbBinaryManager = new CouchDBBinaryManager()
