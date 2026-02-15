/**
 * hostdb Version Sync Verification Tests
 *
 * Verifies that SpinDB's version-maps.ts files are in sync with
 * hostdb's releases.json (the source of truth for available versions).
 *
 * This test requires network access to fetch releases.json from GitHub.
 * It runs as part of CI to catch version mismatches early.
 */

import { describe, it, before } from 'node:test'
import {
  fetchHostdbReleases,
  getEngineReleases,
  type HostdbReleasesData,
} from '../../core/hostdb-client'

// Import version maps from all engines
import { POSTGRESQL_VERSION_MAP } from '../../engines/postgresql/version-maps'
import { MYSQL_VERSION_MAP } from '../../engines/mysql/version-maps'
import { MARIADB_VERSION_MAP } from '../../engines/mariadb/version-maps'
import { MONGODB_VERSION_MAP } from '../../engines/mongodb/version-maps'
import { REDIS_VERSION_MAP } from '../../engines/redis/version-maps'
import { SQLITE_VERSION_MAP } from '../../engines/sqlite/version-maps'
import { CLICKHOUSE_VERSION_MAP } from '../../engines/clickhouse/version-maps'
import { COCKROACHDB_VERSION_MAP } from '../../engines/cockroachdb/version-maps'
import { COUCHDB_VERSION_MAP } from '../../engines/couchdb/version-maps'
import { DUCKDB_VERSION_MAP } from '../../engines/duckdb/version-maps'
import {
  FERRETDB_VERSION_MAP,
  DOCUMENTDB_VERSION_MAP,
} from '../../engines/ferretdb/version-maps'
import { MEILISEARCH_VERSION_MAP } from '../../engines/meilisearch/version-maps'
import { QDRANT_VERSION_MAP } from '../../engines/qdrant/version-maps'
import { QUESTDB_VERSION_MAP } from '../../engines/questdb/version-maps'
import { SURREALDB_VERSION_MAP } from '../../engines/surrealdb/version-maps'
import { TYPEDB_VERSION_MAP } from '../../engines/typedb/version-maps'
import { VALKEY_VERSION_MAP } from '../../engines/valkey/version-maps'
import { INFLUXDB_VERSION_MAP } from '../../engines/influxdb/version-maps'

// Engine configurations for testing
// Names must match the keys in hostdb releases.json
const ENGINES = [
  { name: 'postgresql', map: POSTGRESQL_VERSION_MAP },
  { name: 'mysql', map: MYSQL_VERSION_MAP },
  { name: 'mariadb', map: MARIADB_VERSION_MAP },
  { name: 'mongodb', map: MONGODB_VERSION_MAP },
  { name: 'redis', map: REDIS_VERSION_MAP },
  { name: 'sqlite', map: SQLITE_VERSION_MAP },
  { name: 'clickhouse', map: CLICKHOUSE_VERSION_MAP },
  { name: 'cockroachdb', map: COCKROACHDB_VERSION_MAP },
  { name: 'couchdb', map: COUCHDB_VERSION_MAP },
  { name: 'duckdb', map: DUCKDB_VERSION_MAP },
  { name: 'ferretdb', map: FERRETDB_VERSION_MAP },
  { name: 'postgresql-documentdb', map: DOCUMENTDB_VERSION_MAP },
  { name: 'meilisearch', map: MEILISEARCH_VERSION_MAP },
  { name: 'qdrant', map: QDRANT_VERSION_MAP },
  { name: 'questdb', map: QUESTDB_VERSION_MAP },
  { name: 'surrealdb', map: SURREALDB_VERSION_MAP },
  { name: 'typedb', map: TYPEDB_VERSION_MAP },
  { name: 'valkey', map: VALKEY_VERSION_MAP },
  { name: 'influxdb', map: INFLUXDB_VERSION_MAP },
] as const

describe('hostdb Version Sync Verification', () => {
  let hostdbReleases: HostdbReleasesData

  before(async () => {
    console.log('\n🌐 Fetching hostdb releases.json...')
    try {
      hostdbReleases = await fetchHostdbReleases()
      console.log(
        `   ✓ Fetched releases (updated: ${hostdbReleases.updatedAt})`,
      )
    } catch (error) {
      const err = error as Error
      console.error(`   ✗ Failed to fetch releases: ${err.message}`)
      throw new Error(
        'Cannot verify version sync without network access to hostdb',
      )
    }
  })

  for (const { name, map } of ENGINES) {
    it(`${name} version map matches hostdb releases`, () => {
      const releases = getEngineReleases(hostdbReleases, name)

      if (!releases) {
        throw new Error(
          `Engine '${name}' not found in hostdb releases.json. ` +
            `Available engines: ${Object.keys(hostdbReleases.databases).join(', ')}`,
        )
      }

      const availableVersions = Object.keys(releases)
      const mappedVersions = Object.values(map)
      const missingVersions: string[] = []

      for (const version of mappedVersions) {
        if (!availableVersions.includes(version)) {
          missingVersions.push(version)
        }
      }

      if (missingVersions.length > 0) {
        const mapPath = `engines/${name}/version-maps.ts`
        throw new Error(
          `Version mismatch for ${name}!\n` +
            `  Missing from hostdb: ${missingVersions.join(', ')}\n` +
            `  Available in hostdb: ${availableVersions.join(', ')}\n` +
            `  Fix: Update ${mapPath} to use versions from hostdb releases.json`,
        )
      }

      console.log(
        `   ✓ ${name}: ${mappedVersions.length} versions verified (${mappedVersions.join(', ')})`,
      )
    })
  }

  it('all hostdb engines are represented in SpinDB', () => {
    const hostdbEngines = Object.keys(hostdbReleases.databases)
    const spindbEngines: string[] = ENGINES.map((e) => e.name)
    const missingEngines = hostdbEngines.filter(
      (e) => !spindbEngines.includes(e),
    )

    if (missingEngines.length > 0) {
      // Emit CI-visible warning (GitHub Actions annotation format + console.warn)
      const message = `hostdb has engines not yet in SpinDB: ${missingEngines.join(', ')}`
      if (process.env.GITHUB_ACTIONS) {
        // GitHub Actions warning annotation - shows in CI summary
        console.log(`::warning::${message}`)
      }
      console.warn(`   ⚠ ${message}`)
      // This is informational, not a failure - new engines are added intentionally
    }

    console.log(
      `   ✓ SpinDB covers ${spindbEngines.length}/${hostdbEngines.length} hostdb engines`,
    )
  })
})
