/**
 * Valkey Binary Manager
 *
 * Handles downloading, extracting, and managing Valkey binaries from hostdb.
 * Similar to Redis binary manager but tailored for Valkey.
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { spawnAsync } from '../../core/spawn-utils'
import {
  Engine,
  type ProgressCallback,
  type InstalledBinary,
} from '../../types'

const execAsync = promisify(exec)

/**
 * Check if an error is a filesystem error that should trigger cp fallback
 * - EXDEV: cross-device link (rename across filesystems)
 * - EPERM: permission error (Windows filesystem operations)
 */
function isRenameFallbackError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && ['EXDEV', 'EPERM'].includes(code)
}

export class ValkeyBinaryManager {
  /**
   * Get the download URL for a Valkey version
   *
   * Uses hostdb GitHub releases for all platforms (macOS, Linux, Windows).
   */
  getDownloadUrl(version: string, platform: string, arch: string): string {
    const fullVersion = this.getFullVersion(version)
    return getBinaryUrl(fullVersion, platform, arch)
  }

  // Convert version to full version format (e.g., "8" -> "8.0.6")
  getFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  // Check if binaries for a specific version are already installed
  async isInstalled(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'valkey',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === 'win32' ? '.exe' : ''
    const valkeyServerPath = join(binPath, 'bin', `valkey-server${ext}`)
    return existsSync(valkeyServerPath)
  }

  // List all installed Valkey versions
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith('valkey-')) continue

      // Split from end to handle versions with dashes (e.g., 8.0.0-rc1)
      // Format: valkey-{version}-{platform}-{arch}
      const rest = entry.name.slice('valkey-'.length)
      const parts = rest.split('-')
      if (parts.length < 3) continue

      const arch = parts.pop()!
      const platform = parts.pop()!
      const version = parts.join('-')

      if (version && platform && arch) {
        installed.push({
          engine: Engine.Valkey,
          version,
          platform,
          arch,
        })
      }
    }

    return installed
  }

  // Download and extract Valkey binaries
  async download(
    version: string,
    platform: string,
    arch: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)
    const url = this.getDownloadUrl(version, platform, arch)
    const binPath = paths.getBinaryPath({
      engine: 'valkey',
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(
      paths.bin,
      `temp-valkey-${fullVersion}-${platform}-${arch}`,
    )
    // Windows uses .zip, Unix uses .tar.gz
    const ext = platform === 'win32' ? 'zip' : 'tar.gz'
    const archiveFile = join(tempDir, `valkey.${ext}`)

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
    try {
      // Download the archive with timeout (5 minutes)
      onProgress?.({
        stage: 'downloading',
        message: 'Downloading Valkey binaries...',
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000)

      let response: Response
      try {
        response = await fetch(url, { signal: controller.signal })
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
            `Valkey ${fullVersion} binaries not found (404). ` +
              `This version may have been removed from hostdb. ` +
              `Try a different version or check https://github.com/robertjbass/hostdb/releases`,
          )
        }
        throw new Error(
          `Failed to download Valkey binaries: ${response.status} ${response.statusText}`,
        )
      }

      const fileStream = createWriteStream(archiveFile)
      // @ts-expect-error - response.body is ReadableStream
      await pipeline(response.body, fileStream)

      if (platform === 'win32') {
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
      if (platform !== 'win32') {
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

  // Extract Unix binaries from tar.gz file
  private async extractUnixBinaries(
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

  // Extract Windows binaries from zip file
  private async extractWindowsBinaries(
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

    // Use PowerShell's Expand-Archive for zip extraction
    await spawnAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${escapeForPowerShell(zipFile)}' -DestinationPath '${escapeForPowerShell(extractDir)}' -Force`,
    ])

    await this.moveExtractedEntries(extractDir, binPath)
  }

  // Move extracted entries from extractDir to binPath, handling nested valkey/ directories
  private async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })
    const valkeyDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'valkey' || e.name.startsWith('valkey-')),
    )

    const sourceDir = valkeyDir ? join(extractDir, valkeyDir.name) : extractDir
    const entriesToMove = valkeyDir
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
        } else {
          throw error
        }
      }
    }
  }

  // Verify that Valkey binaries are working
  async verify(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'valkey',
      version: fullVersion,
      platform,
      arch,
    })

    const ext = platform === 'win32' ? '.exe' : ''
    const serverPath = join(binPath, 'bin', `valkey-server${ext}`)

    if (!existsSync(serverPath)) {
      throw new Error(`Valkey binary not found at ${binPath}/bin/`)
    }

    try {
      const { stdout } = await execAsync(`"${serverPath}" --version`)
      // Extract version from output like "Valkey server v=8.0.6 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=..."
      // or "v=8.0.6" pattern
      const match = stdout.match(/v=(\d+\.\d+\.\d+)/)
      const altMatch = !match ? stdout.match(/(\d+\.\d+\.\d+)/) : null
      const reportedVersion = match?.[1] ?? altMatch?.[1]

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
      const err = error as Error
      throw new Error(`Failed to verify Valkey binaries: ${err.message}`)
    }
  }

  // Get the path to a specific binary (valkey-server, valkey-cli, etc.)
  getBinaryExecutable(
    version: string,
    platform: string,
    arch: string,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'valkey',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === 'win32' ? '.exe' : ''
    return join(binPath, 'bin', `${binary}${ext}`)
  }

  // Ensure binaries are available, downloading if necessary
  async ensureInstalled(
    version: string,
    platform: string,
    arch: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)

    if (await this.isInstalled(version, platform, arch)) {
      onProgress?.({
        stage: 'cached',
        message: 'Using cached Valkey binaries',
      })
      return paths.getBinaryPath({
        engine: 'valkey',
        version: fullVersion,
        platform,
        arch,
      })
    }

    return await this.download(version, platform, arch, onProgress)
  }

  // Delete installed binaries for a specific version
  async delete(version: string, platform: string, arch: string): Promise<void> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'valkey',
      version: fullVersion,
      platform,
      arch,
    })

    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }
  }
}

export const valkeyBinaryManager = new ValkeyBinaryManager()
