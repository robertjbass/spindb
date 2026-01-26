import { postgresqlEngine } from './postgresql'
import { mysqlEngine } from './mysql'
import { mariadbEngine } from './mariadb'
import { sqliteEngine } from './sqlite'
import { duckdbEngine } from './duckdb'
import { mongodbEngine } from './mongodb'
import { ferretdbEngine } from './ferretdb'
import { redisEngine } from './redis'
import { valkeyEngine } from './valkey'
import { clickhouseEngine } from './clickhouse'
import { qdrantEngine } from './qdrant'
import { meilisearchEngine } from './meilisearch'
import { couchdbEngine } from './couchdb'
import { cockroachdbEngine } from './cockroachdb'
import { surrealdbEngine } from './surrealdb'
import { platformService } from '../core/platform-service'
import { Engine, Platform } from '../types'
import type { BaseEngine } from './base-engine'
import type { EngineInfo } from '../types'

// Engines not supported on Windows
// These engines either don't have Windows binaries or have issues running on Windows
const WINDOWS_UNSUPPORTED_ENGINES = new Set([Engine.ClickHouse, Engine.FerretDB])

// Registry of available database engines
export const engines: Record<string, BaseEngine> = {
  // PostgreSQL and aliases
  [Engine.PostgreSQL]: postgresqlEngine,
  postgres: postgresqlEngine,
  pg: postgresqlEngine,
  // MySQL and aliases
  [Engine.MySQL]: mysqlEngine,
  // MariaDB (standalone engine with downloadable binaries)
  [Engine.MariaDB]: mariadbEngine,
  maria: mariadbEngine,
  // SQLite and aliases
  [Engine.SQLite]: sqliteEngine,
  lite: sqliteEngine,
  // DuckDB and aliases
  [Engine.DuckDB]: duckdbEngine,
  duck: duckdbEngine,
  // MongoDB and aliases
  [Engine.MongoDB]: mongodbEngine,
  mongo: mongodbEngine,
  // FerretDB and aliases
  [Engine.FerretDB]: ferretdbEngine,
  ferret: ferretdbEngine,
  fdb: ferretdbEngine,
  // Redis and aliases
  [Engine.Redis]: redisEngine,
  // Valkey and aliases
  [Engine.Valkey]: valkeyEngine,
  // ClickHouse and aliases
  [Engine.ClickHouse]: clickhouseEngine,
  ch: clickhouseEngine,
  // Qdrant and aliases
  [Engine.Qdrant]: qdrantEngine,
  qd: qdrantEngine,
  // Meilisearch and aliases
  [Engine.Meilisearch]: meilisearchEngine,
  meili: meilisearchEngine,
  ms: meilisearchEngine,
  // CouchDB and aliases
  [Engine.CouchDB]: couchdbEngine,
  couch: couchdbEngine,
  // CockroachDB and aliases
  [Engine.CockroachDB]: cockroachdbEngine,
  crdb: cockroachdbEngine,
  // SurrealDB and aliases
  [Engine.SurrealDB]: surrealdbEngine,
  surreal: surrealdbEngine,
}

// Get an engine by name
export function getEngine(name: string): BaseEngine {
  const engine = engines[name.toLowerCase()]
  if (!engine) {
    const available = [...new Set(Object.values(engines))].map((e) => e.name)
    throw new Error(
      `Unknown engine "${name}". Available: ${available.join(', ')}`,
    )
  }
  return engine
}

// List all available engines (filtered by platform support)
export function listEngines(): EngineInfo[] {
  const { platform } = platformService.getPlatformInfo()
  const isWindows = platform === Platform.Win32
  const seen = new Set<BaseEngine>()

  return Object.entries(engines)
    .filter(([, engine]) => {
      if (seen.has(engine)) return false
      seen.add(engine)
      // Filter out unsupported engines on Windows
      if (isWindows && WINDOWS_UNSUPPORTED_ENGINES.has(engine.name as Engine)) {
        return false
      }
      return true
    })
    .map(([, engine]) => ({
      name: engine.name,
      displayName: engine.displayName,
      defaultPort: engine.defaultPort,
      supportedVersions: engine.supportedVersions,
    }))
}
