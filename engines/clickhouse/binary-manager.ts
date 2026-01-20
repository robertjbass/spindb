/**
 * ClickHouse Binary Manager
 *
 * Handles downloading, extracting, and managing ClickHouse binaries from hostdb.
 * ClickHouse uses a single unified binary that handles server, client, and local modes.
 *
 * Extends BaseServerBinaryManager with ClickHouse-specific overrides:
 * - No Windows support (throws on Windows extraction)
 * - YY.MM version matching in verify()
 * - Flat archive handling (moves clickhouse binary to bin/)
 */

import { existsSync } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { paths } from '../../config/paths'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { logDebug } from '../../core/error-handler'
import { moveEntry } from '../../core/fs-error-utils'
import {
  BaseServerBinaryManager,
  type ServerBinaryManagerConfig,
} from '../../core/base-server-binary-manager'
import { Engine, type Platform, type Arch, type ProgressCallback } from '../../types'

const execAsync = promisify(exec)

class ClickHouseBinaryManager extends BaseServerBinaryManager {
  protected readonly config: ServerBinaryManagerConfig = {
    engine: Engine.ClickHouse,
    engineName: 'clickhouse',
    displayName: 'ClickHouse',
    serverBinaryNames: ['clickhouse'],
  }

  protected getBinaryUrlFromModule(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return getBinaryUrl(version, platform, arch)
  }

  protected normalizeVersionFromModule(version: string): string {
    return normalizeVersion(version)
  }

  /**
   * ClickHouse does not have Windows binaries on hostdb.
   * Override to throw a clear error.
   */
  protected override async extractWindowsBinaries(
    _zipFile: string,
    _binPath: string,
    _tempDir: string,
    _onProgress?: ProgressCallback,
  ): Promise<void> {
    throw new Error(
      'ClickHouse binaries are not available for Windows. ' +
        'ClickHouse is only supported on macOS and Linux.',
    )
  }

  /**
   * Override to handle ClickHouse's archive structure.
   * ClickHouse archives may have a flat structure where the binary is at the root,
   * not in a bin/ subdirectory. This moves the clickhouse binary to bin/.
   */
  protected override async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // Check for a clickhouse subdirectory
    const clickhouseDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'clickhouse' || e.name.startsWith('clickhouse-')),
    )

    const sourceDir = clickhouseDir
      ? join(extractDir, clickhouseDir.name)
      : extractDir
    const sourceEntries = clickhouseDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    // Check if source has a bin/ subdirectory
    const hasBinDir = sourceEntries.some(
      (e) => e.isDirectory() && e.name === 'bin',
    )

    if (hasBinDir) {
      // Standard structure: move all entries as-is (preserves bin/ subdirectory)
      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        const destPath = join(binPath, entry.name)
        await moveEntry(sourcePath, destPath)
      }
    } else {
      // Flat structure: create bin/ and move binaries there
      const destBinDir = join(binPath, 'bin')
      await mkdir(destBinDir, { recursive: true })

      for (const entry of sourceEntries) {
        const sourcePath = join(sourceDir, entry.name)
        // Check if it's an executable (no extension on Unix, starts with 'clickhouse')
        const isExecutable =
          entry.isFile() &&
          !entry.name.includes('.') &&
          entry.name.startsWith('clickhouse')
        const destPath = isExecutable
          ? join(destBinDir, entry.name)
          : join(binPath, entry.name)
        await moveEntry(sourcePath, destPath)
      }
    }
  }

  /**
   * Override verification for ClickHouse's YY.MM version format.
   * ClickHouse uses `clickhouse client --version` and has 4-part versions (YY.MM.patch.build).
   */
  override async verify(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<boolean> {
    const fullVersion = this.getFullVersion(version)
    const binPath = paths.getBinaryPath({
      engine: this.config.engineName,
      version: fullVersion,
      platform,
      arch,
    })

    const clickhousePath = join(binPath, 'bin', 'clickhouse')

    if (!existsSync(clickhousePath)) {
      throw new Error(`ClickHouse binary not found at ${binPath}/bin/`)
    }

    try {
      const { stdout, stderr } = await execAsync(
        `"${clickhousePath}" client --version`,
      )
      // Log stderr if present (may contain benign warnings about config, etc.)
      if (stderr && stderr.trim()) {
        logDebug(
          `clickhouse client stderr during version check: ${stderr.trim()}`,
        )
      }
      // Extract version from output like "ClickHouse client version 25.12.3.21 (official build)"
      const match = stdout.match(/version\s+(\d+\.\d+\.\d+\.\d+)/)
      const altMatch = !match ? stdout.match(/(\d+\.\d+\.\d+\.\d+)/) : null
      const reportedVersion = match?.[1] ?? altMatch?.[1]

      if (!reportedVersion) {
        throw new Error(`Could not parse version from: ${stdout.trim()}`)
      }

      // Check if major versions match (YY.MM format)
      const expectedMajor = version.split('.').slice(0, 2).join('.')
      const reportedMajor = reportedVersion.split('.').slice(0, 2).join('.')
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
      const err = error as Error & { stderr?: string; code?: number }
      // Include stderr and exit code in error message for better debugging
      const details = [err.message]
      if (err.stderr) details.push(`stderr: ${err.stderr.trim()}`)
      if (err.code !== undefined) details.push(`exit code: ${err.code}`)
      throw new Error(
        `Failed to verify ClickHouse binaries: ${details.join(', ')}`,
      )
    }
  }
}

export const clickhouseBinaryManager = new ClickHouseBinaryManager()
