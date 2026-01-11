/**
 * MongoDB Binary Manager
 *
 * Handles downloading, extracting, and managing MongoDB binaries from hostdb.
 * Similar to Redis/MySQL binary manager but tailored for MongoDB.
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
import {
  Engine,
  type ProgressCallback,
  type InstalledBinary,
} from '../../types'

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

export class MongoDBBinaryManager {
  /**
   * Get the download URL for a MongoDB version
   *
   * Uses hostdb GitHub releases for all platforms (macOS, Linux, Windows).
   */
  getDownloadUrl(version: string, platform: string, arch: string): string {
    const fullVersion = this.getFullVersion(version)
    return getBinaryUrl(fullVersion, platform, arch)
  }

  /**
   * Convert version to full version format (e.g., "7.0" -> "7.0.28")
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
      engine: 'mongodb',
      version: fullVersion,
      platform,
      arch,
    })
    // MongoDB server binary (with .exe on Windows)
    const ext = platform === 'win32' ? '.exe' : ''
    const mongodPath = join(binPath, 'bin', `mongod${ext}`)
    return existsSync(mongodPath)
  }

  /**
   * List all installed MongoDB versions
   */
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      // Use regex for robust parsing - handles versions with dashes (e.g., 8.0.0-rc1)
      const match = entry.name.match(/^mongodb-(.+)-([^-]+)-([^-]+)$/)
      if (match) {
        installed.push({
          engine: Engine.MongoDB,
          version: match[1],
          platform: match[2],
          arch: match[3],
        })
      }
    }

    return installed
  }

  /**
   * Download and extract MongoDB binaries
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
      engine: 'mongodb',
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(
      paths.bin,
      `temp-mongodb-${fullVersion}-${platform}-${arch}`,
    )
    // Windows uses .zip, Unix uses .tar.gz
    const ext = platform === 'win32' ? 'zip' : 'tar.gz'
    const archiveFile = join(tempDir, `mongodb.${ext}`)

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    try {
      // Download the archive with timeout (5 minutes)
      onProgress?.({
        stage: 'downloading',
        message: 'Downloading MongoDB binaries...',
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

    // Extract tar.gz - ignore errors from macOS extended attribute files (._* files)
    // that may be truncated. The actual binaries extract correctly.
    try {
      await spawnAsync('tar', ['-xzf', tarFile, '-C', extractDir])
    } catch (error) {
      const err = error as Error
      // If error is about truncated files (macOS extended attributes), check if extraction worked
      if (err.message.includes('Truncated') || err.message.includes('._')) {
        // Verify that at least some files were extracted
        const entries = await readdir(extractDir)
        if (entries.length === 0) {
          throw new Error(`Extraction failed completely: ${err.message}`)
        }
        // Files were extracted despite the error, continue
      } else {
        throw error
      }
    }

    // Check if there's a nested mongodb/ directory
    const entries = await readdir(extractDir, { withFileTypes: true })
    const mongoDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'mongodb' || e.name.startsWith('mongodb-')),
    )

    if (mongoDir) {
      // Nested structure: move contents from mongodb/ to binPath
      const sourceDir = join(extractDir, mongoDir.name)
      const sourceEntries = await readdir(sourceDir, { withFileTypes: true })
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        try {
          await rename(sourcePath, destPath)
        } catch (error) {
          // Only fallback to cp for cross-device rename errors
          const err = error as NodeJS.ErrnoException
          if (err.code === 'EXDEV') {
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
          // Only fallback to cp for cross-device rename errors
          const err = error as NodeJS.ErrnoException
          if (err.code === 'EXDEV') {
            await cp(sourcePath, destPath, { recursive: true })
          } else {
            throw error
          }
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

    // Check if there's a nested mongodb/ directory
    const entries = await readdir(extractDir, { withFileTypes: true })
    const mongoDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'mongodb' || e.name.startsWith('mongodb-')),
    )

    if (mongoDir) {
      // Nested structure: move contents from mongodb/ to binPath
      const sourceDir = join(extractDir, mongoDir.name)
      const sourceEntries = await readdir(sourceDir, { withFileTypes: true })
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        try {
          await rename(sourcePath, destPath)
        } catch (error) {
          // Only fallback to cp for cross-device rename errors
          const err = error as NodeJS.ErrnoException
          if (err.code === 'EXDEV') {
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
          // Only fallback to cp for cross-device rename errors
          const err = error as NodeJS.ErrnoException
          if (err.code === 'EXDEV') {
            await cp(sourcePath, destPath, { recursive: true })
          } else {
            throw error
          }
        }
      }
    }
  }

  /**
   * Verify that MongoDB binaries are working
   */
  async verify(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'mongodb',
      version: fullVersion,
      platform,
      arch,
    })

    const ext = platform === 'win32' ? '.exe' : ''
    const mongodPath = join(binPath, 'bin', `mongod${ext}`)

    if (!existsSync(mongodPath)) {
      throw new Error(`MongoDB binary not found at ${binPath}/bin/`)
    }

    try {
      const { stdout } = await execAsync(`"${mongodPath}" --version`)
      // Extract version from output like "db version v7.0.28"
      const match = stdout.match(/db version v(\d+\.\d+\.\d+)/)
      const altMatch = !match ? stdout.match(/(\d+\.\d+\.\d+)/) : null
      const reportedVersion = match?.[1] ?? altMatch?.[1]

      if (!reportedVersion) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      // Check if major.minor versions match
      const expectedMajorMinor = version.split('.').slice(0, 2).join('.')
      const reportedMajorMinor = reportedVersion
        .split('.')
        .slice(0, 2)
        .join('.')
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
      throw new Error(`Failed to verify MongoDB binaries: ${err.message}`)
    }
  }

  /**
   * Get the path to a specific binary (mongod, mongosh, etc.)
   */
  getBinaryExecutable(
    version: string,
    platform: string,
    arch: string,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'mongodb',
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
        message: 'Using cached MongoDB binaries',
      })
      return paths.getBinaryPath({
        engine: 'mongodb',
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
  async delete(version: string, platform: string, arch: string): Promise<void> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'mongodb',
      version: fullVersion,
      platform,
      arch,
    })

    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }
  }
}

export const mongodbBinaryManager = new MongoDBBinaryManager()
