/**
 * ClickHouse Binary Manager
 *
 * Handles downloading, extracting, and managing ClickHouse binaries from hostdb.
 * ClickHouse uses a single unified binary that handles server, client, and local modes.
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { spawnAsync } from '../../core/spawn-utils'
import { logDebug } from '../../core/error-handler'
import {
  Engine,
  Platform,
  type Arch,
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

export class ClickHouseBinaryManager {
  /**
   * Get the download URL for a ClickHouse version
   *
   * Uses hostdb GitHub releases for all platforms (macOS, Linux).
   * Note: Windows is not supported by ClickHouse on hostdb.
   */
  getDownloadUrl(version: string, platform: string, arch: string): string {
    const fullVersion = this.getFullVersion(version)
    return getBinaryUrl(fullVersion, platform, arch)
  }

  // Convert version to full version format (e.g., "25.12" -> "25.12.3.21")
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
      engine: 'clickhouse',
      version: fullVersion,
      platform,
      arch,
    })
    // ClickHouse uses a single binary named 'clickhouse'
    const clickhousePath = join(binPath, 'bin', 'clickhouse')
    return existsSync(clickhousePath)
  }

  // List all installed ClickHouse versions
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith('clickhouse-')) continue

      // Split from end to handle versions with dashes
      // Format: clickhouse-{version}-{platform}-{arch}
      const rest = entry.name.slice('clickhouse-'.length)
      const parts = rest.split('-')
      if (parts.length < 3) continue

      const arch = parts.pop()!
      const platform = parts.pop()!
      const version = parts.join('-')

      if (version && platform && arch) {
        installed.push({
          engine: Engine.ClickHouse,
          version,
          platform: platform as Platform,
          arch: arch as Arch,
        })
      }
    }

    return installed
  }

  // Download and extract ClickHouse binaries
  async download(
    version: string,
    platform: string,
    arch: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)
    const url = this.getDownloadUrl(version, platform, arch)
    const binPath = paths.getBinaryPath({
      engine: 'clickhouse',
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(
      paths.bin,
      `temp-clickhouse-${fullVersion}-${platform}-${arch}`,
    )
    const archiveFile = join(tempDir, 'clickhouse.tar.gz')

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
    try {
      // Download the archive with timeout (5 minutes)
      onProgress?.({
        stage: 'downloading',
        message: 'Downloading ClickHouse binaries...',
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
            `ClickHouse ${fullVersion} binaries not found (404). ` +
              `This version may have been removed from hostdb. ` +
              `Try a different version or check https://github.com/robertjbass/hostdb/releases`,
          )
        }
        throw new Error(
          `Failed to download ClickHouse binaries: ${response.status} ${response.statusText}`,
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

      await this.extractUnixBinaries(archiveFile, binPath, tempDir, onProgress)

      // Make binaries executable
      const binDir = join(binPath, 'bin')
      if (existsSync(binDir)) {
        const binaries = await readdir(binDir)
        for (const binary of binaries) {
          await chmod(join(binDir, binary), 0o755)
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

  // Move extracted entries from extractDir to binPath
  private async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // Check for a clickhouse subdirectory
    const clickhouseDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'clickhouse' || e.name.startsWith('clickhouse-')),
    )

    const sourceDir = clickhouseDir
      ? join(extractDir, clickhouseDir.name)
      : extractDir
    const sourceEntries = clickhouseDir
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
    } else {
      // Flat structure: create bin/ and move binaries there
      const destBinDir = join(binPath, 'bin')
      await mkdir(destBinDir, { recursive: true })

      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        // Check if it's an executable (no extension on Unix)
        const isExecutable =
          entry.isFile() &&
          !entry.name.includes('.') &&
          entry.name.startsWith('clickhouse')
        const destPath = isExecutable
          ? join(destBinDir, entry.name)
          : join(binPath, entry.name)
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
  }

  // Verify that ClickHouse binaries are working
  async verify(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'clickhouse',
      version: fullVersion,
      platform,
      arch,
    })

    const clickhousePath = join(binPath, 'bin', 'clickhouse')

    if (!existsSync(clickhousePath)) {
      throw new Error(`ClickHouse binary not found at ${binPath}/bin/`)
    }

    try {
      const { stdout, stderr } = await execAsync(
        `"${clickhousePath}" client --version`,
      )
      // Log stderr if present (may contain benign warnings about config, etc.)
      if (stderr && stderr.trim()) {
        logDebug(`clickhouse client stderr during version check: ${stderr.trim()}`)
      }
      // Extract version from output like "ClickHouse client version 25.12.3.21 (official build)"
      const match = stdout.match(/version\s+(\d+\.\d+\.\d+\.\d+)/)
      const altMatch = !match ? stdout.match(/(\d+\.\d+\.\d+\.\d+)/) : null
      const reportedVersion = match?.[1] ?? altMatch?.[1]

      if (!reportedVersion) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      // Check if major versions match (YY.MM format)
      const expectedMajor = version.split('.').slice(0, 2).join('.')
      const reportedMajor = reportedVersion.split('.').slice(0, 2).join('.')
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
        `Failed to verify ClickHouse binaries: ${details.join(', ')}`,
      )
    }
  }

  // Get the path to a specific binary
  getBinaryExecutable(
    version: string,
    platform: string,
    arch: string,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'clickhouse',
      version: fullVersion,
      platform,
      arch,
    })
    return join(binPath, 'bin', binary)
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
        message: 'Using cached ClickHouse binaries',
      })
      return paths.getBinaryPath({
        engine: 'clickhouse',
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
      engine: 'clickhouse',
      version: fullVersion,
      platform,
      arch,
    })

    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }
  }
}

export const clickhouseBinaryManager = new ClickHouseBinaryManager()
