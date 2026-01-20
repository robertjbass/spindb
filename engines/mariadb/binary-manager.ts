/**
 * MariaDB Binary Manager
 *
 * Handles downloading, extracting, and managing MariaDB binaries from hostdb.
 * Similar to PostgreSQL binary manager but tailored for MariaDB.
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
import { spawnAsync, extractWindowsArchive } from '../../core/spawn-utils'
import { Engine, Platform, type Arch, type ProgressCallback, type InstalledBinary, isValidPlatform, isValidArch } from '../../types'

const execAsync = promisify(exec)

export class MariaDBBinaryManager {
  /**
   * Get the download URL for a MariaDB version
   *
   * Uses hostdb GitHub releases for all platforms.
   */
  getDownloadUrl(version: string, platform: Platform, arch: Arch): string {
    const fullVersion = this.getFullVersion(version)
    return getBinaryUrl(fullVersion, platform, arch)
  }

  // Convert version to full version format (e.g., "11.8" -> "11.8.5")
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
      engine: 'mariadb',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === Platform.Win32 ? '.exe' : ''
    // MariaDB uses mariadbd or mysqld depending on the build
    const mariadbPath = join(binPath, 'bin', `mariadbd${ext}`)
    const mysqldPath = join(binPath, 'bin', `mysqld${ext}`)
    return existsSync(mariadbPath) || existsSync(mysqldPath)
  }

  // List all installed MariaDB versions
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith('mariadb-')) continue

      // Parse from the end to handle versions with dashes (e.g., mariadb-11.8.5-rc1-darwin-arm64)
      const rest = entry.name.slice('mariadb-'.length)
      const parts = rest.split('-')
      if (parts.length < 3) continue

      const arch = parts.pop()!
      const platform = parts.pop()!
      const version = parts.join('-')

      if (version && isValidPlatform(platform) && isValidArch(arch)) {
        installed.push({
          engine: Engine.MariaDB,
          version,
          platform,
          arch,
        })
      }
    }

    return installed
  }

  // Download and extract MariaDB binaries
  async download(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    let success = false
    const fullVersion = this.getFullVersion(version)
    const url = this.getDownloadUrl(version, platform, arch)
    const binPath = paths.getBinaryPath({
      engine: 'mariadb',
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(
      paths.bin,
      `temp-mariadb-${fullVersion}-${platform}-${arch}`,
    )
    const archiveFile = join(
      tempDir,
      platform === Platform.Win32 ? 'mariadb.zip' : 'mariadb.tar.gz',
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
            `MariaDB ${fullVersion} binaries not found (404). ` +
              `This version may have been removed from hostdb. ` +
              `Try a different version or check https://github.com/robertjbass/hostdb/releases`,
          )
        }
        throw new Error(
          `Failed to download MariaDB binaries: ${response.status} ${response.statusText}`,
        )
      }

      const fileStream = createWriteStream(archiveFile)
      // @ts-expect-error - response.body is ReadableStream
      await pipeline(response.body, fileStream)

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

      // Make binaries executable (on Unix-like systems)
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

  // Extract Windows binaries from ZIP file
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

    // Extract ZIP using PowerShell Expand-Archive
    await extractWindowsArchive(zipFile, tempDir)

    await this.moveExtractedEntries(tempDir, binPath)
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

  // Move extracted entries from extractDir to binPath, handling nested mariadb/ directories
  private async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })
    const mariadbDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'mariadb' || e.name.startsWith('mariadb-')),
    )

    const sourceDir = mariadbDir
      ? join(extractDir, mariadbDir.name)
      : extractDir
    const entriesToMove = mariadbDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    for (const entry of entriesToMove) {
      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(binPath, entry.name)
      try {
        await rename(sourcePath, destPath)
      } catch (error) {
        // Fallback to cp for cross-device (EXDEV) or permission (EPERM) errors
        const err = error as NodeJS.ErrnoException
        if (err.code === 'EXDEV' || err.code === 'EPERM') {
          await cp(sourcePath, destPath, { recursive: true })
        } else {
          throw error
        }
      }
    }
  }

  // Verify that MariaDB binaries are working
  async verify(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'mariadb',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === Platform.Win32 ? '.exe' : ''

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

  // Get the path to a specific binary (mariadbd, mysql, mysqldump, etc.)
  getBinaryExecutable(
    version: string,
    platform: Platform,
    arch: Arch,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'mariadb',
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

  // Delete installed binaries for a specific version
  async delete(version: string, platform: Platform, arch: Arch): Promise<void> {
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
