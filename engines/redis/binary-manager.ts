/**
 * Redis Binary Manager
 *
 * Handles downloading, extracting, and managing Redis binaries from hostdb.
 * Similar to MySQL/MariaDB binary manager but tailored for Redis.
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type ProgressCallback, type InstalledBinary } from '../../types'

const execAsync = promisify(exec)

/**
 * Execute a command using spawn with argument array (safer than shell interpolation)
 */
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

export class RedisBinaryManager {
  /**
   * Get the download URL for a Redis version
   *
   * Uses hostdb GitHub releases for all platforms (macOS, Linux, Windows).
   */
  getDownloadUrl(version: string, platform: string, arch: string): string {
    const fullVersion = this.getFullVersion(version)
    return getBinaryUrl(fullVersion, platform, arch)
  }

  /**
   * Convert version to full version format (e.g., "7" -> "7.4.7")
   */
  getFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  /**
   * Check if binaries for a specific version are already installed
   */
  async isInstalled(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === 'win32' ? '.exe' : ''
    const redisServerPath = join(binPath, 'bin', `redis-server${ext}`)
    return existsSync(redisServerPath)
  }

  /**
   * List all installed Redis versions
   */
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('redis-')) {
        const parts = entry.name.split('-')
        if (parts.length >= 4) {
          installed.push({
            engine: Engine.Redis,
            version: parts[1],
            platform: parts[2],
            arch: parts[3],
          })
        }
      }
    }

    return installed
  }

  /**
   * Download and extract Redis binaries
   */
  async download(
    version: string,
    platform: string,
    arch: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)
    const url = this.getDownloadUrl(version, platform, arch)
    const binPath = paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(
      paths.bin,
      `temp-redis-${fullVersion}-${platform}-${arch}`,
    )
    // Windows uses .zip, Unix uses .tar.gz
    const ext = platform === 'win32' ? 'zip' : 'tar.gz'
    const archiveFile = join(tempDir, `redis.${ext}`)

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    try {
      // Download the archive
      onProgress?.({
        stage: 'downloading',
        message: 'Downloading Redis binaries...',
      })

      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(
          `Failed to download binaries: ${response.status} ${response.statusText}`,
        )
      }

      const fileStream = createWriteStream(archiveFile)
      // @ts-expect-error - response.body is ReadableStream
      await pipeline(response.body, fileStream)

      if (platform === 'win32') {
        await this.extractWindowsBinaries(archiveFile, binPath, tempDir, onProgress)
      } else {
        await this.extractUnixBinaries(archiveFile, binPath, tempDir, onProgress)
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

      return binPath
    } finally {
      // Clean up temp directory
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  /**
   * Extract Unix binaries from tar.gz file
   */
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

    // Check if there's a nested redis/ directory
    const entries = await readdir(extractDir, { withFileTypes: true })
    const redisDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'redis' || e.name.startsWith('redis-')),
    )

    if (redisDir) {
      // Nested structure: move contents from redis/ to binPath
      const sourceDir = join(extractDir, redisDir.name)
      const sourceEntries = await readdir(sourceDir, { withFileTypes: true })
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        try {
          await rename(sourcePath, destPath)
        } catch {
          await cp(sourcePath, destPath, { recursive: true })
        }
      }
    } else {
      // Flat structure: move contents directly to binPath
      for (const entry of entries) {
        const sourcePath = join(extractDir, entry.name)
        const destPath = join(binPath, entry.name)
        try {
          await rename(sourcePath, destPath)
        } catch {
          await cp(sourcePath, destPath, { recursive: true })
        }
      }
    }
  }

  /**
   * Extract Windows binaries from zip file
   */
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

    // Use PowerShell's Expand-Archive for zip extraction
    await spawnAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${zipFile}' -DestinationPath '${extractDir}' -Force`,
    ])

    // Check if there's a nested redis/ directory
    const entries = await readdir(extractDir, { withFileTypes: true })
    const redisDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'redis' || e.name.startsWith('redis-')),
    )

    if (redisDir) {
      // Nested structure: move contents from redis/ to binPath
      const sourceDir = join(extractDir, redisDir.name)
      const sourceEntries = await readdir(sourceDir, { withFileTypes: true })
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        try {
          await rename(sourcePath, destPath)
        } catch {
          await cp(sourcePath, destPath, { recursive: true })
        }
      }
    } else {
      // Flat structure: move contents directly to binPath
      for (const entry of entries) {
        const sourcePath = join(extractDir, entry.name)
        const destPath = join(binPath, entry.name)
        try {
          await rename(sourcePath, destPath)
        } catch {
          await cp(sourcePath, destPath, { recursive: true })
        }
      }
    }
  }

  /**
   * Verify that Redis binaries are working
   */
  async verify(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform,
      arch,
    })

    const ext = platform === 'win32' ? '.exe' : ''
    const serverPath = join(binPath, 'bin', `redis-server${ext}`)

    if (!existsSync(serverPath)) {
      throw new Error(`Redis binary not found at ${binPath}/bin/`)
    }

    try {
      const { stdout } = await execAsync(`"${serverPath}" --version`)
      // Extract version from output like "Redis server v=7.4.7 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=..."
      const match = stdout.match(/v=(\d+\.\d+\.\d+)/)
      if (!match) {
        // Also try matching just version number pattern
        const altMatch = stdout.match(/(\d+\.\d+\.\d+)/)
        if (!altMatch) {
          throw new Error(`Could not parse version from: ${stdout.trim()}`)
        }
      }

      const reportedVersion = match ? match[1] : stdout.match(/(\d+\.\d+\.\d+)/)?.[1]
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
      throw new Error(`Failed to verify Redis binaries: ${err.message}`)
    }
  }

  /**
   * Get the path to a specific binary (redis-server, redis-cli, etc.)
   */
  getBinaryExecutable(
    version: string,
    platform: string,
    arch: string,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform,
      arch,
    })
    return join(binPath, 'bin', binary)
  }

  /**
   * Ensure binaries are available, downloading if necessary
   */
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
        message: 'Using cached Redis binaries',
      })
      return paths.getBinaryPath({
        engine: 'redis',
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
  async delete(
    version: string,
    platform: string,
    arch: string,
  ): Promise<void> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'redis',
      version: fullVersion,
      platform,
      arch,
    })

    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }
  }
}

export const redisBinaryManager = new RedisBinaryManager()
