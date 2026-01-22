import { postgresqlEngine } from './postgresql'
import { mysqlEngine } from './mysql'
import { mariadbEngine } from './mariadb'
import { sqliteEngine } from './sqlite'
import { duckdbEngine } from './duckdb'
import { mongodbEngine } from './mongodb'
import { redisEngine } from './redis'
import { valkeyEngine } from './valkey'
import { clickhouseEngine } from './clickhouse'
import { qdrantEngine } from './qdrant'
import type { BaseEngine } from './base-engine'
import type { EngineInfo } from '../types'

// Registry of available database engines
export const engines: Record<string, BaseEngine> = {
  // PostgreSQL and aliases
  postgresql: postgresqlEngine,
  postgres: postgresqlEngine,
  pg: postgresqlEngine,
  // MySQL and aliases
  mysql: mysqlEngine,
  // MariaDB (standalone engine with downloadable binaries)
  mariadb: mariadbEngine,
  maria: mariadbEngine,
  // SQLite and aliases
  sqlite: sqliteEngine,
  lite: sqliteEngine,
  // DuckDB and aliases
  duckdb: duckdbEngine,
  duck: duckdbEngine,
  // MongoDB and aliases
  mongodb: mongodbEngine,
  mongo: mongodbEngine,
  // Redis and aliases
  redis: redisEngine,
  // Valkey and aliases
  valkey: valkeyEngine,
  // ClickHouse and aliases
  clickhouse: clickhouseEngine,
  ch: clickhouseEngine,
  // Qdrant and aliases
  qdrant: qdrantEngine,
  qd: qdrantEngine,
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

// List all available engines
export function listEngines(): EngineInfo[] {
  const seen = new Set<BaseEngine>()
  return Object.entries(engines)
    .filter(([, engine]) => {
      if (seen.has(engine)) return false
      seen.add(engine)
      return true
    })
    .map(([, engine]) => ({
      name: engine.name,
      displayName: engine.displayName,
      defaultPort: engine.defaultPort,
      supportedVersions: engine.supportedVersions,
    }))
}
