/**
 * Base Server Binary Manager
 *
 * Provides shared implementation for binary managers that handle server-based SQL databases
 * (MySQL, MariaDB). These engines share similar download, extraction, and verification logic
 * but differ in binary names and version parsing.
 *
 * Key features handled by this class:
 * - Archive download with timeout
 * - Unix (tar.gz) and Windows (zip) extraction
 * - Nested directory handling in archives
 * - Version verification with trailing zero normalization
 * - Binary executable path resolution
 *
 * To extend this class, implement the abstract methods that define engine-specific behavior.
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { paths } from '../config/paths'
import { spawnAsync, extractWindowsArchive } from './spawn-utils'
import { isRenameFallbackError } from './fs-error-utils'
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
 * Configuration for a server binary manager instance
 */
export type ServerBinaryManagerConfig = {
  /** Engine enum value (e.g., Engine.MySQL) */
  engine: Engine
  /** Engine name string for paths and URLs (e.g., 'mysql') */
  engineName: string
  /** Display name for user messages (e.g., 'MySQL') */
  displayName: string
  /** Server binary names to check, in order of preference (e.g., ['mysqld'] or ['mariadbd', 'mysqld']) */
  serverBinaryNames: string[]
}

export abstract class BaseServerBinaryManager {
  protected abstract readonly config: ServerBinaryManagerConfig

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
   * Get the download URL for a version (public API)
   */
  getDownloadUrl(version: string, platform: Platform, arch: Arch): string {
    const fullVersion = this.getFullVersion(version)
    return this.getBinaryUrlFromModule(fullVersion, platform, arch)
  }

  /**
   * Convert version to full version format
   */
  getFullVersion(version: string): string {
    return this.normalizeVersionFromModule(version)
  }

  /**
   * Check if binaries for a specific version are already installed.
   * Checks all server binary names in order until one is found.
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

    // Check each possible server binary name
    for (const serverBinary of this.config.serverBinaryNames) {
      const serverPath = join(binPath, 'bin', `${serverBinary}${ext}`)
      if (existsSync(serverPath)) {
        return true
      }
    }
    return false
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

      // Parse from the end to handle versions with dashes (e.g., mysql-8.0.40-rc1-darwin-arm64)
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
    const archiveFile = join(
      tempDir,
      platform === Platform.Win32
        ? `${this.config.engineName}.zip`
        : `${this.config.engineName}.tar.gz`,
    )

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
    const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

    try {
      // Download the archive
      onProgress?.({
        stage: 'downloading',
        message: `Downloading ${this.config.displayName} binaries...`,
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

      let response: Response
      try {
        response = await fetch(url, { signal: controller.signal })
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
              `Try a different version or check https://github.com/robertjbass/hostdb/releases`,
          )
        }
        throw new Error(
          `Failed to download ${this.config.displayName} binaries: ${response.status} ${response.statusText}`,
        )
      }

      if (!response.body) {
        throw new Error(
          `Failed to download ${this.config.displayName} binaries: response body is empty`,
        )
      }

      const fileStream = createWriteStream(archiveFile)
      const nodeStream = Readable.fromWeb(response.body)
      await pipeline(nodeStream, fileStream)

      if (platform === Platform.Win32) {
        await this.extractWindowsBinaries(archiveFile, binPath, tempDir, onProgress)
      } else {
        await this.extractUnixBinaries(archiveFile, binPath, tempDir, onProgress)
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
   * Extract Windows binaries from ZIP file
   */
  protected async extractWindowsBinaries(
    zipFile: string,
    binPath: string,
    tempDir: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    onProgress?.({
      stage: 'extracting',
      message: 'Extracting binaries...',
    })

    // Extract ZIP using PowerShell Expand-Archive
    await extractWindowsArchive(zipFile, tempDir)

    await this.moveExtractedEntries(tempDir, binPath)
  }

  /**
   * Extract Unix binaries from tar.gz file
   */
  protected async extractUnixBinaries(
    tarFile: string,
    binPath: string,
    tempDir: string,
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

    await this.moveExtractedEntries(extractDir, binPath)
  }

  /**
   * Move extracted entries from extractDir to binPath, handling nested engine directories
   */
  protected async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })
    const engineDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === this.config.engineName ||
          e.name.startsWith(`${this.config.engineName}-`)),
    )

    const sourceDir = engineDir ? join(extractDir, engineDir.name) : extractDir
    const entriesToMove = engineDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    for (const entry of entriesToMove) {
      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(binPath, entry.name)
      try {
        await rename(sourcePath, destPath)
      } catch (error) {
        if (isRenameFallbackError(error)) {
          await cp(sourcePath, destPath, { recursive: true })
          await rm(sourcePath, { recursive: true, force: true })
        } else {
          throw error
        }
      }
    }
  }

  /**
   * Find the server binary path, checking each possible name in order
   */
  protected findServerBinaryPath(binPath: string, ext: string): string | null {
    for (const serverBinary of this.config.serverBinaryNames) {
      const serverPath = join(binPath, 'bin', `${serverBinary}${ext}`)
      if (existsSync(serverPath)) {
        return serverPath
      }
    }
    return null
  }

  /**
   * Strip trailing .0 for version comparison
   */
  protected stripTrailingZero(version: string): string {
    return version.replace(/\.0$/, '')
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

    const serverPath = this.findServerBinaryPath(binPath, ext)

    if (!serverPath) {
      throw new Error(
        `${this.config.displayName} binary not found at ${binPath}/bin/`,
      )
    }

    try {
      const { stdout } = await spawnAsync(serverPath, ['--version'])
      // Extract version from output like "mysqld  Ver 8.0.40" or "mariadbd  Ver 11.8.5-MariaDB"
      const match = stdout.match(/Ver\s+([\d.]+)/)
      if (!match) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      const reportedVersion = match[1]
      const expectedNormalized = this.stripTrailingZero(fullVersion)
      const reportedNormalized = this.stripTrailingZero(reportedVersion)

      // Check if versions match
      if (reportedNormalized === expectedNormalized) {
        return true
      }

      // Also accept if major versions match (e.g., expected "8.0", got "8.0.40")
      const expectedMajor = version.split('.').slice(0, 2).join('.')
      const reportedMajor = reportedVersion.split('.').slice(0, 2).join('.')
      if (expectedMajor === reportedMajor) {
        return true
      }

      throw new Error(
        `Version mismatch: expected ${version}, got ${reportedVersion}`,
      )
    } catch (error) {
      const err = error as Error & { stderr?: string; code?: number }
      // Include stderr and exit code in error message for better debugging
      const details = [err.message]
      if (err.stderr) details.push(`stderr: ${err.stderr.trim()}`)
      if (err.code !== undefined) details.push(`exit code: ${err.code}`)
      throw new Error(
        `Failed to verify ${this.config.displayName} binaries: ${details.join(', ')}`,
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
