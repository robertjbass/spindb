/**
 * MySQL Binary Manager
 *
 * Handles downloading, extracting, and managing MySQL binaries from hostdb.
 */

import {
  BaseServerBinaryManager,
  type ServerBinaryManagerConfig,
} from '../../core/base-server-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class MySQLBinaryManager extends BaseServerBinaryManager {
  protected readonly config: ServerBinaryManagerConfig = {
    engine: Engine.MySQL,
    engineName: 'mysql',
    displayName: 'MySQL',
    serverBinaryNames: ['mysqld'],
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
}

export const mysqlBinaryManager = new MySQLBinaryManager()
