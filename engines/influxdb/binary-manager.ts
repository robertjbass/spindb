/**
 * InfluxDB Binary Manager
 *
 * Handles downloading, extracting, and managing InfluxDB binaries from hostdb.
 * Extends BaseBinaryManager for shared download/extraction logic.
 *
 * InfluxDB 3.x archives extract to a flat `influxdb/` directory:
 *   influxdb/
 *   ├── influxdb3           (server binary)
 *   ├── python/             (bundled Python runtime)
 *   │   └── lib/
 *   │       └── libpython3.13.dylib
 *   ├── LICENSE-APACHE
 *   └── LICENSE-MIT
 *
 * The binary uses @executable_path/python/lib/libpython3.13.dylib, so python/
 * must be in the same directory as the binary. We reorganize to:
 *   bin/
 *   ├── influxdb3
 *   └── python/             (co-located for @executable_path resolution)
 */

import { mkdir, readdir } from 'fs/promises'
import { join } from 'path'
import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { moveEntry } from '../../core/fs-error-utils'
import { logDebug } from '../../core/error-handler'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class InfluxDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.InfluxDB,
    engineName: 'influxdb',
    displayName: 'InfluxDB',
    serverBinary: 'influxdb3',
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
    // Extract version from output like "influxdb3 3.8.0" or "InfluxDB 3 Edge v3.8.0"
    const match = stdout.match(/v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }

  /**
   * Override moveExtractedEntries to co-locate python/ with the binary.
   *
   * The influxdb3 binary references @executable_path/python/lib/libpython3.13.dylib,
   * so the python/ directory must be inside bin/ alongside the binary.
   * The default flat-structure handler would put python/ at binPath/python/ instead
   * of binPath/bin/python/, causing a dylib load failure.
   */
  protected override async moveExtractedEntries(
    extractDir: string,
    binPath: string,
  ): Promise<void> {
    const entries = await readdir(extractDir, { withFileTypes: true })

    // Find the influxdb directory (e.g., "influxdb" or "influxdb-3.8.0")
    const influxDir = entries.find(
      (e) =>
        e.isDirectory() &&
        (e.name === 'influxdb' || e.name.startsWith('influxdb-')),
    )

    const sourceDir = influxDir ? join(extractDir, influxDir.name) : extractDir
    const sourceEntries = influxDir
      ? await readdir(sourceDir, { withFileTypes: true })
      : entries

    // Create bin/ directory
    const destBinDir = join(binPath, 'bin')
    await mkdir(destBinDir, { recursive: true })

    for (const entry of sourceEntries) {
      const sourcePath = join(sourceDir, entry.name)

      if (entry.name === 'influxdb3' || entry.name === 'influxdb3.exe') {
        // Server binary → bin/
        await moveEntry(sourcePath, join(destBinDir, entry.name))
      } else if (entry.name === 'python') {
        // Python runtime → bin/python/ (must be co-located with binary for @executable_path)
        await moveEntry(sourcePath, join(destBinDir, 'python'))
      } else {
        // Licenses, metadata, etc. → binPath root
        await moveEntry(sourcePath, join(binPath, entry.name))
      }
    }

    logDebug('InfluxDB binaries reorganized with python/ co-located in bin/')
  }
}

export const influxdbBinaryManager = new InfluxDBBinaryManager()
