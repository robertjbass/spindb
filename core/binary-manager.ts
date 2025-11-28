import { createWriteStream, existsSync } from 'fs'
import { mkdir, readdir, rm, chmod } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { paths } from '../config/paths'
import { defaults } from '../config/defaults'
import type { ProgressCallback, InstalledBinary } from '../types'

const execAsync = promisify(exec)

export class BinaryManager {
  /**
   * Get the download URL for a PostgreSQL version
   */
  getDownloadUrl(version: string, platform: string, arch: string): string {
    const platformKey = `${platform}-${arch}`
    const zonkyPlatform = defaults.platformMappings[platformKey]

    if (!zonkyPlatform) {
      throw new Error(`Unsupported platform: ${platformKey}`)
    }

    // Zonky.io Maven Central URL pattern
    const fullVersion = this.getFullVersion(version)
    return `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${zonkyPlatform}/${fullVersion}/embedded-postgres-binaries-${zonkyPlatform}-${fullVersion}.jar`
  }

  /**
   * Convert version to full version format (e.g., "16" -> "16.6.0", "16.9" -> "16.9.0")
   */
  getFullVersion(version: string): string {
    // Map major versions to latest stable patch versions
    // Updated from: https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-darwin-arm64v8/
    const versionMap: Record<string, string> = {
      '14': '14.20.0',
      '15': '15.15.0',
      '16': '16.11.0',
      '17': '17.7.0',
    }

    // If it's a major version only, use the map
    if (versionMap[version]) {
      return versionMap[version]
    }

    // Normalize to X.Y.Z format
    const parts = version.split('.')
    if (parts.length === 2) {
      return `${version}.0`
    }

    return version
  }

  /**
   * Check if binaries for a specific version are already installed
   */
  async isInstalled(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const binPath = paths.getBinaryPath({
      engine: 'postgresql',
      version,
      platform,
      arch,
    })
    const postgresPath = join(binPath, 'bin', 'postgres')
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
            engine: parts[0],
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
   * The zonky.io JAR files are ZIP archives containing a .txz (tar.xz) file.
   * We need to: 1) unzip the JAR, 2) extract the .txz inside
   */
  async download(
    version: string,
    platform: string,
    arch: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const url = this.getDownloadUrl(version, platform, arch)
    const binPath = paths.getBinaryPath({
      engine: 'postgresql',
      version,
      platform,
      arch,
    })
    const tempDir = join(paths.bin, `temp-${version}-${platform}-${arch}`)
    const jarFile = join(tempDir, 'postgres.jar')

    // Ensure directories exist
    await mkdir(paths.bin, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await mkdir(binPath, { recursive: true })

    try {
      // Download the JAR file
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

      const fileStream = createWriteStream(jarFile)
      // @ts-expect-error - response.body is ReadableStream
      await pipeline(response.body, fileStream)

      // Extract the JAR (it's a ZIP file)
      onProgress?.({
        stage: 'extracting',
        message: 'Extracting binaries (step 1/2)...',
      })

      await execAsync(`unzip -q -o "${jarFile}" -d "${tempDir}"`)

      // Find and extract the .txz file inside
      onProgress?.({
        stage: 'extracting',
        message: 'Extracting binaries (step 2/2)...',
      })

      const { stdout: findOutput } = await execAsync(
        `find "${tempDir}" -name "*.txz" -o -name "*.tar.xz" | head -1`,
      )
      const txzFile = findOutput.trim()

      if (!txzFile) {
        throw new Error('Could not find .txz file in downloaded archive')
      }

      // Extract the tar.xz file (no strip-components since files are at root level)
      await execAsync(`tar -xJf "${txzFile}" -C "${binPath}"`)

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

      return binPath
    } finally {
      // Clean up temp directory
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  /**
   * Verify that PostgreSQL binaries are working
   */
  async verify(
    version: string,
    platform: string,
    arch: string,
  ): Promise<boolean> {
    const binPath = paths.getBinaryPath({
      engine: 'postgresql',
      version,
      platform,
      arch,
    })
    const postgresPath = join(binPath, 'bin', 'postgres')

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
      // Normalize both versions for comparison (16.9.0 -> 16.9, 16 -> 16)
      const normalizeVersion = (v: string) => v.replace(/\.0$/, '')
      const expectedNormalized = normalizeVersion(version)
      const reportedNormalized = normalizeVersion(reportedVersion)

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
    const binPath = paths.getBinaryPath({
      engine: 'postgresql',
      version,
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
    if (await this.isInstalled(version, platform, arch)) {
      onProgress?.({
        stage: 'cached',
        message: 'Using cached PostgreSQL binaries',
      })
      return paths.getBinaryPath({
        engine: 'postgresql',
        version,
        platform,
        arch,
      })
    }

    return this.download(version, platform, arch, onProgress)
  }
}

export const binaryManager = new BinaryManager()
