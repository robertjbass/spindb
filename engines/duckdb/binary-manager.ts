/**
 * DuckDB Binary Manager
 *
 * Handles downloading, extracting, and managing DuckDB binaries from hostdb.
 * Unlike other engines, DuckDB is an embedded database (not a server).
 * This manager handles the duckdb CLI tool.
 */

import {
  BaseEmbeddedBinaryManager,
  type EmbeddedBinaryManagerConfig,
} from '../../core/base-embedded-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class DuckDBBinaryManager extends BaseEmbeddedBinaryManager {
  protected readonly config: EmbeddedBinaryManagerConfig = {
    engine: Engine.DuckDB,
    engineName: 'duckdb',
    displayName: 'DuckDB',
    primaryBinary: 'duckdb',
    executableNames: ['duckdb'],
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
    // Extract version from output like "v1.4.3 abcdef123"
    const match = stdout.match(/v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
}

export const duckdbBinaryManager = new DuckDBBinaryManager()
