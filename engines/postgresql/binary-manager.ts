/**
 * PostgreSQL Binary Manager
 *
 * Handles downloading, extracting, and managing PostgreSQL binaries from hostdb.
 * PostgreSQL binaries include both server (postgres, pg_ctl, initdb) and client
 * tools (psql, pg_dump, pg_restore, pg_basebackup).
 *
 * All platforms (macOS, Linux, Windows) download from hostdb - Windows uses
 * EDB binaries that are uploaded to hostdb for consistency.
 */

import {
  BaseServerBinaryManager,
  type ServerBinaryManagerConfig,
} from '../../core/base-server-binary-manager'
import { paths } from '../../config/paths'
import { spawnAsync } from '../../core/spawn-utils'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, Platform, type Arch } from '../../types'

class PostgreSQLBinaryManager extends BaseServerBinaryManager {
  protected readonly config: ServerBinaryManagerConfig = {
    engine: Engine.PostgreSQL,
    engineName: 'postgresql',
    displayName: 'PostgreSQL',
    serverBinaryNames: ['postgres'],
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

  protected parseVersionFromOutput(stdout: string): string | null {
    // Extract version from output like "postgres (PostgreSQL) 18.1"
    const match = stdout.match(/postgres \(PostgreSQL\) ([\d.]+)/)
    return match?.[1] ?? null
  }

  /**
   * Verify that PostgreSQL binaries are working
   *
   * PostgreSQL outputs version in format: "postgres (PostgreSQL) X.Y" or
   * "postgres (PostgreSQL) X.Y - Percona Server for PostgreSQL X.Y.Z"
   * This differs from MySQL/MariaDB's "Ver X.Y.Z" format.
   */
  async verify(
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
    const ext = platform === Platform.Win32 ? '.exe' : ''

    const serverPath = this.findServerBinaryPath(binPath, ext)

    if (!serverPath) {
      throw new Error(
        `${this.config.displayName} binary not found at ${binPath}/bin/`,
      )
    }

    let stdout: string
    try {
      const result = await spawnAsync(serverPath, ['--version'])
      stdout = result.stdout
    } catch (error) {
      // Only wrap spawn/OS errors, not our validation errors
      const err = error as Error
      throw new Error(
        `Failed to verify ${this.config.displayName} binaries: ${err.message}`,
      )
    }

    const reportedVersion = this.parseVersionFromOutput(stdout)
    if (!reportedVersion) {
      throw new Error(`Could not parse version from: ${stdout.trim()}`)
    }
    const expectedNormalized = this.stripTrailingZero(fullVersion)
    const reportedNormalized = this.stripTrailingZero(reportedVersion)

    // Check if versions match (e.g., "18.1.0" vs "18.1")
    if (reportedNormalized === expectedNormalized) {
      return true
    }

    // Also accept if major.minor matches (e.g., expected "18.1.0", got "18.1")
    const expectedMajorMinor = fullVersion.split('.').slice(0, 2).join('.')
    const reportedMajorMinor = reportedVersion.split('.').slice(0, 2).join('.')
    if (expectedMajorMinor === reportedMajorMinor) {
      return true
    }

    throw new Error(
      `Version mismatch: expected ${fullVersion}, got ${reportedVersion}`,
    )
  }
}

export const postgresqlBinaryManager = new PostgreSQLBinaryManager()
