/**
 * MongoDB Binary Manager
 *
 * Handles downloading, extracting, and managing MongoDB binaries from hostdb.
 * Extends BaseDocumentBinaryManager with MongoDB-specific configuration.
 */

import {
  BaseDocumentBinaryManager,
  type DocumentBinaryManagerConfig,
} from '../../core/base-document-binary-manager'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion } from './version-maps'
import { Engine, type Platform, type Arch } from '../../types'

class MongoDBBinaryManager extends BaseDocumentBinaryManager {
  protected readonly config: DocumentBinaryManagerConfig = {
    engine: Engine.MongoDB,
    engineName: 'mongodb',
    displayName: 'MongoDB',
    serverBinary: 'mongod',
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
    // Extract version from output like "db version v7.0.28"
    const match = stdout.match(/db version v(\d+\.\d+\.\d+)/)
    if (match) {
      return match[1]
    }
    // Fallback: try to match any semver-like version
    const altMatch = stdout.match(/(\d+\.\d+\.\d+)/)
    return altMatch?.[1] ?? null
  }
}

export const mongodbBinaryManager = new MongoDBBinaryManager()
