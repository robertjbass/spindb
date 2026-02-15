/**
 * Base Binary Manager
 *
 * Provides shared implementation for binary managers that download from hostdb.
 * Currently used by Redis and Valkey which have nearly identical download/extraction logic.
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
import { logDebug } from './error-handler'
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
 * Configuration for a binary manager instance
 */
export type BinaryManagerConfig = {
  /** Engine enum value (e.g., Engine.Redis) */
  engine: Engine
  /** Engine name string for paths and URLs (e.g., 'redis') */
  engineName: string
  /** Display name for user messages (e.g., 'Redis') */
  displayName: string
  /** Server binary name without extension (e.g., 'redis-server') */
  serverBinary: string
}

export abstract class BaseBinaryManager {
  protected abstract readonly config: BinaryManagerConfig

  /** Timeout for `--version` verification after download (ms). Override in subclass if needed. */
  protected verifyTimeoutMs = 30_000

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
   * Convert version to full version format (e.g., "7" -> "7.4.7")
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

      // Split from end to handle versions with dashes (e.g., 7.4.0-rc1)
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

    // Ensure directories exist (binPath created after successful download)
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })

    let success = false
    try {
      // Download the archive with timeout (5 minutes)
      onProgress?.({
        stage: 'downloading',
        message: `Downloading ${this.config.displayName} binaries...`,
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000)

      let response: Response
      try {
        response = await fetchWithRegistryFallback(url, {
          signal: controller.signal,
        })
      } catch (error) {
        const err = error as Error
        if (err.name === 'AbortError') {
          throw new Error('Download timed out after 5 minutes')
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

      if (!response.body) {
        throw new Error(
          `Download failed: response has no body (status ${response.status})`,
        )
      }

      // Create file stream only after confirming response.body is present
      const fileStream = createWriteStream(archiveFile)
      try {
        // Convert WHATWG ReadableStream to Node.js Readable (requires Node.js 18+)
        const nodeStream = Readable.fromWeb(response.body)
        await pipeline(nodeStream, fileStream)
      } catch (pipelineError) {
        // Ensure fileStream is destroyed on pipeline errors
        fileStream.destroy()
        throw pipelineError
      }

      // Create binPath only after download succeeds (avoids leaving empty dirs on failure)
      await mkdir(binPath, { recursive: true })

      if (platform === Platform.Win32) {
        await this.extractWindowsBinaries(
          archiveFile,
          binPath,
          tempDir,
          onProgress,
        )
      } else {
        await this.extractUnixBinaries(
          archiveFile,
          binPath,
          tempDir,
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
   * Extract Windows binaries from zip file
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

    await this.moveExtractedEntries(extractDir, binPath)
  }

  /**
   * Move extracted entries from extractDir to binPath, handling nested engine directories.
   * Archives may have {engine}/bin/ structure or flat {engine}/ structure.
   * This method normalizes both to binPath/bin/ structure.
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
    const sourceEntries = engineDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    // Check if source has a bin/ subdirectory
    const hasBinDir = sourceEntries.some(
      (e) => e.isDirectory() && e.name === 'bin',
    )

    if (hasBinDir) {
      // Standard structure: move all entries as-is (preserves bin/ subdirectory)
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        await moveEntry(sourcePath, destPath)
      }
    } else {
      // Flat structure: binaries are directly in engine/, need to create bin/ subdirectory
      const destBinDir = join(binPath, 'bin')
      await mkdir(destBinDir, { recursive: true })

      // Common non-binary files without extensions (case-insensitive)
      const nonBinaryFiles = new Set([
        'license',
        'licence',
        'readme',
        'notice',
        'changelog',
        'contributing',
        'authors',
        'copying',
        'version',
        'makefile',
        'dockerfile',
        'manifest',
        'install',
        'news',
        'thanks',
        'todo',
        'history',
      ])

      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        // Identify executables: .exe/.dll on Windows, or files without config extensions on Unix
        const isWindowsExecutable =
          entry.name.endsWith('.exe') || entry.name.endsWith('.dll')
        const isConfigOrMetadata =
          entry.name.startsWith('.') ||
          entry.name.endsWith('.json') ||
          entry.name.endsWith('.conf') ||
          entry.name.endsWith('.yaml') ||
          entry.name.endsWith('.yml') ||
          entry.name.endsWith('.xml') ||
          entry.name.endsWith('.txt') ||
          entry.name.endsWith('.md')
        const isKnownNonBinary = nonBinaryFiles.has(entry.name.toLowerCase())
        const isUnixExecutable =
          entry.isFile() &&
          !isConfigOrMetadata &&
          !isKnownNonBinary &&
          !entry.name.includes('.')

        const isBinary = isWindowsExecutable || isUnixExecutable
        const destPath = isBinary
          ? join(destBinDir, entry.name)
          : join(binPath, entry.name)
        await moveEntry(sourcePath, destPath)
      }
    }
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
    const serverPath = join(binPath, 'bin', `${this.config.serverBinary}${ext}`)

    if (!existsSync(serverPath)) {
      throw new Error(
        `${this.config.displayName} binary not found at ${binPath}/bin/`,
      )
    }

    try {
      const { stdout, stderr } = await spawnAsync(serverPath, ['--version'], {
        timeout: this.verifyTimeoutMs,
        cwd: binPath,
      })
      // Log stderr if present (may contain warnings)
      if (stderr && stderr.trim()) {
        logDebug(`${this.config.serverBinary} stderr`, {
          stderr: stderr.trim(),
        })
      }

      const reportedVersion = this.parseVersionFromOutput(stdout)

      if (!reportedVersion) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      // Check if major versions match
      const expectedMajor = version.split('.')[0]
      const reportedMajor = reportedVersion.split('.')[0]
      if (expectedMajor === reportedMajor) {
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
   * Get the path to a specific binary (e.g., redis-server, redis-cli)
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
