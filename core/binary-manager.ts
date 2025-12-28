import { createWriteStream, existsSync, createReadStream } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import unzipper from 'unzipper'
import { paths } from '../config/paths'
import { defaults } from '../config/defaults'
import { getEDBBinaryUrl } from '../engines/postgresql/edb-binary-urls'
import { normalizeVersion } from '../engines/postgresql/version-maps'
import {
  type Engine,
  type ProgressCallback,
  type InstalledBinary,
} from '../types'

const execAsync = promisify(exec)

export class BinaryManager {
  /**
   * Get the download URL for a PostgreSQL version
   *
   * - macOS/Linux: Uses zonky.io Maven Central binaries (JAR format)
   * - Windows: Uses EDB (EnterpriseDB) official binaries (ZIP format)
   */
  getDownloadUrl(version: string, platform: string, arch: string): string {
    const platformKey = `${platform}-${arch}`

    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
      throw new Error(`Unsupported platform: ${platformKey}`)
    }

    // Windows uses EDB binaries instead of zonky.io
    if (platform === 'win32') {
      const fullVersion = this.getFullVersion(version)
      return getEDBBinaryUrl(fullVersion)
    }

    // macOS/Linux use zonky.io binaries
    const zonkyPlatform = defaults.platformMappings[platformKey]

    if (!zonkyPlatform) {
      throw new Error(`Unsupported platform: ${platformKey}`)
    }

    // Zonky.io Maven Central URL pattern
    const fullVersion = this.getFullVersion(version)
    return `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${zonkyPlatform}/${fullVersion}/embedded-postgres-binaries-${zonkyPlatform}-${fullVersion}.jar`
  }

  /**
   * Convert version to full version format (e.g., "16" -> "16.11.0", "16.9" -> "16.9.0")
   *
   * Uses the shared version mappings from version-maps.ts.
   * Both zonky.io (macOS/Linux) and EDB (Windows) use the same PostgreSQL versions.
   */
  getFullVersion(version: string): string {
    return normalizeVersion(version)
  }

  /**
   * Check if binaries for a specific version are already installed
   * Uses full version for directory naming (e.g., postgresql-17.7.0-darwin-arm64)
   */
  async isInstalled(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === 'win32' ? '.exe' : ''
    const postgresPath = join(binPath, 'bin', `postgres${ext}`)
    return existsSync(postgresPath)
  }

  /**
   * List all installed PostgreSQL versions
   */
  async listInstalled(): Promise<InstalledBinary[]> {
    const binDir = paths.bin
    if (!existsSync(binDir)) {
      return []
    }

    const entries = await readdir(binDir, { withFileTypes: true })
    const installed: InstalledBinary[] = []

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('postgresql-')) {
        const parts = entry.name.split('-')
        if (parts.length >= 4) {
          installed.push({
            engine: parts[0] as Engine,
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
   * Download and extract PostgreSQL binaries
   *
   * - macOS/Linux (zonky.io): JAR files are ZIP archives containing a .txz (tar.xz) file.
   *   We need to: 1) unzip the JAR, 2) extract the .txz inside
   * - Windows (EDB): ZIP files extract directly to a PostgreSQL directory structure
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
      engine: 'postgresql',
      version: fullVersion,
      platform,
      arch,
    })
    const tempDir = join(paths.bin, `temp-${fullVersion}-${platform}-${arch}`)
    const archiveFile = join(
      tempDir,
      platform === 'win32' ? 'postgres.zip' : 'postgres.jar',
    )

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    try {
      // Download the archive
      onProgress?.({
        stage: 'downloading',
        message: 'Downloading PostgreSQL binaries...',
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
        // Windows: EDB ZIP extracts directly to PostgreSQL structure
        await this.extractWindowsBinaries(
          archiveFile,
          binPath,
          tempDir,
          onProgress,
        )
      } else {
        // macOS/Linux: zonky.io JAR contains .txz that needs secondary extraction
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
   * Extract Windows binaries from EDB ZIP file
   * EDB ZIPs contain a pgsql/ directory with bin/, lib/, share/ etc.
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

    // EDB ZIPs have a pgsql/ directory - find it and move contents to binPath
    const entries = await readdir(tempDir, { withFileTypes: true })
    const pgsqlDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'pgsql' || e.name.startsWith('postgresql-')),
    )

    if (pgsqlDir) {
      // Move contents from pgsql/ to binPath using cross-platform Node.js fs methods
      const sourceDir = join(tempDir, pgsqlDir.name)
      const sourceEntries = await readdir(sourceDir, { withFileTypes: true })
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        try {
          // Try rename first (works if on same filesystem)
          await rename(sourcePath, destPath)
        } catch {
          // Fallback to recursive copy for cross-filesystem moves
          await cp(sourcePath, destPath, { recursive: true })
        }
      }
    } else {
      // No pgsql directory, extract contents directly
      throw new Error(
        'Unexpected EDB archive structure - no pgsql directory found',
      )
    }
  }

  /**
   * Extract Unix binaries from zonky.io JAR file
   * JAR contains a .txz (tar.xz) file that needs secondary extraction
   */
  private async extractUnixBinaries(
    jarFile: string,
    binPath: string,
    tempDir: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    // Extract the JAR (it's a ZIP file) using unzipper
    onProgress?.({
      stage: 'extracting',
      message: 'Extracting binaries (step 1/2)...',
    })

    await new Promise<void>((resolve, reject) => {
      createReadStream(jarFile)
        .pipe(unzipper.Extract({ path: tempDir }))
        .on('close', resolve)
        .on('error', reject)
    })

    // Find the .txz file inside
    onProgress?.({
      stage: 'extracting',
      message: 'Extracting binaries (step 2/2)...',
    })

    const txzFile = await this.findTxzFile(tempDir)
    if (!txzFile) {
      throw new Error('Could not find .txz file in downloaded archive')
    }

    // Extract the tar.xz file (no strip-components since files are at root level)
    await execAsync(`tar -xJf "${txzFile}" -C "${binPath}"`)
  }

  /**
   * Recursively find a .txz or .tar.xz file in a directory
   */
  private async findTxzFile(dir: string): Promise<string | null> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (
        entry.isFile() &&
        (entry.name.endsWith('.txz') || entry.name.endsWith('.tar.xz'))
      ) {
        return fullPath
      }
      if (entry.isDirectory()) {
        const found = await this.findTxzFile(fullPath)
        if (found) return found
      }
    }
    return null
  }

  /**
   * Verify that PostgreSQL binaries are working
   */
  async verify(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'postgresql',
      version: fullVersion,
      platform,
      arch,
    })
    const ext = platform === 'win32' ? '.exe' : ''
    const postgresPath = join(binPath, 'bin', `postgres${ext}`)

    if (!existsSync(postgresPath)) {
      throw new Error(`PostgreSQL binary not found at ${postgresPath}`)
    }

    try {
      const { stdout } = await execAsync(`"${postgresPath}" --version`)
      // Extract version from output like "postgres (PostgreSQL) 16.9"
      const match = stdout.match(/postgres \(PostgreSQL\) ([\d.]+)/)
      if (!match) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      const reportedVersion = match[1]
      // Strip trailing .0 for comparison (16.9.0 -> 16.9, 16 -> 16)
      const stripTrailingZero = (v: string) => v.replace(/\.0$/, '')
      const expectedNormalized = stripTrailingZero(version)
      const reportedNormalized = stripTrailingZero(reportedVersion)

      // Check if versions match (after normalization)
      if (reportedNormalized === expectedNormalized) {
        return true
      }

      // Also accept if major versions match (e.g., expected "16", got "16.9")
      const expectedMajor = version.split('.')[0]
      const reportedMajor = reportedVersion.split('.')[0]
      if (expectedMajor === reportedMajor && version === expectedMajor) {
        return true
      }

      throw new Error(
        `Version mismatch: expected ${version}, got ${reportedVersion}`,
      )
    } catch (error) {
      const err = error as Error
      throw new Error(`Failed to verify PostgreSQL binaries: ${err.message}`)
    }
  }

  /**
   * Get the path to a specific binary (postgres, pg_ctl, psql, etc.)
   */
  getBinaryExecutable(
    version: string,
    platform: string,
    arch: string,
    binary: string,
  ): string {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: 'postgresql',
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
    let binPath: string

    if (await this.isInstalled(version, platform, arch)) {
      onProgress?.({
        stage: 'cached',
        message: 'Using cached PostgreSQL binaries',
      })
      binPath = paths.getBinaryPath({
        engine: 'postgresql',
        version: fullVersion,
        platform,
        arch,
      })
    } else {
      binPath = await this.download(version, platform, arch, onProgress)
    }

    // On Linux, zonky.io binaries don't include client tools (psql, pg_dump)
    // Download them separately from the PostgreSQL apt repository
    if (platform === 'linux') {
      await this.ensureClientTools(binPath, version, onProgress)
    }

    return binPath
  }

  /**
   * Ensure PostgreSQL client tools are available on Linux
   * Downloads from PostgreSQL apt repository if missing
   */
  private async ensureClientTools(
    binPath: string,
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const clientTools = ['psql', 'pg_dump', 'pg_restore', 'pg_dumpall']
    const binDir = join(binPath, 'bin')

    // Check if client tools already exist
    const missingTools = clientTools.filter(
      (tool) => !existsSync(join(binDir, tool)),
    )

    if (missingTools.length === 0) {
      return // All client tools already present
    }

    onProgress?.({
      stage: 'downloading',
      message: 'Downloading PostgreSQL client tools...',
    })

    const majorVersion = version.split('.')[0]
    const tempDir = join(paths.bin, `temp-client-${majorVersion}`)

    try {
      await mkdir(tempDir, { recursive: true })

      // Get the latest client package version from apt repository
      const debUrl = await this.getClientPackageUrl(majorVersion)
      const debFile = join(tempDir, 'postgresql-client.deb')

      // Download the .deb package
      const response = await fetch(debUrl)
      if (!response.ok) {
        throw new Error(`Failed to download client tools: ${response.status}`)
      }

      const fileStream = createWriteStream(debFile)
      // @ts-expect-error - response.body is ReadableStream
      await pipeline(response.body, fileStream)

      onProgress?.({
        stage: 'extracting',
        message: 'Extracting PostgreSQL client tools...',
      })

      // Extract .deb using ar (available on Linux)
      await execAsync(`ar -x "${debFile}"`, { cwd: tempDir })

      // Find and extract data.tar.xz or data.tar.zst
      const dataFile = await this.findDataTar(tempDir)
      if (!dataFile) {
        throw new Error('Could not find data archive in .deb package')
      }

      // Determine compression type and extract
      const extractDir = join(tempDir, 'extracted')
      await mkdir(extractDir, { recursive: true })

      if (dataFile.endsWith('.xz')) {
        await execAsync(`tar -xJf "${dataFile}" -C "${extractDir}"`)
      } else if (dataFile.endsWith('.zst')) {
        await execAsync(`tar --zstd -xf "${dataFile}" -C "${extractDir}"`)
      } else if (dataFile.endsWith('.gz')) {
        await execAsync(`tar -xzf "${dataFile}" -C "${extractDir}"`)
      } else {
        await execAsync(`tar -xf "${dataFile}" -C "${extractDir}"`)
      }

      // Copy client tools to the bin directory
      const clientBinDir = join(
        extractDir,
        'usr',
        'lib',
        'postgresql',
        majorVersion,
        'bin',
      )

      if (existsSync(clientBinDir)) {
        for (const tool of clientTools) {
          const srcPath = join(clientBinDir, tool)
          const destPath = join(binDir, tool)
          if (existsSync(srcPath) && !existsSync(destPath)) {
            await cp(srcPath, destPath)
            await chmod(destPath, 0o755)
          }
        }
      }

      onProgress?.({
        stage: 'complete',
        message: 'PostgreSQL client tools installed',
      })
    } finally {
      // Clean up temp directory
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  /**
   * Get the download URL for PostgreSQL client package from apt repository
   */
  private async getClientPackageUrl(majorVersion: string): Promise<string> {
    const baseUrl = 'https://apt.postgresql.org/pub/repos/apt/pool/main/p'
    const packageDir = `postgresql-${majorVersion}`
    const indexUrl = `${baseUrl}/${packageDir}/`

    try {
      const response = await fetch(indexUrl)
      if (!response.ok) {
        throw new Error(`Failed to fetch package index: ${response.status}`)
      }

      const html = await response.text()

      // Find the latest postgresql-client package for amd64
      // Pattern: postgresql-client-17_17.x.x-x.pgdg+1_amd64.deb
      const pattern = new RegExp(
        `href="(postgresql-client-${majorVersion}_[^"]+_amd64\\.deb)"`,
        'g',
      )

      const matches: string[] = []
      let match
      while ((match = pattern.exec(html)) !== null) {
        // Skip debug symbols and snapshot versions
        if (!match[1].includes('dbgsym') && !match[1].includes('~')) {
          matches.push(match[1])
        }
      }

      if (matches.length === 0) {
        throw new Error(
          `No client package found for PostgreSQL ${majorVersion}`,
        )
      }

      // Sort to get the latest version and return the URL
      matches.sort().reverse()
      const latestPackage = matches[0]

      return `${indexUrl}${latestPackage}`
    } catch (error) {
      const err = error as Error
      throw new Error(`Failed to get client package URL: ${err.message}`)
    }
  }

  /**
   * Find data.tar.* file in extracted .deb
   */
  private async findDataTar(dir: string): Promise<string | null> {
    const entries = await readdir(dir)
    for (const entry of entries) {
      if (entry.startsWith('data.tar')) {
        return join(dir, entry)
      }
    }
    return null
  }
}

export const binaryManager = new BinaryManager()
