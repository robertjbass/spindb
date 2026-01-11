import { createWriteStream, existsSync, createReadStream } from 'fs'
import { mkdir, readdir, rm, chmod, rename, cp } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import unzipper from 'unzipper'
import { paths } from '../config/paths'
import { getBinaryUrl } from '../engines/postgresql/binary-urls'
import { getEDBBinaryUrl } from '../engines/postgresql/edb-binary-urls'
import { normalizeVersion } from '../engines/postgresql/version-maps'
import {
  type Engine,
  type ProgressCallback,
  type InstalledBinary,
} from '../types'

const execAsync = promisify(exec)

/**
 * Execute a command using spawn with argument array (safer than shell interpolation)
 * Returns a promise that resolves on success or rejects on error/non-zero exit
 */
function spawnAsync(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options?.cwd,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // Set up timeout if specified
    if (options?.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGKILL')
        reject(
          new Error(
            `Command "${command} ${args.join(' ')}" timed out after ${options.timeout}ms`,
          ),
        )
      }, options.timeout)
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer)
    }

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      cleanup()
      if (timedOut) return // Already rejected by timeout
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
      cleanup()
      if (timedOut) return // Already rejected by timeout
      reject(new Error(`Failed to execute "${command}": ${err.message}`))
    })
  })
}

export class BinaryManager {
  /**
   * Get the download URL for a PostgreSQL version
   *
   * - macOS/Linux: Uses hostdb GitHub releases (tar.gz format)
   * - Windows: Uses EDB (EnterpriseDB) official binaries (ZIP format)
   */
  getDownloadUrl(version: string, platform: string, arch: string): string {
    const platformKey = `${platform}-${arch}`

    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
      throw new Error(`Unsupported platform: ${platformKey}`)
    }

    // Windows uses EDB binaries
    if (platform === 'win32') {
      const fullVersion = this.getFullVersion(version)
      return getEDBBinaryUrl(fullVersion)
    }

    // macOS/Linux use hostdb binaries
    const fullVersion = this.getFullVersion(version)
    return getBinaryUrl(fullVersion, platform, arch)
  }

  /**
   * Convert version to full version format (e.g., "16" -> "16.11.0", "16.9" -> "16.9.0")
   *
   * Uses the shared version mappings from version-maps.ts.
   * Both hostdb (macOS/Linux) and EDB (Windows) use the same PostgreSQL versions.
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

  // List all installed PostgreSQL versions
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
   * - macOS/Linux (hostdb): tar.gz files extract directly to PostgreSQL structure
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
      platform === 'win32' ? 'postgres.zip' : 'postgres.tar.gz',
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
        if (response.status === 404) {
          throw new Error(
            `PostgreSQL ${fullVersion} binaries not found (404). ` +
              `This version may have been removed from hostdb. ` +
              `Try a different version or check https://github.com/robertjbass/hostdb/releases`,
          )
        }
        throw new Error(
          `Failed to download PostgreSQL binaries: ${response.status} ${response.statusText}`,
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
        // macOS/Linux: hostdb tar.gz extracts directly to PostgreSQL structure
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

      // Fix hardcoded library paths on macOS (hostdb binaries have paths from build environment)
      if (platform === 'darwin') {
        await this.fixMacOSLibraryPaths(binPath, onProgress)
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
   * Extract Unix binaries from hostdb tar.gz file
   * Handles both flat structure (bin/, lib/, share/ at root) and
   * nested structure (postgresql/bin/, postgresql/lib/, etc.)
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

    // Extract tar.gz to temp directory first to check structure
    // Using spawnAsync with argument array to avoid command injection
    const extractDir = join(tempDir, 'extract')
    await mkdir(extractDir, { recursive: true })
    await spawnAsync('tar', ['-xzf', tarFile, '-C', extractDir])

    // Check if there's a nested postgresql/ directory
    const entries = await readdir(extractDir, { withFileTypes: true })
    const postgresDir = entries.find(
      (e) => e.isDirectory() && e.name === 'postgresql',
    )

    if (postgresDir) {
      // Nested structure: move contents from postgresql/ to binPath
      const sourceDir = join(extractDir, 'postgresql')
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
   * Fix hardcoded library paths in macOS binaries
   *
   * hostdb binaries are built in GitHub Actions and contain hardcoded paths
   * like /Users/runner/work/hostdb/hostdb/install/postgresql/lib/libpq.5.dylib
   * that don't exist on the user's machine.
   *
   * This method uses install_name_tool to rewrite those paths to use
   * @loader_path-relative references that work on any machine.
   */
  private async fixMacOSLibraryPaths(
    binPath: string,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    onProgress?.({
      stage: 'configuring',
      message: 'Fixing library paths for macOS...',
    })

    const binDir = join(binPath, 'bin')
    if (!existsSync(binDir)) {
      return
    }

    const binaries = await readdir(binDir)

    // Pattern to match hostdb build paths (GitHub Actions runner paths)
    const hostdbPathPattern = /\/Users\/runner\/work\/hostdb\/[^/]+\/install\/postgresql\/lib\//

    for (const binary of binaries) {
      const binaryPath = join(binDir, binary)

      try {
        // Use otool to get the library dependencies
        const { stdout } = await spawnAsync('otool', ['-L', binaryPath])

        // Parse otool output to find hostdb library references
        // Format: "\tlibrary_path (compatibility version X, current version Y)"
        const lines = stdout.split('\n')

        for (const line of lines) {
          const match = line.match(/^\t([^\s]+)/)
          if (!match) continue

          const libPath = match[1]

          // Check if this is a hostdb build path that needs fixing
          if (hostdbPathPattern.test(libPath)) {
            // Extract just the library filename (e.g., "libpq.5.dylib")
            const libName = libPath.split('/').pop()
            if (!libName) continue

            // Create the new relative path
            const newPath = `@loader_path/../lib/${libName}`

            // Use install_name_tool to change the path
            try {
              await spawnAsync('install_name_tool', [
                '-change',
                libPath,
                newPath,
                binaryPath,
              ])
            } catch {
              // Some binaries may not be writable or may not need fixing
              // Continue with other binaries
            }
          }
        }
      } catch {
        // otool may fail on non-Mach-O files (scripts, etc.)
        // Continue with other binaries
      }
    }
  }

  // Verify that PostgreSQL binaries are working
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

  // Get the path to a specific binary (postgres, pg_ctl, psql, etc.)
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

  // Ensure binaries are available, downloading if necessary
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

    // On Linux, hostdb binaries may not include client tools (psql, pg_dump)
    // Download them separately from the PostgreSQL apt repository if missing
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
      // Using spawnAsync with argument array to avoid command injection
      await spawnAsync('ar', ['-x', debFile], { cwd: tempDir })

      // Find and extract data.tar.xz or data.tar.zst
      const dataFile = await this.findDataTar(tempDir)
      if (!dataFile) {
        throw new Error('Could not find data archive in .deb package')
      }

      // Determine compression type and extract
      // Using spawnAsync with argument array to avoid command injection
      const extractDir = join(tempDir, 'extracted')
      await mkdir(extractDir, { recursive: true })

      if (dataFile.endsWith('.xz')) {
        await spawnAsync('tar', ['-xJf', dataFile, '-C', extractDir])
      } else if (dataFile.endsWith('.zst')) {
        await spawnAsync('tar', ['--zstd', '-xf', dataFile, '-C', extractDir])
      } else if (dataFile.endsWith('.gz')) {
        await spawnAsync('tar', ['-xzf', dataFile, '-C', extractDir])
      } else {
        await spawnAsync('tar', ['-xf', dataFile, '-C', extractDir])
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

  // Get the download URL for PostgreSQL client package from apt repository
  private async getClientPackageUrl(majorVersion: string): Promise<string> {
    const baseUrl = 'https://apt.postgresql.org/pub/repos/apt/pool/main/p'
    const packageDir = `postgresql-${majorVersion}`
    const indexUrl = `${baseUrl}/${packageDir}/`

    let html = ''
    try {
      const response = await fetch(indexUrl)
      if (!response.ok) {
        throw new Error(
          `Failed to fetch package index from ${indexUrl}: HTTP ${response.status} ${response.statusText}`,
        )
      }

      html = await response.text()

      // Validate that we got HTML content (basic sanity check)
      if (!html.includes('<html') && !html.includes('<!DOCTYPE')) {
        throw new Error(
          `Unexpected response from ${indexUrl}: content does not appear to be HTML`,
        )
      }

      // Find the latest postgresql-client package for amd64
      // Pattern: postgresql-client-17_17.x.x-x.pgdg+1_amd64.deb
      const pattern = new RegExp(
        `href="(postgresql-client-${majorVersion}_[^"]+_amd64\\.deb)"`,
        'g',
      )

      const matches: string[] = []
      let match
      while ((match = pattern.exec(html)) !== null) {
        // Validate that the capture group exists
        if (match[1]) {
          // Skip debug symbols and snapshot versions
          if (!match[1].includes('dbgsym') && !match[1].includes('~')) {
            matches.push(match[1])
          }
        }
      }

      if (matches.length === 0) {
        // Provide diagnostic information for debugging
        const htmlSnippet = html.substring(0, 500).replace(/\n/g, ' ')
        throw new Error(
          `No client package found for PostgreSQL ${majorVersion} at ${indexUrl}. ` +
            `Expected pattern: postgresql-client-${majorVersion}_*_amd64.deb. ` +
            `HTML snippet: ${htmlSnippet}...`,
        )
      }

      // Sort by semver to get the latest version
      // Filename pattern: postgresql-client-17_17.2.0-1.pgdg+1_amd64.deb
      // Extract version (e.g., "17.2.0-1") and compare numerically
      const parseVersion = (filename: string): number[] => {
        // Extract version after the underscore: "17.2.0-1.pgdg..."
        const versionMatch = filename.match(/_(\d+)\.(\d+)\.(\d+)-(\d+)/)
        if (versionMatch) {
          return [
            parseInt(versionMatch[1], 10),
            parseInt(versionMatch[2], 10),
            parseInt(versionMatch[3], 10),
            parseInt(versionMatch[4], 10),
          ]
        }
        return [0, 0, 0, 0]
      }

      matches.sort((a, b) => {
        const vA = parseVersion(a)
        const vB = parseVersion(b)
        for (let i = 0; i < 4; i++) {
          if (vA[i] !== vB[i]) return vB[i] - vA[i]
        }
        return 0
      })
      const latestPackage = matches[0]

      return `${indexUrl}${latestPackage}`
    } catch (error) {
      const err = error as Error
      // If the error already has context, just rethrow it
      if (err.message.includes(indexUrl)) {
        throw error
      }
      // Otherwise, add context about the URL we were trying to parse
      throw new Error(
        `Failed to get client package URL from ${indexUrl}: ${err.message}`,
      )
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
