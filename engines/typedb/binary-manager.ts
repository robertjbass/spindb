/**
 * TypeDB Binary Manager
 *
 * Handles downloading, extracting, and managing TypeDB binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 *
 * TypeDB archives extract to a `typedb/` directory with nested structure:
 *   typedb/
 *   ├── typedb                  (launcher script)
 *   ├── server/
 *   │   ├── typedb_server_bin   (server binary)
 *   │   └── config.yml          (default config)
 *   ├── console/
 *   │   └── typedb_console_bin  (console binary)
 *   └── LICENSE
 *
 * We reorganize this preserving the relative structure the launcher expects:
 *   bin/
 *   ├── typedb                  (launcher)
 *   ├── server/
 *   │   └── typedb_server_bin   (server binary)
 *   ├── console/
 *   │   └── typedb_console_bin  (console binary)
 *   └── config.yml              (moved for reference)
 *   server/
 *   └── config.yml              (default config for reference)
 */

import { existsSync } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { moveEntry } from '../../core/fs-error-utils'
import { logDebug } from '../../core/error-handler'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch } from '../../types'

class TypeDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.TypeDB,
    engineName: 'typedb',
    displayName: 'TypeDB',
    serverBinary: 'typedb',
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
    // TypeDB version output format varies
    // Try matching "X.Y.Z" pattern
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * Override moveExtractedEntries to handle TypeDB's nested directory structure.
   *
   * TypeDB archives extract to: typedb/server/typedb_server_bin, typedb/console/typedb_console_bin
   * We reorganize to: bin/typedb, bin/server/typedb_server_bin, bin/console/typedb_console_bin
   * And preserve server/config.yml for reference.
   */
  protected async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })
    const ext = process.platform === 'win32' ? '.exe' : ''
    const batExt = process.platform === 'win32' ? '.bat' : ''

    // Find the typedb directory (e.g., "typedb" or "typedb-3.8.0")
    const typedbDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'typedb' || e.name.startsWith('typedb-')),
    )

    const sourceDir = typedbDir ? join(extractDir, typedbDir.name) : extractDir

    // Create bin/ directory
    const destBinDir = join(binPath, 'bin')
    await mkdir(destBinDir, { recursive: true })

    // Move launcher script to bin/
    const launcherName = `typedb${batExt}`
    const launcherPath = join(sourceDir, launcherName)
    if (existsSync(launcherPath)) {
      await moveEntry(launcherPath, join(destBinDir, launcherName))
    }

    // Move server/ directory into bin/ (preserves bin/server/typedb_server_bin path the launcher expects)
    const destServerDir = join(destBinDir, 'server')
    await mkdir(destServerDir, { recursive: true })
    const serverBinName = `typedb_server_bin${ext}`
    const serverBinPath = join(sourceDir, 'server', serverBinName)
    if (existsSync(serverBinPath)) {
      await moveEntry(serverBinPath, join(destServerDir, serverBinName))
    }

    // Move console/ directory into bin/ (preserves bin/console/typedb_console_bin path the launcher expects)
    const destConsoleDir = join(destBinDir, 'console')
    await mkdir(destConsoleDir, { recursive: true })
    const consoleBinName = `typedb_console_bin${ext}`
    const consoleBinPath = join(sourceDir, 'console', consoleBinName)
    if (existsSync(consoleBinPath)) {
      await moveEntry(consoleBinPath, join(destConsoleDir, consoleBinName))
    }

    // Preserve server/config.yml as reference config
    const configPath = join(sourceDir, 'server', 'config.yml')
    if (existsSync(configPath)) {
      const destRefServerDir = join(binPath, 'server')
      await mkdir(destRefServerDir, { recursive: true })
      await moveEntry(configPath, join(destRefServerDir, 'config.yml'))
    }

    // Move LICENSE if present
    const licensePath = join(sourceDir, 'LICENSE')
    if (existsSync(licensePath)) {
      await moveEntry(licensePath, join(binPath, 'LICENSE'))
    }

    logDebug('TypeDB binaries reorganized to standard bin/ layout')
  }

  /**
   * Override verify to handle TypeDB's launcher script.
   * TypeDB's main binary is a launcher script, not a direct executable.
   * We verify the actual server binary exists instead of running --version.
   */
  async verify(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = (await import('../../config/paths')).paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })

    const ext = platform === Platform.Win32 ? '.exe' : ''
    const serverPath = join(binPath, 'bin', 'server', `typedb_server_bin${ext}`)
    const consolePath = join(
      binPath,
      'bin',
      'console',
      `typedb_console_bin${ext}`,
    )

    if (!existsSync(serverPath)) {
      throw new Error(`TypeDB server binary not found at ${serverPath}`)
    }

    if (!existsSync(consolePath)) {
      throw new Error(`TypeDB console binary not found at ${consolePath}`)
    }

    return true
  }
}

export const typedbBinaryManager = new TypeDBBinaryManager()
