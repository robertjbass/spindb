/**
 * SQLite Binary Manager
 *
 * Handles downloading, extracting, and managing SQLite binaries from hostdb.
 * Unlike other engines, SQLite is an embedded database (not a server).
 * This manager handles the sqlite3 CLI and related tools.
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { spawnAsync } from '../../core/spawn-utils'
import {
  Engine,
  Platform,
  type Arch,
  type ProgressCallback,
  type InstalledBinary,
  isValidPlatform,
  isValidArch,
} from '../../types'

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

export class SQLiteBinaryManager {
  /**
   * Move a file or directory, falling back to copy+remove if rename fails across filesystems.
   */
  private async moveEntry(sourcePath: string, destPath: string): Promise<void> {
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

  /**
   * Get the download URL for a SQLite version
   *
   * Uses hostdb GitHub releases for all platforms (macOS, Linux, Windows).
   */
  getDownloadUrl(version: string, platform: Platform, arch: Arch): string {
    const fullVersion = this.getFullVersion(version)
    return getBinaryUrl(fullVersion, platform, arch)
  }

  // Convert version to full version format (e.g., "3" -> "3.51.2")
  getFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  // Check if binaries for a specific version are already installed
  async isInstalled(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'sqlite',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const sqlite3Path = join(binPath, 'bin', `sqlite3${ext}`)
    return existsSync(sqlite3Path)
  }

  // List all installed SQLite versions
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      // Match sqlite-{version}-{platform}-{arch} directories
      const match = entry.name.match(/^sqlite-([\d.]+)-(\w+)-(\w+)$/)
      if (match && isValidPlatform(match[2]) && isValidArch(match[3])) {
        installed.push({
          engine: Engine.SQLite,
          version: match[1],
          platform: match[2],
          arch: match[3],
        })
      }
    }

    return installed
  }

  // Download and extract SQLite binaries
  async download(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)
    const url = this.getDownloadUrl(version, platform, arch)
    const binPath = paths.getBinaryPath({
      engine: 'sqlite',
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(
      paths.bin,
      `temp-sqlite-${fullVersion}-${platform}-${arch}`,
    )
    // Windows uses .zip, Unix uses .tar.gz
    const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'
    const archiveFile = join(tempDir, `sqlite.${ext}`)

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
    try {
      // Download the archive with timeout (5 minutes)
      onProgress?.({
        stage: 'downloading',
        message: 'Downloading SQLite binaries...',
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
            `SQLite ${fullVersion} binaries not found (404). ` +
              `This version may have been removed from hostdb. ` +
              `Try a different version or check https://github.com/robertjbass/hostdb/releases`,
          )
        }
        throw new Error(
          `Failed to download SQLite binaries: ${response.status} ${response.statusText}`,
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
   * Handles both nested (sqlite/ or sqlite-* /) and flat archive structures.
   * (Note: space before / prevents early comment termination)
   * Uses rename with fallback to cp for cross-device or permission errors.
   *
   * For flat archives (executables at root without bin/), creates a bin/ subdirectory
   * to maintain consistent structure across all engines.
   */
  private async moveExtractedEntries(
    extractDir: string,
    binPath: string,
    platform: Platform,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // Check if there's a nested sqlite/ directory
    const sqliteDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'sqlite' || e.name.startsWith('sqlite-')),
    )

    // Determine source directory and entries to move
    const sourceDir = sqliteDir ? join(extractDir, sqliteDir.name) : extractDir
    const sourceEntries = sqliteDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    // Check if the source already has a bin/ directory
    const hasBinDir = sourceEntries.some(
      (e) => e.isDirectory() && e.name === 'bin',
    )

    // If no bin/ directory, create one and put executables there
    // This handles flat archives where sqlite3 is at the root
    if (!hasBinDir) {
      const binDir = join(binPath, 'bin')
      await mkdir(binDir, { recursive: true })

      const ext = platform === Platform.Win32 ? '.exe' : ''
      // SQLite tools that should go in bin/
      const executableNames = [
        `sqlite3${ext}`,
        `sqldiff${ext}`,
        `sqlite3_analyzer${ext}`,
        `sqlite3_rsync${ext}`,
      ]

      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        // Put executables in bin/, everything else in binPath root
        const isExecutable = executableNames.includes(entry.name)
        const destPath = isExecutable
          ? join(binDir, entry.name)
          : join(binPath, entry.name)

        await this.moveEntry(sourcePath, destPath)
      }
    } else {
      // Has bin/ directory - move everything as-is
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        await this.moveEntry(sourcePath, destPath)
      }
    }
  }

  // Extract Unix binaries from tar.gz file
  private async extractUnixBinaries(
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

  // Extract Windows binaries from zip file
  private async extractWindowsBinaries(
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

  // Verify that SQLite binaries are working
  async verify(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'sqlite',
      version: fullVersion,
      platform,
      arch,
    })

    const ext = platform === Platform.Win32 ? '.exe' : ''
    const sqlite3Path = join(binPath, 'bin', `sqlite3${ext}`)

    if (!existsSync(sqlite3Path)) {
      throw new Error(`SQLite binary not found at ${binPath}/bin/`)
    }

    try {
      const { stdout } = await spawnAsync(sqlite3Path, ['--version'])
      // Extract version from output like "3.51.2 2025-01-08 12:00:00 ..."
      const match = stdout.match(/^(\d+\.\d+\.\d+)/)
      const reportedVersion = match?.[1]

      if (!reportedVersion) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      // Check if full versions match exactly
      if (reportedVersion === fullVersion) {
        return true
      }

      // Check if major versions match (relaxed match due to version normalization)
      const expectedMajor = version.split('.')[0]
      const reportedMajor = reportedVersion.split('.')[0]
      if (expectedMajor === reportedMajor) {
        console.debug(
          `SQLite version match by major version: requested ${version} (normalized to ${fullVersion}), binary reports ${reportedVersion}`,
        )
        return true
      }

      throw new Error(
        `Version mismatch: expected ${version}, got ${reportedVersion}`,
      )
    } catch (error) {
      const err = error as Error
      throw new Error(`Failed to verify SQLite binaries: ${err.message}`)
    }
  }

  // Get the path to a specific binary (sqlite3, sqldiff, etc.)
  getBinaryExecutable(
    version: string,
    platform: Platform,
    arch: Arch,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'sqlite',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === Platform.Win32 ? '.exe' : ''
    return join(binPath, 'bin', `${binary}${ext}`)
  }

  // Ensure binaries are available, downloading if necessary
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
        message: 'Using cached SQLite binaries',
      })
      return paths.getBinaryPath({
        engine: 'sqlite',
        version: fullVersion,
        platform,
        arch,
      })
    }

    return await this.download(version, platform, arch, onProgress)
  }

  // Delete installed binaries for a specific version
  async delete(version: string, platform: Platform, arch: Arch): Promise<void> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'sqlite',
      version: fullVersion,
      platform,
      arch,
    })

    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }
  }
}

export const sqliteBinaryManager = new SQLiteBinaryManager()
