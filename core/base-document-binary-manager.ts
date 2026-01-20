/**
 * Base Document Binary Manager
 *
 * Provides shared implementation for binary managers that handle document-oriented databases
 * (MongoDB, FerretDB). These engines share similar download, extraction, and verification logic
 * but differ in binary names and version parsing specifics.
 *
 * Key features handled by this class:
 * - Archive download with timeout
 * - Unix (tar.gz) and Windows (zip) extraction
 * - macOS extended attribute file handling during extraction
 * - Nested directory handling in archives
 * - Version verification with major.minor matching
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
import { logDebug } from './error-handler'
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
 * Configuration for a document binary manager instance
 */
export type DocumentBinaryManagerConfig = {
  /** Engine enum value (e.g., Engine.MongoDB) */
  engine: Engine
  /** Engine name string for paths and URLs (e.g., 'mongodb') */
  engineName: string
  /** Display name for user messages (e.g., 'MongoDB') */
  displayName: string
  /** Server binary name without extension (e.g., 'mongod') */
  serverBinary: string
}

export abstract class BaseDocumentBinaryManager {
  protected abstract readonly config: DocumentBinaryManagerConfig

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
   * Parse version from server --version output.
   * Must be implemented by subclass as output format varies by engine.
   * Should return the version string (e.g., "7.0.28") or null if parsing fails.
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
   * Convert version to full version format (e.g., "7.0" -> "7.0.28")
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
    const serverPath = join(binPath, 'bin', `${this.config.serverBinary}${ext}`)
    return existsSync(serverPath)
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

      // Split from end to handle versions with dashes (e.g., 8.0.0-rc1)
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
   * Extract Unix binaries from tar.gz file.
   * Includes recovery handling for macOS extended attribute files (._* files)
   * that may be truncated in some archives.
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

    // Extract tar.gz - some archives may have issues with macOS extended attribute
    // files (._* files) that cause tar to exit non-zero even when binaries extract correctly.
    // We verify extraction success by checking if files were actually extracted.
    try {
      await spawnAsync('tar', ['-xzf', tarFile, '-C', extractDir])
    } catch (error) {
      const err = error as Error & { code?: string | number }

      // Check if extraction actually succeeded despite the error
      // (common with truncated macOS extended attribute files)
      const entries = await readdir(extractDir)
      if (entries.length === 0) {
        // No files extracted - this is a real failure
        throw new Error(
          `Extraction failed: ${err.message}${err.code ? ` (code: ${err.code})` : ''}`,
        )
      }

      // Files were extracted despite the error - log and continue
      // This handles tar warnings about truncated ._* files, permission issues on
      // metadata files, etc. that don't affect the actual binaries
      logDebug(`${this.config.displayName} extraction recovered from tar error`, {
        tarFile,
        entriesExtracted: entries.length,
        errorMessage: err.message,
        errorCode: err.code,
      })
    }

    await this.moveExtractedEntries(extractDir, binPath)
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
   * Verify that binaries are working.
   * Uses major.minor version matching for document databases.
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

    try {
      // Use spawnAsync to avoid shell injection (serverPath could contain special chars)
      const { stdout } = await spawnAsync(serverPath, ['--version'])
      const reportedVersion = this.parseVersionFromOutput(stdout)

      if (!reportedVersion) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      // Check if major.minor versions match
      const expectedMajorMinor = version.split('.').slice(0, 2).join('.')
      const reportedMajorMinor = reportedVersion.split('.').slice(0, 2).join('.')
      if (expectedMajorMinor === reportedMajorMinor) {
        return true
      }

      // Check if full versions match
      if (reportedVersion === fullVersion) {
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
   * Get the path to a specific binary (e.g., mongod, mongosh)
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
