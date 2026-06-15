/**
 * Engine-specific default configurations
 *
 * Encodes spindb-side policy that is NOT derived from hostdb:
 *   - `defaultVersion`: which major-version line spindb recommends. For most
 *     engines this is the latest major; for MySQL it's `8.4` (LTS) rather than
 *     `9.x` (innovation track). The full pinned version (e.g. `8.4.9`) comes
 *     from hostdb at create time — see `cli/commands/create.ts` for the
 *     eager-resolution call that turns shorthand into a full version before
 *     the container config is persisted.
 *   - Port ranges, superuser names, file paths, client-tool names: stable per
 *     engine, no hostdb involvement.
 *
 * What's deliberately NOT here:
 *   - `latestVersion` (deleted) — derive from `getEngine(name).supportedVersions[0]`
 *     at the call site. That value is built from the wrapper's
 *     `SUPPORTED_MAJOR_VERSIONS`, which is data-driven from hostdb.
 */

import { Engine, ALL_ENGINES } from '../types'
import { listVersions as hostdbListVersions } from 'hostdb'

/**
 * An auxiliary network port an engine binds in addition to its primary
 * database port, expressed as a fixed offset from that primary port. These are
 * intrinsic to how spindb configures each engine (e.g. QuestDB's HTTP API
 * always lands at the PG-wire port + 188). A consumer that publishes engine
 * ports (e.g. a port-block allocator) must reserve these alongside the primary
 * port so a neighbouring database is never handed one as its own base.
 *
 * Only engines whose aux ports are a STATIC offset appear here. TypeDB's
 * HTTP-API offset is deliberately excluded: it is configurable at runtime via
 * SPINDB_TYPEDB_HTTP_OFFSET (default 6271), so it is not a fixed fact. TypeDB
 * 3.11+ also binds a loopback-only admin port at primary + 6372, which is not
 * published and not relevant to port-block reservation.
 */
export type AuxPort = {
  // Stable identifier for the port's role (e.g. 'http', 'grpc', 'raft').
  name: string
  // Offset added to the engine's primary database port.
  offset: number
}

export type EngineDefaults = {
  // Default major-version line that spindb recommends. Shorthand like '18' or
  // '8.4'. Resolved to a full version (e.g. '8.4.9') via hostdb at create time.
  defaultVersion: string
  // Default port for this engine
  defaultPort: number
  // Port range to scan if default is busy
  portRange: { start: number; end: number }
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
  // Auxiliary ports bound at fixed offsets from the primary port (omitted when
  // the engine binds no static aux ports). See AuxPort.
  auxPorts?: AuxPort[]
}

export const engineDefaults: Record<Engine, EngineDefaults> = {
  [Engine.PostgreSQL]: {
    defaultVersion: '18',
    defaultPort: 5432,
    portRange: { start: 5432, end: 5500 },
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
    superuser: '', // No auth by default for local dev
    connectionScheme: 'http',
    logFileName: 'qdrant.log',
    pidFileName: 'qdrant.pid',
    dataSubdir: 'storage',
    clientTools: [], // Qdrant uses REST API, no separate CLI tools
    maxConnections: 0, // Not applicable for vector DB
    auxPorts: [{ name: 'grpc', offset: 1 }], // gRPC at HTTP port + 1
  },
  [Engine.Meilisearch]: {
    defaultVersion: '1',
    defaultPort: 7700, // HTTP REST API port
    portRange: { start: 7700, end: 7800 },
    superuser: '', // No auth by default for local dev
    connectionScheme: 'http',
    logFileName: 'meilisearch.log',
    pidFileName: 'meilisearch.pid',
    dataSubdir: 'data',
    clientTools: [], // Meilisearch uses REST API, no separate CLI tools
    maxConnections: 0, // Not applicable for search engine
  },
  [Engine.FerretDB]: {
    defaultVersion: '2',
    defaultPort: 27017, // MongoDB-compatible port
    portRange: { start: 27017, end: 27100 },
    superuser: '', // No auth by default for local dev
    connectionScheme: 'mongodb', // MongoDB-compatible protocol
    logFileName: 'ferretdb.log',
    pidFileName: 'ferretdb.pid',
    dataSubdir: 'pg_data', // PostgreSQL backend data directory
    clientTools: ['mongosh', 'mongodump', 'mongorestore'], // Uses MongoDB client tools
    maxConnections: 200, // PostgreSQL backend default
  },
  [Engine.CouchDB]: {
    defaultVersion: '3',
    defaultPort: 5984, // CouchDB default HTTP port
    portRange: { start: 5984, end: 6084 },
    superuser: '', // No auth by default for local dev
    connectionScheme: 'http',
    logFileName: 'couchdb.log',
    pidFileName: 'couchdb.pid',
    dataSubdir: 'data',
    clientTools: [], // CouchDB uses REST API, no separate CLI tools
    maxConnections: 0, // Not applicable
  },
  [Engine.CockroachDB]: {
    defaultVersion: '25',
    defaultPort: 26257, // CockroachDB default SQL port (HTTP UI at port + 1)
    portRange: { start: 26257, end: 26357 },
    superuser: 'root', // Default user in insecure mode
    connectionScheme: 'postgresql', // Uses PostgreSQL wire protocol
    logFileName: 'cockroach.log',
    pidFileName: 'cockroach.pid',
    dataSubdir: 'data',
    clientTools: ['cockroach'],
    maxConnections: 0, // Not applicable - managed internally
    auxPorts: [{ name: 'httpUi', offset: 1 }], // HTTP admin UI at port + 1
  },
  [Engine.SurrealDB]: {
    defaultVersion: '2',
    defaultPort: 8000, // SurrealDB default HTTP/WS port
    portRange: { start: 8000, end: 8100 },
    superuser: 'root', // Default user with password 'root'
    connectionScheme: 'ws', // WebSocket for real-time connections
    logFileName: 'surrealdb.log',
    pidFileName: 'surrealdb.pid',
    dataSubdir: 'data',
    clientTools: ['surreal'],
    maxConnections: 0, // Not applicable - managed internally
  },
  [Engine.QuestDB]: {
    defaultVersion: '9',
    defaultPort: 8812, // QuestDB PostgreSQL wire protocol port
    portRange: { start: 8812, end: 8912 },
    superuser: 'admin', // Default user with password 'quest'
    connectionScheme: 'postgresql', // Uses PostgreSQL wire protocol
    logFileName: 'questdb.log',
    pidFileName: 'questdb.pid',
    dataSubdir: 'db',
    clientTools: ['questdb'],
    maxConnections: 0, // Not applicable - managed internally
    // PG-wire is the primary port; HTTP API = +188, HTTP min/health = +191,
    // ILP-over-TCP ingestion = +197 (see engines/questdb/index.ts).
    auxPorts: [
      { name: 'http', offset: 188 },
      { name: 'httpMin', offset: 191 },
      { name: 'ilpTcp', offset: 197 },
    ],
  },
  [Engine.TypeDB]: {
    defaultVersion: '3',
    defaultPort: 1729, // TypeDB main port (gRPC protocol)
    portRange: { start: 1729, end: 1829 },
    superuser: 'admin', // Default admin user (password: 'password')
    connectionScheme: 'typedb', // TypeDB proprietary protocol
    logFileName: 'typedb.log',
    pidFileName: 'typedb.pid',
    dataSubdir: 'data',
    clientTools: ['typedb', 'typedb_console_bin'],
    maxConnections: 0, // Not applicable - managed internally
  },
  [Engine.InfluxDB]: {
    defaultVersion: '3',
    defaultPort: 8086, // InfluxDB HTTP API port
    portRange: { start: 8086, end: 8186 },
    superuser: '', // No auth by default for local dev
    connectionScheme: 'http',
    logFileName: 'influxdb.log',
    pidFileName: 'influxdb.pid',
    dataSubdir: 'data',
    clientTools: [], // InfluxDB uses REST API, no separate CLI tools
    maxConnections: 0, // Not applicable for time-series DB
  },
  [Engine.Weaviate]: {
    defaultVersion: '1',
    defaultPort: 8080, // Weaviate HTTP REST API port (gRPC is port + 1)
    portRange: { start: 8080, end: 8180 },
    superuser: '', // No auth by default for local dev
    connectionScheme: 'http',
    logFileName: 'weaviate.log',
    pidFileName: 'weaviate.pid',
    dataSubdir: 'data',
    clientTools: [], // Weaviate uses REST/GraphQL API, no separate CLI tools
    maxConnections: 0, // Not applicable for vector DB
    // HTTP REST is the primary port; the cluster/consensus ports sit at fixed
    // offsets (see engines/weaviate/index.ts): gRPC = +1, gossip = +100,
    // cluster-data = +101, RAFT = +200, RAFT internal RPC = +201.
    auxPorts: [
      { name: 'grpc', offset: 1 },
      { name: 'gossip', offset: 100 },
      { name: 'clusterData', offset: 101 },
      { name: 'raft', offset: 200 },
      { name: 'raftInternalRpc', offset: 201 },
    ],
  },
  [Engine.TigerBeetle]: {
    defaultVersion: '0.16',
    defaultPort: 3000,
    portRange: { start: 3000, end: 3100 },
    superuser: '', // No auth
    connectionScheme: '', // Custom binary protocol, no URI scheme
    logFileName: 'tigerbeetle.log',
    pidFileName: 'tigerbeetle.pid',
    dataSubdir: 'data',
    clientTools: ['tigerbeetle'], // Single binary serves as both server and REPL
    maxConnections: 0, // Not applicable
  },
  [Engine.LibSQL]: {
    defaultVersion: '0.24',
    defaultPort: 8080, // HTTP API port
    portRange: { start: 8080, end: 8180 },
    superuser: '', // No auth by default for local dev
    connectionScheme: 'http',
    logFileName: 'libsql.log',
    pidFileName: 'libsql.pid',
    dataSubdir: 'data',
    clientTools: [], // LibSQL uses HTTP API, no separate CLI tools
    maxConnections: 0, // Not applicable for HTTP API
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
 * Get Homebrew package name for PostgreSQL client tools.
 * Returns `postgresql@18` format. The version number tracks hostdb's latest
 * PostgreSQL major automatically — when PG 19 ships in hostdb, this returns
 * `postgresql@19` without a spindb code change.
 */
export function getPostgresHomebrewPackage(): string {
  const latestMajor = hostdbListVersions('postgresql', { format: 'major' })[0]
  if (!latestMajor) {
    throw new Error(
      'hostdb has no PostgreSQL versions — cannot resolve Homebrew package name',
    )
  }
  return `postgresql@${latestMajor}`
}
