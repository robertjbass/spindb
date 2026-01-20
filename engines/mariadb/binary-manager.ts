/**
 * MariaDB Binary Manager
 *
 * Handles downloading, extracting, and managing MariaDB binaries from hostdb.
 * MariaDB binaries may use either 'mariadbd' or 'mysqld' as the server binary name,
 * so both are checked in order of preference.
 */

import {
  BaseServerBinaryManager,
  type ServerBinaryManagerConfig,
} from '../../core/base-server-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class MariaDBBinaryManager extends BaseServerBinaryManager {
  protected readonly config: ServerBinaryManagerConfig = {
    engine: Engine.MariaDB,
    engineName: 'mariadb',
    displayName: 'MariaDB',
    // MariaDB may use either mariadbd (newer) or mysqld (legacy)
    serverBinaryNames: ['mariadbd', 'mysqld'],
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
    // Extract version from output like "mariadbd  Ver 11.8.5-MariaDB"
    const match = stdout.match(/Ver\s+([\d.]+)/)
    return match?.[1] ?? null
  }
}

export const mariadbBinaryManager = new MariaDBBinaryManager()
