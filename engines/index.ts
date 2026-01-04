import { postgresqlEngine } from './postgresql'
import { mysqlEngine } from './mysql'
import { sqliteEngine } from './sqlite'
import { mongodbEngine } from './mongodb'
import { redisEngine } from './redis'
import type { BaseEngine } from './base-engine'
import type { EngineInfo } from '../types'

/**
 * Registry of available database engines
 */
export const engines: Record<string, BaseEngine> = {
  // PostgreSQL and aliases
  postgresql: postgresqlEngine,
  postgres: postgresqlEngine,
  pg: postgresqlEngine,
  // MySQL and aliases
  mysql: mysqlEngine,
  mariadb: mysqlEngine, // MariaDB is MySQL-compatible
  // SQLite and aliases
  sqlite: sqliteEngine,
  lite: sqliteEngine,
  // MongoDB and aliases
  mongodb: mongodbEngine,
  mongo: mongodbEngine,
  // Redis and aliases
  redis: redisEngine,
}

/**
 * Get an engine by name
 */
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

/**
 * List all available engines
 */
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
