/**
 * QuestDB Binary Manager
 *
 * Handles downloading, extracting, and managing QuestDB binaries from hostdb.
 * QuestDB is a Java-based database with bundled JRE.
 *
 * Archive structure:
 * questdb/
 * ├── questdb.sh         # Startup script (Unix)
 * ├── questdb.exe        # Startup script (Windows)
 * ├── questdb.jar        # Main application
 * ├── lib/               # Dependencies
 * └── jre/               # Bundled JRE
 */

import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch, type ProgressCallback } from '../../types'
import { existsSync } from 'fs'
import { join, dirname, relative } from 'path'
import { chmod, symlink, readdir } from 'fs/promises'
import { logDebug } from '../../core/error-handler'
import { moveEntry } from '../../core/fs-error-utils'
import { paths } from '../../config/paths'

const RELEASES_URL =
  'https://raw.githubusercontent.com/robertjbass/hostdb/main/releases.json'

class QuestDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.QuestDB,
    engineName: 'questdb',
    displayName: 'QuestDB',
    serverBinary: 'questdb.sh', // Unix startup script
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

  /**
   * Parse version from QuestDB output
   * QuestDB version can be obtained from the questdb.sh/exe script
   */
  protected parseVersionFromOutput(stdout: string): string | null {
    // QuestDB outputs version like "QuestDB 9.2.3"
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * Override isInstalled to check for questdb.sh (Unix) or questdb.exe (Windows)
   * QuestDB doesn't follow the standard bin/ directory structure
   */
  override async isInstalled(
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

    // Check for the startup script at the root of the extracted directory
    if (platform === Platform.Win32) {
      const exePath = join(binPath, 'questdb.exe')
      return existsSync(exePath)
    } else {
      const shPath = join(binPath, 'questdb.sh')
      return existsSync(shPath)
    }
  }

  /**
   * Override moveExtractedEntries to preserve QuestDB's unique directory structure.
   * QuestDB has questdb.sh/exe at root level (not in bin/) alongside lib/ and jre/.
   * The base class would try to move questdb.sh to bin/, which breaks our structure.
   */
  protected override async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })
    // Use console.log for CI visibility (logDebug requires --debug flag)
    console.log(`[QuestDB] Extraction: found ${entries.length} entries: ${entries.map(e => e.name).join(', ')}`)

    // Find the questdb directory - could be:
    // - "questdb" (simple name)
    // - "questdb-9.2.3" (versioned)
    // - "questdb-9.2.3-linux-x64" (full archive name)
    const questdbDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'questdb' || e.name.startsWith('questdb-')),
    )

    let sourceDir = extractDir
    let sourceEntries = entries

    if (questdbDir) {
      console.log(`[QuestDB] Found questdb directory: ${questdbDir.name}`)
      sourceDir = join(extractDir, questdbDir.name)
      sourceEntries = await readdir(sourceDir, { withFileTypes: true })
      console.log(`[QuestDB] Contents: ${sourceEntries.map(e => e.name).join(', ')}`)
    } else {
      // Check if questdb.sh is directly in extractDir (no subdirectory)
      const hasQuestdbSh = entries.some(e => e.name === 'questdb.sh' || e.name === 'questdb.exe')
      if (hasQuestdbSh) {
        console.log(`[QuestDB] questdb.sh found directly in extractDir`)
      } else {
        console.log(`[QuestDB] WARNING: no questdb directory found`)
      }
    }

    // Move all entries as-is, preserving QuestDB's structure:
    console.log(`[QuestDB] Moving ${sourceEntries.length} entries to ${binPath}`)
    for (const entry of sourceEntries) {
      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(binPath, entry.name)
      await moveEntry(sourcePath, destPath)
    }

    // Verify questdb.sh was moved
    const expectedScript = join(binPath, 'questdb.sh')
    if (existsSync(expectedScript)) {
      console.log(`[QuestDB] SUCCESS: questdb.sh found at ${expectedScript}`)
    } else {
      const binContents = await readdir(binPath).catch(() => ['(failed to read)'])
      console.log(`[QuestDB] ERROR: questdb.sh NOT found. binPath contents: ${binContents.join(', ')}`)
    }
  }

  /**
   * After extraction, ensure the startup script is executable and java symlink exists
   * QuestDB's questdb.sh expects 'java' at the base level, but it's in jre/bin/java
   */
  async postExtract(binPath: string, platform: Platform): Promise<void> {
    if (platform !== Platform.Win32) {
      const shPath = join(binPath, 'questdb.sh')
      if (existsSync(shPath)) {
        await chmod(shPath, 0o755)
        logDebug(`Made questdb.sh executable: ${shPath}`)
      }

      // Create symlink from 'java' to 'jre/bin/java' at base level
      // questdb.sh checks for $BASE/java to determine if JRE is bundled
      // Use relative path so symlink works if binPath is moved
      const javaSymlink = join(binPath, 'java')
      const javaTarget = join(binPath, 'jre', 'bin', 'java')
      if (existsSync(javaTarget) && !existsSync(javaSymlink)) {
        try {
          const relativeTarget = relative(dirname(javaSymlink), javaTarget)
          await symlink(relativeTarget, javaSymlink)
          logDebug(`Created java symlink: ${javaSymlink} -> ${relativeTarget}`)
        } catch (error) {
          logDebug(`Failed to create java symlink: ${error}`)
        }
      }
    }
  }

  /**
   * Override verify to check the correct path structure for QuestDB
   * QuestDB has questdb.sh at root, not in bin/ subdirectory
   * Also, QuestDB doesn't support --version flag (Java app)
   */
  override async verify(
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

    // QuestDB has questdb.sh/questdb.exe at root, not in bin/ subdirectory
    const scriptName = platform === Platform.Win32 ? 'questdb.exe' : 'questdb.sh'
    const scriptPath = join(binPath, scriptName)

    if (!existsSync(scriptPath)) {
      throw new Error(
        `${this.config.displayName} binary not found at ${scriptPath}`,
      )
    }

    // QuestDB is a Java application - the startup script is the primary verification
    // The jar may be in different locations depending on version, so we only warn
    const jarPath = join(binPath, 'questdb.jar')
    if (!existsSync(jarPath)) {
      logDebug(`QuestDB jar not found at ${jarPath} (startup script found, proceeding)`)
    }

    logDebug(`QuestDB binaries verified at ${binPath}`)
    return true
  }

  /**
   * Check if QuestDB binaries are available in hostdb before attempting download
   */
  private async checkHostdbAvailability(): Promise<boolean> {
    try {
      // Use 10-second timeout to avoid hanging on slow/unresponsive networks
      const response = await fetch(RELEASES_URL, {
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return false

      const releases = (await response.json()) as {
        databases?: Record<string, unknown>
      }
      // releases.json has structure: { databases: { questdb: {...}, ... } }
      return Boolean(releases.databases?.questdb)
    } catch {
      // Network error or timeout - let the download attempt proceed and fail with its own error
      return true
    }
  }

  /**
   * Override download to check hostdb availability first, then call postExtract
   */
  override async download(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    // Check if QuestDB is available in hostdb
    const isAvailable = await this.checkHostdbAvailability()
    if (!isAvailable) {
      throw new Error(
        `QuestDB binaries are not yet available in hostdb.\n\n` +
          `QuestDB support has been added to SpinDB, but the binaries need to be ` +
          `uploaded to hostdb first.\n\n` +
          `To use QuestDB now, you can:\n` +
          `  1. Wait for the next hostdb release with QuestDB binaries\n` +
          `  2. Download QuestDB manually from https://questdb.io/get-questdb/\n\n` +
          `Check https://github.com/robertjbass/hostdb/releases for updates.`,
      )
    }

    const binPath = await super.download(version, platform, arch, onProgress)

    // Run post-extraction setup (chmod, java symlink)
    await this.postExtract(binPath, platform)

    return binPath
  }
}

export const questdbBinaryManager = new QuestDBBinaryManager()
