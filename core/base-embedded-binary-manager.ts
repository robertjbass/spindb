/**
 * Base Embedded Binary Manager
 *
 * Provides shared implementation for binary managers that handle embedded databases
 * (SQLite, DuckDB) which download CLI tools from hostdb. Unlike server-based databases,
 * these have no server binary - just CLI tools.
 *
 * Key differences from BaseBinaryManager:
 * - Handles flat archives (executables at root, not in bin/)
 * - Identifies executables by explicit name list
 * - No server binary concept (CLI tools only)
 *
 * To extend this class, implement the abstract methods and properties that define
 * engine-specific behavior (engine name, binary names, version parsing, etc.).
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { paths } from '../config/paths'
import { spawnAsync } from './spawn-utils'
import { moveEntry } from './fs-error-utils'
import { compareVersions } from './version-utils'
import { fetchWithRegistryFallback } from './hostdb-client'
import {
  type Engine,
  Platform,
  type Arch,
  type ProgressCallback,
  type InstalledBinary,
  isValidPlatform,
  isValidArch,
} from '../types'

/**
 * Configuration for an embedded binary manager instance
 */
export type EmbeddedBinaryManagerConfig = {
  /** Engine enum value (e.g., Engine.SQLite) */
  engine: Engine
  /** Engine name string for paths and URLs (e.g., 'sqlite') */
  engineName: string
  /** Display name for user messages (e.g., 'SQLite') */
  displayName: string
  /** Primary binary name without extension (e.g., 'sqlite3') */
  primaryBinary: string
  /** All executable names without extension (e.g., ['sqlite3', 'sqldiff']) */
  executableNames: string[]
}

export abstract class BaseEmbeddedBinaryManager {
  protected abstract readonly config: EmbeddedBinaryManagerConfig

  /**
   * Get the download URL for a version.
   * Must be implemented by subclass to use engine-specific binary-urls module.
   */
  protected abstract getBinaryUrlFromModule(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string

  /**
   * Normalize version string to full version format.
   * Must be implemented by subclass to use engine-specific version-maps module.
   */
  protected abstract normalizeVersionFromModule(version: string): string

  /**
   * Parse version from CLI --version output.
   * Must be implemented by subclass as output format varies by engine.
   */
  protected abstract parseVersionFromOutput(stdout: string): string | null

  /**
   * Get the download URL for a version (public API)
   */
  getDownloadUrl(version: string, platform: Platform, arch: Arch): string {
    const fullVersion = this.getFullVersion(version)
    return this.getBinaryUrlFromModule(fullVersion, platform, arch)
  }

  /**
   * Convert version to full version format (e.g., "3" -> "3.51.2")
   */
  getFullVersion(version: string): string {
    return this.normalizeVersionFromModule(version)
  }

  /**
   * Check if binaries for a specific version are already installed
   */
  async isInstalled(
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
    const primaryPath = join(
      binPath,
      'bin',
      `${this.config.primaryBinary}${ext}`,
    )
    return existsSync(primaryPath)
  }

  /**
   * List all installed versions for this engine
   */
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []
    const prefix = `${this.config.engineName}-`

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith(prefix)) continue

      // Split from end to handle versions with non-digit suffixes
      // Format: {engine}-{version}-{platform}-{arch}
      const rest = entry.name.slice(prefix.length)
      const parts = rest.split('-')
      if (parts.length < 3) continue

      const arch = parts.pop()!
      const platform = parts.pop()!
      const version = parts.join('-')

      if (version && isValidPlatform(platform) && isValidArch(arch)) {
        installed.push({
          engine: this.config.engine,
          version,
          platform,
          arch,
        })
      }
    }

    return installed
  }

  /**
   * Download and extract binaries
   */
  async download(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)
    const url = this.getDownloadUrl(version, platform, arch)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(
      paths.bin,
      `temp-${this.config.engineName}-${fullVersion}-${platform}-${arch}`,
    )
    // Windows uses .zip, Unix uses .tar.gz
    const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'
    const archiveFile = join(tempDir, `${this.config.engineName}.${ext}`)

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
    const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

    try {
      // Download the archive with timeout
      onProgress?.({
        stage: 'downloading',
        message: `Downloading ${this.config.displayName} binaries...`,
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        DOWNLOAD_TIMEOUT_MS,
      )

      let response: Response
      try {
        response = await fetchWithRegistryFallback(url, {
          signal: controller.signal,
        })
      } catch (error) {
        const err = error as Error
        if (err.name === 'AbortError') {
          throw new Error(
            `Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000 / 60} minutes. ` +
              `Check your network connection and try again.`,
          )
        }
        throw error
      } finally {
        clearTimeout(timeoutId)
      }

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `${this.config.displayName} ${fullVersion} binaries not found (404). ` +
              `This version may have been removed from hostdb. ` +
              `Try a different version or check https://registry.layerbase.host`,
          )
        }
        throw new Error(
          `Failed to download ${this.config.displayName} binaries: ${response.status} ${response.statusText}`,
        )
      }

      const fileStream = createWriteStream(archiveFile)

      if (!response.body) {
        fileStream.destroy()
        throw new Error(
          `Download failed: response has no body (status ${response.status})`,
        )
      }

      // Convert WHATWG ReadableStream to Node.js Readable (requires Node.js 18+)
      const nodeStream = Readable.fromWeb(response.body)
      await pipeline(nodeStream, fileStream)

      if (platform === Platform.Win32) {
        await this.extractWindowsBinaries(
          archiveFile,
          binPath,
          tempDir,
          platform,
          onProgress,
        )
      } else {
        await this.extractUnixBinaries(
          archiveFile,
          binPath,
          tempDir,
          platform,
          onProgress,
        )
      }

      // Make binaries executable (Unix only)
      if (platform !== Platform.Win32) {
        const binDir = join(binPath, 'bin')
        if (existsSync(binDir)) {
          const binaries = await readdir(binDir)
          for (const binary of binaries) {
            await chmod(join(binDir, binary), 0o755)
          }
        }
      }

      // Verify the installation
      onProgress?.({ stage: 'verifying', message: 'Verifying installation...' })
      await this.verify(version, platform, arch)

      success = true
      return binPath
    } finally {
      // Clean up temp directory
      await rm(tempDir, { recursive: true, force: true })
      // Clean up binPath on failure to avoid leaving partial installations
      if (!success) {
        await rm(binPath, { recursive: true, force: true })
      }
    }
  }

  /**
   * Move extracted entries from extractDir to binPath.
   * Handles both nested ({engine}/ or {engine}-* /) and flat archive structures.
   * Uses rename with fallback to cp for cross-device or permission errors.
   *
   * For flat archives (executables at root without bin/), creates a bin/ subdirectory
   * to maintain consistent structure across all engines.
   */
  protected async moveExtractedEntries(
    extractDir: string,
    binPath: string,
    platform: Platform,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // Check if there's a nested engine directory
    const engineDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === this.config.engineName ||
          e.name.startsWith(`${this.config.engineName}-`)),
    )

    // Determine source directory and entries to move
    const sourceDir = engineDir ? join(extractDir, engineDir.name) : extractDir
    const sourceEntries = engineDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    // Check if the source already has a bin/ directory
    const hasBinDir = sourceEntries.some(
      (e) => e.isDirectory() && e.name === 'bin',
    )

    // If no bin/ directory, create one and put executables there
    // This handles flat archives where executables are at the root
    if (!hasBinDir) {
      const binDir = join(binPath, 'bin')
      await mkdir(binDir, { recursive: true })

      const ext = platform === Platform.Win32 ? '.exe' : ''
      const executableNames = this.config.executableNames.map(
        (name) => `${name}${ext}`,
      )

      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        // Put executables in bin/, everything else in binPath root
        const isExecutable = executableNames.includes(entry.name)
        const destPath = isExecutable
          ? join(binDir, entry.name)
          : join(binPath, entry.name)

        await moveEntry(sourcePath, destPath)
      }
    } else {
      // Has bin/ directory - move everything as-is
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        await moveEntry(sourcePath, destPath)
      }
    }
  }

  /**
   * Extract Unix binaries from tar.gz file
   */
  protected async extractUnixBinaries(
    tarFile: string,
    binPath: string,
    tempDir: string,
    platform: Platform,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    onProgress?.({
      stage: 'extracting',
      message: 'Extracting binaries...',
    })

    // Extract tar.gz to temp directory first
    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir, { recursive: true })
    await spawnAsync('tar', ['-xzf', tarFile, '-C', extractDir])

    // Move extracted entries to binPath
    await this.moveExtractedEntries(extractDir, binPath, platform)
  }

  /**
   * Extract Windows binaries from zip file
   */
  protected async extractWindowsBinaries(
    zipFile: string,
    binPath: string,
    tempDir: string,
    platform: Platform,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    onProgress?.({
      stage: 'extracting',
      message: 'Extracting binaries...',
    })

    // Extract zip to temp directory first using PowerShell
    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir, { recursive: true })

    // Escape single quotes for PowerShell (double them)
    const escapeForPowerShell = (s: string) => s.replace(/'/g, "''")

    // Build the PowerShell command
    const command = `Expand-Archive -LiteralPath '${escapeForPowerShell(zipFile)}' -DestinationPath '${escapeForPowerShell(extractDir)}' -Force`

    // Use -EncodedCommand to avoid shell parsing issues with special characters
    // (e.g., $ in usernames like C:\Users\John$Doe would be interpreted as variables)
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')

    await spawnAsync('powershell', [
      '-NoProfile',
      '-EncodedCommand',
      encodedCommand,
    ])

    // Move extracted entries to binPath
    await this.moveExtractedEntries(extractDir, binPath, platform)
  }

  /**
   * Verify that binaries are working
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
    const primaryPath = join(
      binPath,
      'bin',
      `${this.config.primaryBinary}${ext}`,
    )

    if (!existsSync(primaryPath)) {
      throw new Error(
        `${this.config.displayName} binary not found at ${binPath}/bin/`,
      )
    }

    try {
      const { stdout } = await spawnAsync(primaryPath, ['--version'])
      const reportedVersion = this.parseVersionFromOutput(stdout)

      if (!reportedVersion) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      // Check if full versions match exactly
      if (reportedVersion === fullVersion) {
        return true
      }

      // Check semantic version compatibility: same major and reported >= expected
      // This allows for minor version differences in how the binary reports its version
      const expectedMajor = fullVersion.split('.')[0]
      const reportedMajor = reportedVersion.split('.')[0]
      if (
        expectedMajor === reportedMajor &&
        compareVersions(reportedVersion, fullVersion) >= 0
      ) {
        return true
      }

      throw new Error(
        `Version mismatch: expected ${version}, got ${reportedVersion}`,
      )
    } catch (error) {
      const err = error as Error
      throw new Error(
        `Failed to verify ${this.config.displayName} binaries: ${err.message}`,
      )
    }
  }

  /**
   * Get the path to a specific binary
   */
  getBinaryExecutable(
    version: string,
    platform: Platform,
    arch: Arch,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === Platform.Win32 ? '.exe' : ''
    return join(binPath, 'bin', `${binary}${ext}`)
  }

  /**
   * Ensure binaries are available, downloading if necessary
   */
  async ensureInstalled(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)

    if (await this.isInstalled(version, platform, arch)) {
      onProgress?.({
        stage: 'cached',
        message: `Using cached ${this.config.displayName} binaries`,
      })
      return paths.getBinaryPath({
        engine: this.config.engineName,
        version: fullVersion,
        platform,
        arch,
      })
    }

    return await this.download(version, platform, arch, onProgress)
  }

  /**
   * Delete installed binaries for a specific version
   */
  async delete(version: string, platform: Platform, arch: Arch): Promise<void> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })

    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }
  }
}
