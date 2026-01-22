/**
 * Engine-specific default configurations
 * Extracted for dependency injection pattern - allows each engine to define its own defaults
 */

import { Engine, ALL_ENGINES } from '../types'

export type EngineDefaults = {
  // Default version to use when not specified
  defaultVersion: string
  // Default port for this engine
  defaultPort: number
  // Port range to scan if default is busy
  portRange: { start: number; end: number }
  // Latest major version (used for Homebrew package names like postgresql@17)
  latestVersion: string
  // Default superuser name
  superuser: string
  // Connection string scheme (e.g., 'postgresql', 'mysql')
  connectionScheme: string
  // Log file name within container directory
  logFileName: string
  // PID file name (relative to data directory or container)
  pidFileName: string
  // Subdirectory for data files within container
  dataSubdir: string
  // Client tools required for this engine
  clientTools: string[]
  // Default max connections (higher than PostgreSQL default of 100 for parallel builds)
  maxConnections: number
}

export const engineDefaults: Record<Engine, EngineDefaults> = {
  [Engine.PostgreSQL]: {
    defaultVersion: '18',
    defaultPort: 5432,
    portRange: { start: 5432, end: 5500 },
    latestVersion: '18',
    superuser: 'postgres',
    connectionScheme: 'postgresql',
    logFileName: 'postgres.log',
    pidFileName: 'postmaster.pid',
    dataSubdir: 'data',
    clientTools: ['psql', 'pg_dump', 'pg_restore', 'pg_basebackup'],
    maxConnections: 200, // Higher than default 100 for parallel builds (Next.js, etc.)
  },
  [Engine.MySQL]: {
    defaultVersion: '8.4',
    defaultPort: 3306,
    portRange: { start: 3306, end: 3400 },
    latestVersion: '9',
    superuser: 'root',
    connectionScheme: 'mysql',
    logFileName: 'mysql.log',
    pidFileName: 'mysql.pid',
    dataSubdir: 'data',
    clientTools: ['mysql', 'mysqldump', 'mysqladmin'],
    maxConnections: 200, // Higher than default 151 for parallel builds
  },
  [Engine.MariaDB]: {
    defaultVersion: '11.8',
    defaultPort: 3307, // Different from MySQL to allow side-by-side
    portRange: { start: 3307, end: 3400 },
    latestVersion: '11.8',
    superuser: 'root',
    connectionScheme: 'mysql', // MariaDB uses MySQL protocol
    logFileName: 'mariadb.log',
    pidFileName: 'mariadb.pid',
    dataSubdir: 'data',
    clientTools: ['mysql', 'mysqldump', 'mysqladmin'],
    maxConnections: 200, // Higher than default 151 for parallel builds
  },
  [Engine.SQLite]: {
    defaultVersion: '3',
    defaultPort: 0, // File-based, no port
    portRange: { start: 0, end: 0 }, // N/A
    latestVersion: '3',
    superuser: '', // No authentication
    connectionScheme: 'sqlite',
    logFileName: '', // No log file
    pidFileName: '', // No PID file (no server process)
    dataSubdir: '', // File is the data
    clientTools: ['sqlite3'],
    maxConnections: 0, // N/A - file-based
  },
  [Engine.DuckDB]: {
    defaultVersion: '1',
    defaultPort: 0, // File-based, no port
    portRange: { start: 0, end: 0 }, // N/A
    latestVersion: '1',
    superuser: '', // No authentication
    connectionScheme: 'duckdb',
    logFileName: '', // No log file
    pidFileName: '', // No PID file (no server process)
    dataSubdir: '', // File is the data
    clientTools: ['duckdb'],
    maxConnections: 0, // N/A - file-based
  },
  [Engine.MongoDB]: {
    defaultVersion: '8.0',
    defaultPort: 27017,
    portRange: { start: 27017, end: 27100 },
    latestVersion: '8.2',
    superuser: '', // No auth by default for local dev
    connectionScheme: 'mongodb',
    logFileName: 'mongodb.log',
    pidFileName: 'mongod.pid',
    dataSubdir: 'data',
    clientTools: ['mongosh', 'mongodump', 'mongorestore'],
    maxConnections: 0, // Not applicable for MongoDB
  },
  [Engine.Redis]: {
    defaultVersion: '8',
    defaultPort: 6379,
    portRange: { start: 6379, end: 6400 },
    latestVersion: '8',
    superuser: '', // No auth by default for local dev
    connectionScheme: 'redis',
    logFileName: 'redis.log',
    pidFileName: 'redis.pid',
    dataSubdir: 'data',
    clientTools: ['redis-cli'],
    maxConnections: 0, // Not applicable for Redis
  },
  [Engine.Valkey]: {
    defaultVersion: '9',
    defaultPort: 6379,
    portRange: { start: 6379, end: 6479 },
    latestVersion: '9',
    superuser: '', // No auth by default for local dev
    connectionScheme: 'redis', // Use redis:// scheme for client compatibility
    logFileName: 'valkey.log',
    pidFileName: 'valkey.pid',
    dataSubdir: 'data',
    clientTools: ['valkey-cli'],
    maxConnections: 0, // Not applicable for Valkey
  },
  [Engine.ClickHouse]: {
    defaultVersion: '25.12',
    defaultPort: 9000, // Native TCP port (HTTP is 8123)
    portRange: { start: 9000, end: 9100 },
    latestVersion: '25.12',
    superuser: 'default', // Default user in ClickHouse
    connectionScheme: 'clickhouse',
    logFileName: 'clickhouse-server.log',
    pidFileName: 'clickhouse.pid',
    dataSubdir: 'data',
    clientTools: ['clickhouse'],
    maxConnections: 0, // Not applicable
  },
  [Engine.Qdrant]: {
    defaultVersion: '1',
    defaultPort: 6333, // HTTP REST API port (gRPC is 6334)
    portRange: { start: 6333, end: 6400 },
    latestVersion: '1',
    superuser: '', // No auth by default for local dev
    connectionScheme: 'http',
    logFileName: 'qdrant.log',
    pidFileName: 'qdrant.pid',
    dataSubdir: 'storage',
    clientTools: [], // Qdrant uses REST API, no separate CLI tools
    maxConnections: 0, // Not applicable for vector DB
  },
}

/**
 * Type guard to check if a string is a valid Engine
 */
function isValidEngine(value: string): value is Engine {
  return value in engineDefaults
}

/**
 * Get engine defaults by name
 * @param engine Engine (e.g., Engine.PostgreSQL or 'postgresql')
 * @throws Error if engine is not found
 */
export function getEngineDefaults(engine: Engine | string): EngineDefaults {
  const normalized = engine.toLowerCase()
  if (!isValidEngine(normalized)) {
    const available = Object.keys(engineDefaults).join(', ')
    throw new Error(
      `Unknown engine "${engine}". Available engines: ${available}`,
    )
  }
  return engineDefaults[normalized]
}

// Check if an engine is supported
export function isEngineSupported(engine: Engine | string): boolean {
  return isValidEngine(engine.toLowerCase())
}

// Get list of all supported engine names
export function getSupportedEngines(): Engine[] {
  return [...ALL_ENGINES]
}

/**
 * Get Homebrew package name for PostgreSQL client tools
 * Returns 'postgresql@18' format for versioned installs
 */
export function getPostgresHomebrewPackage(): string {
  const version = engineDefaults[Engine.PostgreSQL].latestVersion
  return `postgresql@${version}`
}
