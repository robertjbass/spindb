/**
 * MariaDB Binary Manager
 *
 * Handles downloading, extracting, and managing MariaDB binaries from hostdb.
 * Similar to PostgreSQL binary manager but tailored for MariaDB.
 */

import { createWriteStream, existsSync, createReadStream } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import unzipper from 'unzipper'
import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import type { ProgressCallback, InstalledBinary } from '../../types'

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

export class MariaDBBinaryManager {
  /**
   * Get the download URL for a MariaDB version
   *
   * Uses hostdb GitHub releases for all platforms.
   */
  getDownloadUrl(version: string, platform: string, arch: string): string {
    const platformKey = `${platform}-${arch}`

    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
      throw new Error(`Unsupported platform: ${platformKey}`)
    }

    const fullVersion = this.getFullVersion(version)
    return getBinaryUrl(fullVersion, platform, arch)
  }

  /**
   * Convert version to full version format (e.g., "11.8" -> "11.8.5")
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
      engine: 'mariadb',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === 'win32' ? '.exe' : ''
    // MariaDB uses mariadbd or mysqld depending on the build
    const mariadbPath = join(binPath, 'bin', `mariadbd${ext}`)
    const mysqldPath = join(binPath, 'bin', `mysqld${ext}`)
    return existsSync(mariadbPath) || existsSync(mysqldPath)
  }

  /**
   * List all installed MariaDB versions
   */
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('mariadb-')) {
        const parts = entry.name.split('-')
        if (parts.length >= 4) {
          installed.push({
            engine: 'mariadb' as InstalledBinary['engine'],
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
   * Download and extract MariaDB binaries
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
      engine: 'mariadb',
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(paths.bin, `temp-mariadb-${fullVersion}-${platform}-${arch}`)
    const archiveFile = join(
      tempDir,
      platform === 'win32' ? 'mariadb.zip' : 'mariadb.tar.gz',
    )

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    try {
      // Download the archive
      onProgress?.({
        stage: 'downloading',
        message: 'Downloading MariaDB binaries...',
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

      // Make binaries executable (on Unix-like systems)
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
   * Extract Windows binaries from ZIP file
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

    // Extract ZIP to temp directory first
    await new Promise<void>((resolve, reject) => {
      createReadStream(zipFile)
        .pipe(unzipper.Extract({ path: tempDir }))
        .on('close', resolve)
        .on('error', reject)
    })

    // hostdb ZIPs have a mariadb/ directory - find it and move contents to binPath
    const entries = await readdir(tempDir, { withFileTypes: true })
    const mariadbDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'mariadb' || e.name.startsWith('mariadb-')),
    )

    if (mariadbDir) {
      // Move contents from mariadb/ to binPath
      const sourceDir = join(tempDir, mariadbDir.name)
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
      throw new Error(
        'Unexpected archive structure - no mariadb directory found',
      )
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

    // Check if there's a nested mariadb/ directory
    const entries = await readdir(extractDir, { withFileTypes: true })
    const mariadbDir = entries.find(
      (e) => e.isDirectory() && (e.name === 'mariadb' || e.name.startsWith('mariadb-')),
    )

    if (mariadbDir) {
      // Nested structure: move contents from mariadb/ to binPath
      const sourceDir = join(extractDir, mariadbDir.name)
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
   * Verify that MariaDB binaries are working
   */
  async verify(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'mariadb',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === 'win32' ? '.exe' : ''

    // Try mariadbd first, then mysqld (hostdb uses mariadbd)
    let serverPath = join(binPath, 'bin', `mariadbd${ext}`)
    if (!existsSync(serverPath)) {
      serverPath = join(binPath, 'bin', `mysqld${ext}`)
    }

    if (!existsSync(serverPath)) {
      throw new Error(`MariaDB binary not found at ${binPath}/bin/`)
    }

    try {
      const { stdout } = await execAsync(`"${serverPath}" --version`)
      // Extract version from output like "mariadbd  Ver 11.8.5-MariaDB"
      const match = stdout.match(/Ver\s+([\d.]+)/)
      if (!match) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      const reportedVersion = match[1]
      // Strip trailing .0 for comparison
      const stripTrailingZero = (v: string) => v.replace(/\.0$/, '')
      const expectedNormalized = stripTrailingZero(fullVersion)
      const reportedNormalized = stripTrailingZero(reportedVersion)

      // Check if versions match
      if (reportedNormalized === expectedNormalized) {
        return true
      }

      // Also accept if major versions match (e.g., expected "11.8", got "11.8.5")
      const expectedMajor = version.split('.').slice(0, 2).join('.')
      const reportedMajor = reportedVersion.split('.').slice(0, 2).join('.')
      if (expectedMajor === reportedMajor) {
        return true
      }

      throw new Error(
        `Version mismatch: expected ${version}, got ${reportedVersion}`,
      )
    } catch (error) {
      const err = error as Error
      throw new Error(`Failed to verify MariaDB binaries: ${err.message}`)
    }
  }

  /**
   * Get the path to a specific binary (mariadbd, mysql, mysqldump, etc.)
   */
  getBinaryExecutable(
    version: string,
    platform: string,
    arch: string,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'mariadb',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === 'win32' ? '.exe' : ''
    return join(binPath, 'bin', `${binary}${ext}`)
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
        message: 'Using cached MariaDB binaries',
      })
      return paths.getBinaryPath({
        engine: 'mariadb',
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
      engine: 'mariadb',
      version: fullVersion,
      platform,
      arch,
    })

    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }
  }
}

export const mariadbBinaryManager = new MariaDBBinaryManager()
