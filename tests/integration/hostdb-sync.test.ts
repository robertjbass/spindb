/**
 * hostdb Version Sync Verification Tests
 *
 * After the spindb→hostdb migration, every engine's VERSION_MAP is built at
 * import time from the bundled hostdb npm package's databases.json +
 * releases.json snapshot.
 *
 * This test verifies that the *bundled* snapshot agrees with the *live*
 * releases.json hosted on GitHub. It catches:
 *   - The pinned `hostdb` dependency lagging behind the latest hostdb release
 *     (a new version was published; spindb hasn't bumped yet).
 *   - The bundled releases.json in the published hostdb package being stale
 *     vs what's actually on R2 (build-pipeline issue in hostdb).
 *
 * Smoke-check semantics: every full version emitted by spindb's MAPs (which
 * are now thin views over hostdb's data) must exist as a known release in
 * the live hostdb registry. Anything missing means spindb would attempt to
 * download a release that R2 doesn't serve.
 *
 * Network access is required.
 */

import { describe, it, before } from 'node:test'
import {
  fetchHostdbReleases,
  getEngineReleases,
  type HostdbReleasesData,
} from '../../core/hostdb-client'

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
import { WEAVIATE_VERSION_MAP } from '../../engines/weaviate/version-maps'
import { TIGERBEETLE_VERSION_MAP } from '../../engines/tigerbeetle/version-maps'
import { LIBSQL_VERSION_MAP } from '../../engines/libsql/version-maps'

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
  { name: 'weaviate', map: WEAVIATE_VERSION_MAP },
  { name: 'tigerbeetle', map: TIGERBEETLE_VERSION_MAP },
  { name: 'libsql', map: LIBSQL_VERSION_MAP },
] as const

describe('hostdb Version Sync Verification', () => {
  let hostdbReleases: HostdbReleasesData

  before(async () => {
    console.log('\n🌐 Fetching live hostdb releases.json...')
    try {
      hostdbReleases = await fetchHostdbReleases()
      console.log(
        `   ✓ Fetched live releases (updated: ${hostdbReleases.updatedAt})`,
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
    it(`${name} bundled hostdb snapshot matches live releases`, () => {
      const releases = getEngineReleases(hostdbReleases, name)

      if (!releases) {
        throw new Error(
          `Engine '${name}' not found in live hostdb releases.json. ` +
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
        throw new Error(
          `Version drift for ${name}!\n` +
            `  Bundled hostdb snapshot expects: ${missingVersions.join(', ')}\n` +
            `  Live hostdb releases.json has:   ${availableVersions.join(', ')}\n` +
            `  Fix: bump the 'hostdb' dependency in package.json to a newer version ` +
            `(or, if the bundled snapshot is ahead of the live registry, the next ` +
            `hostdb release will publish the missing binaries to R2).`,
        )
      }

      console.log(
        `   ✓ ${name}: ${mappedVersions.length} versions verified (${mappedVersions.join(', ')})`,
      )
    })
  }

  it('all live hostdb engines are represented in SpinDB', () => {
    const hostdbEngines = Object.keys(hostdbReleases.databases)
    const spindbEngines: string[] = ENGINES.map((e) => e.name)
    const missingEngines = hostdbEngines.filter(
      (e) => !spindbEngines.includes(e),
    )

    if (missingEngines.length > 0) {
      const message = `hostdb has engines not yet in SpinDB: ${missingEngines.join(', ')}`
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::warning::${message}`)
      }
      console.warn(`   ⚠ ${message}`)
    }

    console.log(
      `   ✓ SpinDB covers ${spindbEngines.length}/${hostdbEngines.length} hostdb engines`,
    )
  })
})
