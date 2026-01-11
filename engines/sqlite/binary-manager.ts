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
import { spawn } from 'child_process'

import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import {
  Engine,
  type ProgressCallback,
  type InstalledBinary,
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

// Execute a command using spawn with argument array (safer than shell interpolation)
function spawnAsync(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options?.cwd,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(
          new Error(
            `Command "${command} ${args.join(' ')}" failed with code ${code}: ${stderr || stdout}`,
          ),
        )
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to execute "${command}": ${err.message}`))
    })
  })
}

export class SQLiteBinaryManager {
  /**
   * Get the download URL for a SQLite version
   *
   * Uses hostdb GitHub releases for all platforms (macOS, Linux, Windows).
   */
  getDownloadUrl(version: string, platform: string, arch: string): string {
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
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'sqlite',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === 'win32' ? '.exe' : ''
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
      if (match) {
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
    platform: string,
    arch: string,
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
    const ext = platform === 'win32' ? 'zip' : 'tar.gz'
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
        throw new Error(
          `Failed to download binaries: ${response.status} ${response.statusText}`,
        )
      }

      const fileStream = createWriteStream(archiveFile)
      // Convert WHATWG ReadableStream to Node.js Readable (requires Node.js 18+)
      const nodeStream = Readable.fromWeb(response.body as ReadableStream)
      await pipeline(nodeStream, fileStream)

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

    // Check if there's a nested sqlite/ directory
    const entries = await readdir(extractDir, { withFileTypes: true })
    const sqliteDir = entries.find(
      (e) =>
        e.isDirectory() && (e.name === 'sqlite' || e.name.startsWith('sqlite-')),
    )

    if (sqliteDir) {
      // Nested structure: move contents from sqlite/ to binPath
      const sourceDir = join(extractDir, sqliteDir.name)
      const sourceEntries = await readdir(sourceDir, { withFileTypes: true })
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
      // Flat structure: move contents directly to binPath
      for (const entry of entries) {
        const sourcePath = join(extractDir, entry.name)
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

    // Check if there's a nested sqlite/ directory
    const entries = await readdir(extractDir, { withFileTypes: true })
    const sqliteDir = entries.find(
      (e) =>
        e.isDirectory() && (e.name === 'sqlite' || e.name.startsWith('sqlite-')),
    )

    if (sqliteDir) {
      // Nested structure: move contents from sqlite/ to binPath
      const sourceDir = join(extractDir, sqliteDir.name)
      const sourceEntries = await readdir(sourceDir, { withFileTypes: true })
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
      // Flat structure: move contents directly to binPath
      for (const entry of entries) {
        const sourcePath = join(extractDir, entry.name)
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
  }

  // Verify that SQLite binaries are working
  async verify(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'sqlite',
      version: fullVersion,
      platform,
      arch,
    })

    const ext = platform === 'win32' ? '.exe' : ''
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
      throw new Error(`Failed to verify SQLite binaries: ${err.message}`)
    }
  }

  // Get the path to a specific binary (sqlite3, sqldiff, etc.)
  getBinaryExecutable(
    version: string,
    platform: string,
    arch: string,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'sqlite',
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
  async delete(version: string, platform: string, arch: string): Promise<void> {
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
