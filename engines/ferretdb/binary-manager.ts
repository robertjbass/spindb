/**
 * FerretDB Composite Binary Manager
 *
 * Handles downloading and managing FerretDB binaries:
 *
 * v2 (default): Two binaries required:
 *   1. ferretdb - The MongoDB-compatible Go proxy
 *   2. postgresql-documentdb - PostgreSQL 17 with DocumentDB extension
 *
 * v1: Two binaries, but backend is shared:
 *   1. ferretdb - The MongoDB-compatible Go proxy
 *   2. Plain PostgreSQL - Managed by postgresqlBinaryManager (shared with standalone PG containers)
 *
 * This is a composite manager that coordinates the installation of both
 * binaries, which are required for FerretDB to function.
 */

import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { paths } from '../../config/paths'
import { spawnAsync, extractWindowsArchive } from '../../core/spawn-utils'
import { isRenameFallbackError } from '../../core/fs-error-utils'
import { logDebug } from '../../core/error-handler'
import { fetchWithRegistryFallback } from '../../core/hostdb-client'
import {
  Engine,
  Platform,
  type Arch,
  type ProgressCallback,
  type InstalledBinary,
  isValidPlatform,
  isValidArch,
} from '../../types'
import {
  normalizeVersion,
  normalizeDocumentDBVersion,
  DEFAULT_DOCUMENTDB_VERSION,
  DEFAULT_V1_POSTGRESQL_VERSION,
  isV1,
} from './version-maps'
import {
  isPlatformSupported,
  getFerretDBBinaryUrl,
  getDocumentDBBinaryUrl,
} from './binary-urls'
import { postgresqlBinaryManager } from '../postgresql/binary-manager'

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Result of ensuring both FerretDB binaries are installed
 */
export type FerretDBBinaryPaths = {
  ferretdbPath: string // Path to ferretdb binary directory
  backendPath: string // Path to backend binary directory (postgresql-documentdb for v2, postgresql for v1)
}

/**
 * FerretDB Composite Binary Manager
 *
 * Manages the installation of both required binaries for FerretDB.
 */
class FerretDBCompositeBinaryManager {
  /**
   * Check if the current platform supports FerretDB
   * @param version - Optional version to check platform support for (v1 supports Windows, v2 does not)
   */
  isPlatformSupported(
    platform: Platform,
    arch: Arch,
    version?: string,
  ): boolean {
    return isPlatformSupported(platform, arch, version)
  }

  /**
   * Get the full version string for a FerretDB version
   */
  getFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  /**
   * Get the full version string for a postgresql-documentdb version
   */
  getFullDocumentDBVersion(version: string): string {
    return normalizeDocumentDBVersion(version)
  }

  /**
   * Check if FerretDB binaries are installed for a specific version
   */
  async isInstalled(
    version: string,
    platform: Platform,
    arch: Arch,
    backendVersion: string = DEFAULT_DOCUMENTDB_VERSION,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)

    // Check FerretDB proxy
    const ferretdbPath = this.getFerretDBBinaryPath(fullVersion, platform, arch)
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const ferretdbBinary = join(ferretdbPath, 'bin', `ferretdb${ext}`)
    if (!existsSync(ferretdbBinary)) {
      return false
    }

    // Check backend
    if (isV1(version)) {
      // v1: check plain PostgreSQL via postgresqlBinaryManager
      return postgresqlBinaryManager.isInstalled(
        DEFAULT_V1_POSTGRESQL_VERSION,
        platform,
        arch,
      )
    }

    // v2: check postgresql-documentdb
    const fullBackendVersion = this.getFullDocumentDBVersion(backendVersion)
    const documentdbPath = this.getDocumentDBBinaryPath(
      fullBackendVersion,
      platform,
      arch,
    )
    const pgCtlExt = platform === Platform.Win32 ? '.exe' : ''
    const pgCtl = join(documentdbPath, 'bin', `pg_ctl${pgCtlExt}`)
    if (!existsSync(pgCtl)) {
      return false
    }

    return true
  }

  /**
   * Get the path where FerretDB binaries would be installed
   * @param version - Full normalized version (e.g., "2.7.0", not "2" or "2.7")
   * @param platform - Operating system
   * @param arch - Architecture
   */
  getFerretDBBinaryPath(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return join(paths.bin, `ferretdb-${version}-${platform}-${arch}`)
  }

  /**
   * Get the path where postgresql-documentdb binaries would be installed
   * @param version - Full normalized version (e.g., "17-0.107.0", not "17")
   * @param platform - Operating system
   * @param arch - Architecture
   */
  getDocumentDBBinaryPath(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return join(
      paths.bin,
      `postgresql-documentdb-${version}-${platform}-${arch}`,
    )
  }

  /**
   * Get environment variables needed to run postgresql-documentdb binaries
   *
   * On Linux, the bundled binaries need LD_LIBRARY_PATH set to find libpq.so
   * and other shared libraries in the lib/ directory.
   *
   * On macOS, the binaries use @loader_path which doesn't need env vars.
   * On Windows, DLLs are found via PATH or same directory.
   *
   * @param version - Full normalized version (e.g., "17-0.107.0", not "17")
   * @param platform - Operating system
   * @param arch - Architecture
   */
  getDocumentDBSpawnEnv(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Record<string, string> | undefined {
    // Only Linux needs LD_LIBRARY_PATH
    if (platform !== Platform.Linux) {
      return undefined
    }

    const documentdbPath = this.getDocumentDBBinaryPath(version, platform, arch)
    const libPath = join(documentdbPath, 'lib')

    // Prepend our lib path to any existing LD_LIBRARY_PATH
    const existingLdPath = process.env['LD_LIBRARY_PATH'] || ''
    const newLdPath = existingLdPath ? `${libPath}:${existingLdPath}` : libPath

    return {
      LD_LIBRARY_PATH: newLdPath,
    }
  }

  /**
   * Get the backend binary directory path for a FerretDB version.
   * For v1: returns the plain PostgreSQL binary path
   * For v2: returns the postgresql-documentdb binary path
   *
   * @param ferretdbVersion - FerretDB version (e.g., "1.24.2" or "2.7.0")
   * @param backendVersion - Backend version (PostgreSQL version for v1, DocumentDB version for v2)
   * @param platform - Operating system
   * @param arch - Architecture
   */
  getBackendBinaryPath(
    ferretdbVersion: string,
    backendVersion: string,
    platform: Platform,
    arch: Arch,
  ): string {
    if (isV1(ferretdbVersion)) {
      const pgFullVersion = postgresqlBinaryManager.getFullVersion(
        backendVersion || DEFAULT_V1_POSTGRESQL_VERSION,
      )
      return paths.getBinaryPath({
        engine: 'postgresql',
        version: pgFullVersion,
        platform,
        arch,
      })
    }

    const fullBackendVersion = this.getFullDocumentDBVersion(
      backendVersion || DEFAULT_DOCUMENTDB_VERSION,
    )
    return this.getDocumentDBBinaryPath(fullBackendVersion, platform, arch)
  }

  /**
   * Get environment variables needed to run backend binaries.
   * For v1: delegates to PostgreSQL's standard env (usually none needed)
   * For v2: delegates to getDocumentDBSpawnEnv
   *
   * @param ferretdbVersion - FerretDB version
   * @param backendVersion - Backend version
   * @param platform - Operating system
   * @param arch - Architecture
   */
  getBackendSpawnEnv(
    ferretdbVersion: string,
    backendVersion: string,
    platform: Platform,
    arch: Arch,
  ): Record<string, string> | undefined {
    if (isV1(ferretdbVersion)) {
      // Plain PostgreSQL doesn't need special env vars on most platforms
      // Linux may need LD_LIBRARY_PATH
      if (platform !== Platform.Linux) {
        return undefined
      }
      const pgPath = this.getBackendBinaryPath(
        ferretdbVersion,
        backendVersion,
        platform,
        arch,
      )
      const libPath = join(pgPath, 'lib')
      const existingLdPath = process.env['LD_LIBRARY_PATH'] || ''
      const newLdPath = existingLdPath
        ? `${libPath}:${existingLdPath}`
        : libPath
      return { LD_LIBRARY_PATH: newLdPath }
    }

    const fullBackendVersion = this.getFullDocumentDBVersion(
      backendVersion || DEFAULT_DOCUMENTDB_VERSION,
    )
    return this.getDocumentDBSpawnEnv(fullBackendVersion, platform, arch)
  }

  /**
   * List all installed FerretDB versions
   */
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []
    const prefix = 'ferretdb-'

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith(prefix)) continue

      // Split from end to handle versions with dashes
      // Format: ferretdb-{version}-{platform}-{arch}
      const rest = entry.name.slice(prefix.length)
      const parts = rest.split('-')
      if (parts.length < 3) continue

      const arch = parts.pop()!
      const platform = parts.pop()!
      const version = parts.join('-')

      if (version && isValidPlatform(platform) && isValidArch(arch)) {
        installed.push({
          engine: Engine.FerretDB,
          version,
          platform,
          arch,
        })
      }
    }

    return installed
  }

  /**
   * Ensure both FerretDB binaries are installed
   *
   * @param version - FerretDB version
   * @param platform - Operating system
   * @param arch - Architecture
   * @param onProgress - Progress callback
   * @param backendVersion - Backend version (postgresql-documentdb for v2, PostgreSQL major for v1)
   * @returns Paths to both binary directories
   */
  async ensureInstalled(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
    backendVersion?: string,
  ): Promise<FerretDBBinaryPaths> {
    const fullVersion = this.getFullVersion(version)
    const v1 = isV1(version)
    const effectiveBackendVersion =
      backendVersion ||
      (v1 ? DEFAULT_V1_POSTGRESQL_VERSION : DEFAULT_DOCUMENTDB_VERSION)

    // Check if already installed
    if (
      await this.isInstalled(version, platform, arch, effectiveBackendVersion)
    ) {
      onProgress?.({
        stage: 'cached',
        message: 'Using cached FerretDB binaries',
      })
      return {
        ferretdbPath: this.getFerretDBBinaryPath(fullVersion, platform, arch),
        backendPath: this.getBackendBinaryPath(
          fullVersion,
          effectiveBackendVersion,
          platform,
          arch,
        ),
      }
    }

    if (v1) {
      return this.ensureInstalledV1(
        version,
        platform,
        arch,
        onProgress,
        effectiveBackendVersion,
      )
    }

    return this.ensureInstalledV2(
      version,
      platform,
      arch,
      onProgress,
      effectiveBackendVersion,
    )
  }

  /**
   * Ensure v1 FerretDB binaries are installed (proxy + plain PostgreSQL)
   */
  private async ensureInstalledV1(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
    backendVersion: string = DEFAULT_V1_POSTGRESQL_VERSION,
  ): Promise<FerretDBBinaryPaths> {
    // Download FerretDB v1 proxy
    const ferretdbPath = await this.downloadFerretDB(
      version,
      platform,
      arch,
      onProgress,
    )

    // Ensure plain PostgreSQL is installed via postgresqlBinaryManager
    onProgress?.({
      stage: 'downloading',
      message: 'Ensuring PostgreSQL backend is available...',
    })
    const backendPath = await postgresqlBinaryManager.ensureInstalled(
      backendVersion,
      platform,
      arch,
      onProgress,
    )

    return { ferretdbPath, backendPath }
  }

  /**
   * Ensure v2 FerretDB binaries are installed (proxy + postgresql-documentdb)
   */
  private async ensureInstalledV2(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
    backendVersion: string = DEFAULT_DOCUMENTDB_VERSION,
  ): Promise<FerretDBBinaryPaths> {
    const fullVersion = this.getFullVersion(version)

    // Check if FerretDB is already installed (DocumentDB might be missing)
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const ferretdbBinaryPath = this.getFerretDBBinaryPath(
      fullVersion,
      platform,
      arch,
    )
    const ferretdbBinary = join(ferretdbBinaryPath, 'bin', `ferretdb${ext}`)
    const ferretdbAlreadyInstalled = existsSync(ferretdbBinary)

    // Download both binaries - ensure atomicity by cleaning up FerretDB if DocumentDB fails
    // (only if FerretDB was newly downloaded in this call)
    const ferretdbPath = await this.downloadFerretDB(
      version,
      platform,
      arch,
      onProgress,
    )

    let backendPath: string
    try {
      backendPath = await this.downloadDocumentDB(
        backendVersion,
        platform,
        arch,
        onProgress,
      )
    } catch (error) {
      // Only clean up FerretDB if it was newly downloaded (not pre-existing)
      if (!ferretdbAlreadyInstalled) {
        onProgress?.({
          stage: 'error',
          message:
            'postgresql-documentdb download failed, cleaning up FerretDB...',
        })
        await rm(ferretdbPath, { recursive: true, force: true }).catch(() => {})
      }
      throw error
    }

    return { ferretdbPath, backendPath }
  }

  /**
   * Download FerretDB proxy binary
   */
  private async downloadFerretDB(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullVersion(version)
    const binPath = this.getFerretDBBinaryPath(fullVersion, platform, arch)

    // Check if FerretDB is already installed
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const ferretdbBinary = join(binPath, 'bin', `ferretdb${ext}`)
    if (existsSync(ferretdbBinary)) {
      onProgress?.({
        stage: 'cached',
        message: 'FerretDB proxy already installed',
      })
      return binPath
    }

    const url = getFerretDBBinaryUrl(version, platform, arch)
    const tempDir = join(
      paths.bin,
      `temp-ferretdb-${fullVersion}-${platform}-${arch}`,
    )
    const archiveExt = platform === Platform.Win32 ? 'zip' : 'tar.gz'
    const archiveFile = join(tempDir, `ferretdb.${archiveExt}`)

    // Clean up any partial installation
    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
    try {
      onProgress?.({
        stage: 'downloading',
        message: 'Downloading FerretDB proxy...',
      })

      await this.downloadArchive(url, archiveFile, 'FerretDB')

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

      // On macOS, re-sign binaries to fix code signature issues
      if (platform === Platform.Darwin) {
        onProgress?.({
          stage: 'signing',
          message: 'Re-signing FerretDB binaries for macOS...',
        })
        await this.resignMacOSBinaries(binPath)
      }

      // Verify the installation
      onProgress?.({ stage: 'verifying', message: 'Verifying FerretDB...' })
      await this.verifyFerretDB(fullVersion, platform, arch)

      success = true
      return binPath
    } finally {
      // Clean up temp directory
      await rm(tempDir, { recursive: true, force: true })
      // Clean up binPath on failure
      if (!success) {
        await rm(binPath, { recursive: true, force: true })
      }
    }
  }

  /**
   * Download postgresql-documentdb backend binary
   */
  private async downloadDocumentDB(
    version: string,
    platform: Platform,
    arch: Arch,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const fullVersion = this.getFullDocumentDBVersion(version)
    const binPath = this.getDocumentDBBinaryPath(fullVersion, platform, arch)

    // Check if postgresql-documentdb is already installed
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const pgCtl = join(binPath, 'bin', `pg_ctl${ext}`)
    if (existsSync(pgCtl)) {
      onProgress?.({
        stage: 'cached',
        message: 'postgresql-documentdb already installed',
      })
      return binPath
    }

    const url = getDocumentDBBinaryUrl(version, platform, arch)
    const tempDir = join(
      paths.bin,
      `temp-postgresql-documentdb-${fullVersion}-${platform}-${arch}`,
    )
    const archiveFile = join(tempDir, 'postgresql-documentdb.tar.gz')

    // Clean up any partial installation
    if (existsSync(binPath)) {
      await rm(binPath, { recursive: true, force: true })
    }

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    let success = false
    try {
      onProgress?.({
        stage: 'downloading',
        message: 'Downloading postgresql-documentdb backend...',
      })

      await this.downloadArchive(url, archiveFile, 'postgresql-documentdb')

      await this.extractUnixBinaries(archiveFile, binPath, tempDir, onProgress)

      // Make binaries executable
      const binaryDir = join(binPath, 'bin')
      if (existsSync(binaryDir)) {
        const binaries = await readdir(binaryDir)
        for (const binary of binaries) {
          await chmod(join(binaryDir, binary), 0o755)
        }
      }

      // On macOS, re-sign binaries and libraries to fix code signature issues
      // (signatures become invalid after download due to quarantine/Gatekeeper)
      if (platform === Platform.Darwin) {
        onProgress?.({
          stage: 'signing',
          message: 'Re-signing binaries for macOS...',
        })
        await this.resignMacOSBinaries(binPath)
      }

      // Verify the installation
      onProgress?.({
        stage: 'verifying',
        message: 'Verifying postgresql-documentdb...',
      })
      await this.verifyDocumentDB(fullVersion, platform, arch)

      success = true
      return binPath
    } finally {
      // Clean up temp directory
      await rm(tempDir, { recursive: true, force: true })
      // Clean up binPath on failure
      if (!success) {
        await rm(binPath, { recursive: true, force: true })
      }
    }
  }

  /**
   * Download an archive file
   */
  private async downloadArchive(
    url: string,
    archiveFile: string,
    displayName: string,
  ): Promise<void> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

    try {
      const response = await fetchWithRegistryFallback(url, {
        signal: controller.signal,
      })

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `${displayName} binaries not found (404). ` +
              'This version may have been removed from hostdb. ' +
              'Try a different version or check https://registry.layerbase.host',
          )
        }
        throw new Error(
          `Failed to download ${displayName} binaries: ${response.status} ${response.statusText}`,
        )
      }

      if (!response.body) {
        throw new Error(
          `Download failed: response has no body (status ${response.status})`,
        )
      }

      const fileStream = createWriteStream(archiveFile)
      try {
        const nodeStream = Readable.fromWeb(response.body)
        await pipeline(nodeStream, fileStream)
      } catch (pipelineError) {
        fileStream.destroy()
        throw pipelineError
      }
    } catch (error) {
      const err = error as Error
      if (err.name === 'AbortError') {
        throw new Error(
          `Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000 / 60} minutes. ` +
            'Check your network connection and try again.',
        )
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
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

    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir, { recursive: true })

    try {
      await spawnAsync('tar', ['-xzf', tarFile, '-C', extractDir])
    } catch (error) {
      const err = error as Error & { code?: string | number }

      // Check if extraction actually succeeded despite the error
      const entries = await readdir(extractDir)
      if (entries.length === 0) {
        throw new Error(
          `Extraction failed: ${err.message}${err.code ? ` (code: ${err.code})` : ''}`,
        )
      }

      logDebug('FerretDB extraction recovered from tar error', {
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
   *
   * FerretDB v1 supports Windows. v2 does not (postgresql-documentdb startup issues).
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

    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir, { recursive: true })

    await extractWindowsArchive(zipFile, extractDir)
    await this.moveExtractedEntries(extractDir, binPath)
  }

  /**
   * Move extracted entries from extractDir to binPath
   */
  private async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // Look for engine directory (ferretdb-* or postgresql-documentdb-*)
    const engineDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'ferretdb' ||
          e.name.startsWith('ferretdb-') ||
          e.name === 'postgresql-documentdb' ||
          e.name.startsWith('postgresql-documentdb-')),
    )

    const sourceDir = engineDir ? join(extractDir, engineDir.name) : extractDir
    const sourceEntries = engineDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    for (const entry of sourceEntries) {
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
   * Verify FerretDB binary installation
   */
  private async verifyFerretDB(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<void> {
    const binPath = this.getFerretDBBinaryPath(version, platform, arch)
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const ferretdbBinary = join(binPath, 'bin', `ferretdb${ext}`)

    if (!existsSync(ferretdbBinary)) {
      throw new Error(`FerretDB binary not found at ${binPath}/bin/`)
    }

    // FerretDB v1 hostdb builds panic on --version due to missing version.txt
    // at build time. For v1, just verify the binary exists (checked above).
    if (isV1(version)) {
      return
    }

    try {
      const { stdout } = await spawnAsync(ferretdbBinary, ['--version'])
      const match = stdout.match(
        /(?:ferretdb\s+)?(?:version\s+)?v?(\d+\.\d+\.\d+)/,
      )
      if (!match) {
        throw new Error(
          `Could not parse FerretDB version from: ${stdout.trim()}`,
        )
      }

      const reportedVersion = match[1]
      const expectedMajor = version.split('.')[0]
      const reportedMajor = reportedVersion.split('.')[0]

      if (expectedMajor !== reportedMajor) {
        throw new Error(
          `Version mismatch: expected ${version}, got ${reportedVersion}`,
        )
      }
    } catch (error) {
      const err = error as Error
      throw new Error(`Failed to verify FerretDB binary: ${err.message}`)
    }
  }

  /**
   * Verify postgresql-documentdb binary installation
   * Tests both pg_ctl and initdb since initdb is used during container creation
   */
  private async verifyDocumentDB(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<void> {
    const binPath = this.getDocumentDBBinaryPath(version, platform, arch)
    const ext = platform === Platform.Win32 ? '.exe' : ''
    const pgCtl = join(binPath, 'bin', `pg_ctl${ext}`)
    const initdb = join(binPath, 'bin', `initdb${ext}`)

    if (!existsSync(pgCtl)) {
      throw new Error(
        `postgresql-documentdb binary not found at ${binPath}/bin/`,
      )
    }

    if (!existsSync(initdb)) {
      throw new Error(
        `initdb not found at ${binPath}/bin/ - required for container initialization`,
      )
    }

    // Get spawn env for Linux (LD_LIBRARY_PATH)
    const spawnEnv = this.getDocumentDBSpawnEnv(version, platform, arch)

    // Verify pg_ctl works
    try {
      const { stdout } = await spawnAsync(pgCtl, ['--version'], {
        env: spawnEnv,
      })
      // Expected output: "pg_ctl (PostgreSQL) 17.x.x"
      const match = stdout.match(/PostgreSQL[)\s]+(\d+)/)
      if (!match) {
        throw new Error(
          `Could not parse PostgreSQL version from: ${stdout.trim()}`,
        )
      }

      // version is like "17-0.107.0", extract PostgreSQL major version
      const expectedPgMajor = version.split('-')[0]
      const reportedPgMajor = match[1]

      if (expectedPgMajor !== reportedPgMajor) {
        throw new Error(
          `PostgreSQL version mismatch: expected ${expectedPgMajor}, got ${reportedPgMajor}`,
        )
      }
    } catch (error) {
      const err = error as Error & { code?: string | number | null }

      // Check for library loading issues (common on macOS/Linux with hostdb binaries)
      if (
        !err.code ||
        err.code === 'ENOENT' ||
        err.message.includes('dyld') ||
        err.message.includes('GLIBC')
      ) {
        throw new Error(
          `postgresql-documentdb pg_ctl failed to execute. This is likely due to missing or incompatible libraries.\n` +
            `The hostdb binaries may need to be rebuilt with proper rpath settings.\n` +
            `See: https://github.com/robertjbass/hostdb/issues\n` +
            `Original error: ${err.message || 'Process killed (library loading failed)'}`,
        )
      }

      throw new Error(
        `Failed to verify postgresql-documentdb pg_ctl: ${err.message}`,
      )
    }

    // Verify initdb works (critical for container creation)
    try {
      const { stdout } = await spawnAsync(initdb, ['--version'], {
        env: spawnEnv,
      })
      // Expected output: "initdb (PostgreSQL) 17.x.x"
      const match = stdout.match(/PostgreSQL[)\s]+(\d+)/)
      if (!match) {
        throw new Error(`Could not parse initdb version from: ${stdout.trim()}`)
      }
      logDebug(`initdb verified: ${stdout.trim()}`)
    } catch (error) {
      const err = error as Error & { code?: string | number | null }

      // Check for library loading issues
      if (
        !err.code ||
        err.code === 'ENOENT' ||
        err.message.includes('dyld') ||
        err.message.includes('GLIBC')
      ) {
        throw new Error(
          `postgresql-documentdb initdb failed to execute. This is likely due to missing or incompatible libraries.\n` +
            `initdb is required for FerretDB container initialization.\n` +
            `The hostdb binaries may need to be rebuilt with proper rpath settings.\n` +
            `See: https://github.com/robertjbass/hostdb/issues\n` +
            `Original error: ${err.message || 'Process killed (library loading failed)'}`,
        )
      }

      throw new Error(
        `Failed to verify postgresql-documentdb initdb: ${err.message}`,
      )
    }
  }

  /**
   * Delete installed binaries for a specific version
   *
   * For v1: Only deletes the FerretDB proxy. Plain PostgreSQL binaries are shared
   * with standalone PostgreSQL containers and should NOT be deleted.
   *
   * For v2: Deletes both FerretDB proxy and postgresql-documentdb backend.
   */
  async delete(
    version: string,
    platform: Platform,
    arch: Arch,
    backendVersion: string = DEFAULT_DOCUMENTDB_VERSION,
  ): Promise<void> {
    const fullVersion = this.getFullVersion(version)

    const ferretdbPath = this.getFerretDBBinaryPath(fullVersion, platform, arch)
    if (existsSync(ferretdbPath)) {
      await rm(ferretdbPath, { recursive: true, force: true })
    }

    // v1: Don't delete shared PostgreSQL binaries (cascadeDelete: false)
    if (isV1(version)) {
      logDebug(
        'Skipping PostgreSQL backend deletion for FerretDB v1 (shared with standalone PG containers)',
      )
      return
    }

    // v2: Delete postgresql-documentdb backend
    const fullBackendVersion = this.getFullDocumentDBVersion(backendVersion)
    const documentdbPath = this.getDocumentDBBinaryPath(
      fullBackendVersion,
      platform,
      arch,
    )
    if (existsSync(documentdbPath)) {
      await rm(documentdbPath, { recursive: true, force: true })
    }
  }

  /**
   * Re-sign macOS binaries with ad-hoc signature
   *
   * Downloaded binaries may have invalid signatures due to Gatekeeper quarantine.
   * Re-signing with ad-hoc signature (-s -) allows them to run without issues.
   */
  private async resignMacOSBinaries(binPath: string): Promise<void> {
    // Sign all dylibs first (binaries depend on them)
    const libDir = join(binPath, 'lib')
    if (existsSync(libDir)) {
      const libs = await readdir(libDir)
      for (const lib of libs) {
        if (lib.endsWith('.dylib')) {
          const libPath = join(libDir, lib)
          try {
            await spawnAsync('codesign', [
              '--force',
              '--deep',
              '-s',
              '-',
              libPath,
            ])
          } catch {
            // Ignore signing errors for individual libs
            logDebug(`Failed to sign ${lib}, continuing...`)
          }
        }
      }

      // Also sign libs in postgresql/ subdirectory if it exists
      const pgLibDir = join(libDir, 'postgresql')
      if (existsSync(pgLibDir)) {
        const pgLibs = await readdir(pgLibDir)
        for (const lib of pgLibs) {
          if (lib.endsWith('.dylib')) {
            const libPath = join(pgLibDir, lib)
            try {
              await spawnAsync('codesign', [
                '--force',
                '--deep',
                '-s',
                '-',
                libPath,
              ])
            } catch {
              logDebug(`Failed to sign ${lib}, continuing...`)
            }
          }
        }
      }
    }

    // Sign all binaries
    const binDir = join(binPath, 'bin')
    if (existsSync(binDir)) {
      const binaries = await readdir(binDir)
      for (const binary of binaries) {
        const binaryPath = join(binDir, binary)
        try {
          await spawnAsync('codesign', [
            '--force',
            '--deep',
            '-s',
            '-',
            binaryPath,
          ])
        } catch {
          // Ignore signing errors for individual binaries
          logDebug(`Failed to sign ${binary}, continuing...`)
        }
      }
    }
  }
}

export const ferretdbBinaryManager = new FerretDBCompositeBinaryManager()
