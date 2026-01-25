/**
 * Version migration utilities for detecting and updating outdated container versions
 *
 * Detects containers using versions that are no longer in the version maps
 * (e.g., from the zonky.io era) and offers to migrate them to currently
 * supported versions while preserving major version compatibility.
 */

import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { paths } from '../config/paths'
import { containerManager } from './container-manager'
import { platformService } from './platform-service'
import { Engine, isFileBasedEngine, type ContainerConfig } from '../types'

// Import version maps from all engines
import {
  POSTGRESQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as PG_MAJORS,
} from '../engines/postgresql/version-maps'
import {
  MYSQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as MYSQL_MAJORS,
} from '../engines/mysql/version-maps'
import {
  MARIADB_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as MARIADB_MAJORS,
} from '../engines/mariadb/version-maps'
import {
  MONGODB_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as MONGODB_MAJORS,
} from '../engines/mongodb/version-maps'
import {
  FERRETDB_VERSION_MAP,
  DOCUMENTDB_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as FERRET_MAJORS,
} from '../engines/ferretdb/version-maps'
import {
  REDIS_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as REDIS_MAJORS,
} from '../engines/redis/version-maps'
import {
  VALKEY_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as VALKEY_MAJORS,
} from '../engines/valkey/version-maps'
import {
  CLICKHOUSE_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as CH_MAJORS,
} from '../engines/clickhouse/version-maps'
import {
  QDRANT_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as QDRANT_MAJORS,
} from '../engines/qdrant/version-maps'
import {
  MEILISEARCH_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as MEILI_MAJORS,
} from '../engines/meilisearch/version-maps'

type VersionMapInfo = {
  versionMap: Record<string, string>
  majorVersions: readonly string[]
}

// Registry of version maps per engine
const VERSION_MAPS: Partial<Record<Engine, VersionMapInfo>> = {
  [Engine.PostgreSQL]: {
    versionMap: POSTGRESQL_VERSION_MAP,
    majorVersions: PG_MAJORS,
  },
  [Engine.MySQL]: { versionMap: MYSQL_VERSION_MAP, majorVersions: MYSQL_MAJORS },
  [Engine.MariaDB]: {
    versionMap: MARIADB_VERSION_MAP,
    majorVersions: MARIADB_MAJORS,
  },
  [Engine.MongoDB]: {
    versionMap: MONGODB_VERSION_MAP,
    majorVersions: MONGODB_MAJORS,
  },
  [Engine.FerretDB]: {
    versionMap: FERRETDB_VERSION_MAP,
    majorVersions: FERRET_MAJORS,
  },
  [Engine.Redis]: { versionMap: REDIS_VERSION_MAP, majorVersions: REDIS_MAJORS },
  [Engine.Valkey]: {
    versionMap: VALKEY_VERSION_MAP,
    majorVersions: VALKEY_MAJORS,
  },
  [Engine.ClickHouse]: {
    versionMap: CLICKHOUSE_VERSION_MAP,
    majorVersions: CH_MAJORS,
  },
  [Engine.Qdrant]: {
    versionMap: QDRANT_VERSION_MAP,
    majorVersions: QDRANT_MAJORS,
  },
  [Engine.Meilisearch]: {
    versionMap: MEILISEARCH_VERSION_MAP,
    majorVersions: MEILI_MAJORS,
  },
}

// Separate map for FerretDB backend (DocumentDB)
const DOCUMENTDB_INFO: VersionMapInfo = {
  versionMap: DOCUMENTDB_VERSION_MAP,
  majorVersions: ['17'],
}

export type OutdatedContainer = {
  container: ContainerConfig
  currentVersion: string
  targetVersion: string
  majorVersion: string
  field: 'version' | 'backendVersion'
}

/**
 * Find which major version a full version belongs to by checking prefixes
 * against SUPPORTED_MAJOR_VERSIONS.
 *
 * Different engines use different major version formats:
 * - PostgreSQL: Single digit (e.g., '17')
 * - MySQL: Two-part (e.g., '8.4')
 * - MariaDB: Two-part (e.g., '11.8')
 * - MongoDB: Two-part (e.g., '8.0')
 * - ClickHouse: Two-part YY.MM (e.g., '25.12')
 * - Redis/Valkey: Single digit (e.g., '7', '8')
 * - Qdrant/Meilisearch: Single digit (e.g., '1')
 *
 * @param engine - The database engine
 * @param version - Full version string (e.g., '17.2.0')
 * @returns Major version string or null if not found
 */
export function getMajorVersion(engine: Engine, version: string): string | null {
  const info = VERSION_MAPS[engine]
  if (!info) return null

  // Sort by length descending so "8.4" matches before "8"
  const sorted = [...info.majorVersions].sort((a, b) => b.length - a.length)
  for (const major of sorted) {
    if (version.startsWith(major + '.') || version === major) {
      return major
    }
  }
  return null
}

/**
 * Get the major version for FerretDB backend (DocumentDB).
 * Backend versions use format like "17-0.107.0" where "17" is the major.
 */
export function getDocumentDBMajorVersion(version: string): string | null {
  // Format: "17-0.107.0" -> major is "17"
  const dashIndex = version.indexOf('-')
  if (dashIndex > 0) {
    const major = version.substring(0, dashIndex)
    if (DOCUMENTDB_INFO.majorVersions.includes(major)) {
      return major
    }
  }
  return null
}

/**
 * Check if a version exists as a VALUE in the version map
 * (not just a key).
 *
 * @param engine - The database engine
 * @param version - Version string to check
 * @returns True if the version is a supported full version
 */
export function isVersionSupported(engine: Engine, version: string): boolean {
  const info = VERSION_MAPS[engine]
  if (!info) return false

  const supportedVersions = Object.values(info.versionMap)
  return supportedVersions.includes(version)
}

/**
 * Check if a DocumentDB backend version is supported.
 */
export function isDocumentDBVersionSupported(version: string): boolean {
  const supportedVersions = Object.values(DOCUMENTDB_INFO.versionMap)
  return supportedVersions.includes(version)
}

/**
 * Get the current full version for a major version.
 *
 * @param engine - The database engine
 * @param majorVersion - Major version (e.g., '17', '8.4')
 * @returns Current full version or null if not found
 */
export function getTargetVersion(
  engine: Engine,
  majorVersion: string,
): string | null {
  const info = VERSION_MAPS[engine]
  if (!info) return null

  return info.versionMap[majorVersion] || null
}

/**
 * Get the current full version for a DocumentDB major version.
 */
export function getDocumentDBTargetVersion(majorVersion: string): string | null {
  return DOCUMENTDB_INFO.versionMap[majorVersion] || null
}

/**
 * Find all containers that have outdated versions.
 * Returns containers whose versions are not in the current version maps.
 *
 * @returns Array of outdated container information
 */
export async function findOutdatedContainers(): Promise<OutdatedContainer[]> {
  const containers = await containerManager.list()
  const outdated: OutdatedContainer[] = []

  for (const container of containers) {
    const engine = container.engine as Engine

    // Skip file-based engines - they use simplified major versions (e.g., "3", "1")
    // that always resolve to current
    if (isFileBasedEngine(engine)) {
      continue
    }

    // Check main version
    if (!isVersionSupported(engine, container.version)) {
      const majorVersion = getMajorVersion(engine, container.version)
      if (majorVersion) {
        const targetVersion = getTargetVersion(engine, majorVersion)
        if (targetVersion && targetVersion !== container.version) {
          outdated.push({
            container,
            currentVersion: container.version,
            targetVersion,
            majorVersion,
            field: 'version',
          })
        }
      }
    }

    // Check FerretDB backend version
    if (engine === Engine.FerretDB && container.backendVersion) {
      if (!isDocumentDBVersionSupported(container.backendVersion)) {
        const majorVersion = getDocumentDBMajorVersion(container.backendVersion)
        if (majorVersion) {
          const targetVersion = getDocumentDBTargetVersion(majorVersion)
          if (targetVersion && targetVersion !== container.backendVersion) {
            outdated.push({
              container,
              currentVersion: container.backendVersion,
              targetVersion,
              majorVersion,
              field: 'backendVersion',
            })
          }
        }
      }
    }
  }

  return outdated
}

/**
 * Update a container's version in its config file.
 *
 * @param name - Container name
 * @param targetVersion - New version to set
 * @param field - Which field to update ('version' or 'backendVersion')
 */
export async function migrateContainerVersion(
  name: string,
  targetVersion: string,
  field: 'version' | 'backendVersion',
): Promise<void> {
  await containerManager.updateConfig(name, { [field]: targetVersion })
}

/**
 * Check if any containers are using a specific version.
 *
 * @param engine - The database engine
 * @param version - The version to check
 * @returns True if at least one container uses this version
 */
export async function isVersionInUse(
  engine: Engine,
  version: string,
): Promise<boolean> {
  const containers = await containerManager.list()
  return containers.some(
    (c) =>
      c.engine === engine &&
      (c.version === version || c.backendVersion === version),
  )
}

/**
 * Delete an old binary directory from ~/.spindb/bin/
 * Only deletes if no other containers are using this version.
 *
 * @param engine - The database engine
 * @param oldVersion - The old version to remove
 * @returns True if the binary was deleted, false if still in use or not found
 */
export async function deleteOldBinaryIfUnused(
  engine: Engine | string,
  oldVersion: string,
): Promise<boolean> {
  // Check if any containers still use this version
  if (await isVersionInUse(engine as Engine, oldVersion)) {
    return false
  }

  const platformInfo = platformService.getPlatformInfo()
  const binaryPath = paths.getBinaryPath({
    engine: engine as string,
    version: oldVersion,
    platform: platformInfo.platform,
    arch: platformInfo.arch,
  })

  if (existsSync(binaryPath)) {
    await rm(binaryPath, { recursive: true, force: true })
    return true
  }

  return false
}
