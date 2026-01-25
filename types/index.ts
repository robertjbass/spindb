export type ContainerConfig = {
  name: string
  engine: Engine
  version: string
  port: number
  database: string
  databases?: string[]
  created: string
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string
  // Path to the engine binary (for system-installed engines like MySQL, MongoDB, Redis)
  binaryPath?: string
  // FerretDB-specific: version of the postgresql-documentdb backend (e.g., "17-0.107.0")
  backendVersion?: string
  // FerretDB-specific: internal PostgreSQL backend port (e.g., 54320)
  backendPort?: number
}

/**
 * Supported database engine names
 * Extendable for future engines (sqlite, etc.)
 */
export enum Engine {
  PostgreSQL = 'postgresql',
  MySQL = 'mysql',
  MariaDB = 'mariadb',
  SQLite = 'sqlite',
  DuckDB = 'duckdb',
  MongoDB = 'mongodb',
  FerretDB = 'ferretdb',
  Redis = 'redis',
  Valkey = 'valkey',
  ClickHouse = 'clickhouse',
  Qdrant = 'qdrant',
  Meilisearch = 'meilisearch',
  CouchDB = 'couchdb',
}

// Supported operating systems (matches Node.js process.platform)
export enum Platform {
  Darwin = 'darwin',
  Linux = 'linux',
  Win32 = 'win32',
}

// Supported CPU architectures (matches Node.js process.arch)
export enum Arch {
  ARM64 = 'arm64',
  X64 = 'x64',
}

/**
 * Array of all supported engine values (type-safe, exhaustive)
 * When adding a new Engine enum value, TypeScript will error here until you add it
 */
export const ALL_ENGINES = [
  Engine.PostgreSQL,
  Engine.MySQL,
  Engine.MariaDB,
  Engine.SQLite,
  Engine.DuckDB,
  Engine.MongoDB,
  Engine.FerretDB,
  Engine.Redis,
  Engine.Valkey,
  Engine.ClickHouse,
  Engine.Qdrant,
  Engine.Meilisearch,
  Engine.CouchDB,
] as const

// File-based engines (no server process, data stored in user project directories)
export const FILE_BASED_ENGINES = new Set([Engine.SQLite, Engine.DuckDB])

/**
 * Check if an engine is file-based (SQLite, DuckDB)
 * File-based engines have no server process and store data in user project directories.
 */
export function isFileBasedEngine(engine: Engine): boolean {
  return FILE_BASED_ENGINES.has(engine)
}

/**
 * Type helper for exhaustive switch statements
 * Use in the default case to ensure all enum values are handled
 *
 * @example
 * switch (engine) {
 *   case Engine.PostgreSQL: return 5432
 *   // ... other cases
 *   default:
 *     assertExhaustive(engine, `Unknown engine: ${engine}`)
 * }
 */
export function assertExhaustive(x: never, message?: string): never {
  throw new Error(message ?? `Unhandled case: ${x}`)
}

export const ALL_PLATFORMS = Object.values(Platform) as Platform[]

export const ALL_ARCHS = Object.values(Arch) as Arch[]

export function isValidPlatform(value: string): value is Platform {
  return ALL_PLATFORMS.includes(value as Platform)
}

export function isValidArch(value: string): value is Arch {
  return ALL_ARCHS.includes(value as Arch)
}

// Compile-time validation that ALL_ENGINES contains all Engine enum values
type _AssertAllEngines = typeof ALL_ENGINES extends readonly Engine[]
  ? (typeof ALL_ENGINES)[number] extends Engine
    ? Engine extends (typeof ALL_ENGINES)[number]
      ? true
      : ['Error: ALL_ENGINES is missing some Engine values']
    : never
  : never
const _exhaustiveEnginesCheck: _AssertAllEngines = true

// Compile-time validation that ALL_PLATFORMS contains all Platform enum values
type _AssertAllPlatforms = typeof ALL_PLATFORMS extends Platform[]
  ? (typeof ALL_PLATFORMS)[number] extends Platform
    ? Platform extends (typeof ALL_PLATFORMS)[number]
      ? true
      : ['Error: ALL_PLATFORMS is missing some Platform values']
    : never
  : never
const _exhaustivePlatformsCheck: _AssertAllPlatforms = true

// Compile-time validation that ALL_ARCHS contains all Arch enum values
type _AssertAllArchs = typeof ALL_ARCHS extends Arch[]
  ? (typeof ALL_ARCHS)[number] extends Arch
    ? Arch extends (typeof ALL_ARCHS)[number]
      ? true
      : ['Error: ALL_ARCHS is missing some Arch values']
    : never
  : never
const _exhaustiveArchsCheck: _AssertAllArchs = true

export type ProgressCallback = (progress: {
  stage: string
  message: string
}) => void

export type InstalledBinary = {
  engine: Engine
  version: string
  platform: Platform
  arch: Arch
}

export type PortResult = {
  port: number
  isDefault: boolean
}

export type ProcessResult = {
  stdout: string
  stderr: string
  code?: number
}

export type StatusResult = {
  running: boolean
  message: string
}

export type BackupFormat = {
  format: string
  description: string
  restoreCommand: string
}

export type RestoreResult = {
  format: string
  stdout?: string
  stderr?: string
  code?: number
}

// Engine-specific backup format types
export type PostgreSQLFormat = 'sql' | 'custom'
export type MySQLFormat = 'sql' | 'compressed'
export type MariaDBFormat = 'sql' | 'compressed'
export type SQLiteFormat = 'sql' | 'binary'
export type DuckDBFormat = 'sql' | 'binary'
export type MongoDBFormat = 'bson' | 'archive'
export type RedisFormat = 'text' | 'rdb'
export type ValkeyFormat = 'text' | 'rdb'
export type ClickHouseFormat = 'sql'
export type QdrantFormat = 'snapshot'
export type MeilisearchFormat = 'snapshot'
export type FerretDBFormat = 'sql' | 'custom'
export type CouchDBFormat = 'json'

// Union of all backup formats
export type BackupFormatType =
  | PostgreSQLFormat
  | MySQLFormat
  | MariaDBFormat
  | SQLiteFormat
  | DuckDBFormat
  | MongoDBFormat
  | FerretDBFormat
  | RedisFormat
  | ValkeyFormat
  | ClickHouseFormat
  | QdrantFormat
  | MeilisearchFormat
  | CouchDBFormat

// Mapping from Engine to its corresponding backup format type
type EngineFormatMap = {
  [Engine.PostgreSQL]: PostgreSQLFormat
  [Engine.MySQL]: MySQLFormat
  [Engine.MariaDB]: MariaDBFormat
  [Engine.SQLite]: SQLiteFormat
  [Engine.DuckDB]: DuckDBFormat
  [Engine.MongoDB]: MongoDBFormat
  [Engine.FerretDB]: FerretDBFormat
  [Engine.Redis]: RedisFormat
  [Engine.Valkey]: ValkeyFormat
  [Engine.ClickHouse]: ClickHouseFormat
  [Engine.Qdrant]: QdrantFormat
  [Engine.Meilisearch]: MeilisearchFormat
  [Engine.CouchDB]: CouchDBFormat
}

// Helper type to get format type for a specific engine
export type FormatForEngine<E extends Engine> = EngineFormatMap[E]

export type BackupOptions = {
  database: string
  format?: BackupFormatType
}

export type BackupResult = {
  path: string
  format: string
  size: number
}

export type DumpResult = {
  filePath: string
  stdout?: string
  stderr?: string
  code?: number
  warnings?: string[]
}

export type EngineInfo = {
  name: string
  displayName: string
  defaultPort: number
  supportedVersions: string[]
}

/**
 * CLI tools structure (matches hostdb databases.json)
 * Used to align SpinDB with hostdb's standardized engine metadata
 */
export type EngineCliTools = {
  server: string // e.g., 'redis-server', 'mongod', 'postgres'
  client: string // e.g., 'redis-cli', 'mongosh', 'psql'
  utilities: string[] // e.g., ['mongodump', 'mongorestore', 'pg_dump']
  enhanced?: string[] // e.g., ['iredis', 'pgcli', 'mycli']
}

/**
 * Connection configuration (matches hostdb databases.json)
 * Defines how to connect to each database engine
 */
export type EngineConnection = {
  runtime: 'server' | 'embedded' // server = process-based, embedded = file-based (SQLite)
  defaultPort: number | null // null for embedded databases
  scheme: string // e.g., 'postgresql', 'mysql', 'mongodb', 'redis'
  defaultDatabase: string // e.g., 'postgres', '', '0' (for Redis)
  defaultUser: string // e.g., 'postgres', 'root', ''
  queryLanguage: string // e.g., 'sql', 'javascript', 'redis'
}

// Binary tool types for all supported engines
export type BinaryTool =
  // PostgreSQL tools (server)
  | 'postgres'
  | 'pg_ctl'
  | 'initdb'
  // PostgreSQL tools (client)
  | 'psql'
  | 'pg_dump'
  | 'pg_restore'
  | 'pg_basebackup'
  // MySQL tools
  | 'mysql'
  | 'mysqldump'
  | 'mysqlpump'
  | 'mysqld'
  | 'mysqladmin'
  // MariaDB tools (native names only - no mysql-named binaries to avoid conflicts)
  | 'mariadb'
  | 'mariadb-dump'
  | 'mariadbd'
  | 'mariadb-admin'
  // SQLite tools
  | 'sqlite3'
  | 'sqldiff'
  | 'sqlite3_analyzer'
  | 'sqlite3_rsync'
  // DuckDB tools
  | 'duckdb'
  // MongoDB tools
  | 'mongod'
  | 'mongosh'
  | 'mongodump'
  | 'mongorestore'
  // Redis tools
  | 'redis-server'
  | 'redis-cli'
  // Valkey tools
  | 'valkey-server'
  | 'valkey-cli'
  // ClickHouse tools
  | 'clickhouse'
  // Qdrant tools
  | 'qdrant'
  // Meilisearch tools
  | 'meilisearch'
  // FerretDB tools
  | 'ferretdb'
  // CouchDB tools
  | 'couchdb'
  // Enhanced shells (optional)
  | 'pgcli'
  | 'mycli'
  | 'litecli'
  | 'iredis'
  | 'usql'

// Source of a binary - bundled (downloaded by spindb) or system (found on PATH)
export type BinarySource = 'bundled' | 'system' | 'custom'

// Configuration for a single binary tool
export type BinaryConfig = {
  tool: BinaryTool
  path: string
  source: BinarySource
  version?: string
}

// Global spindb configuration stored in ~/.spindb/config.json
export type SpinDBConfig = {
  // Binary paths for all engine tools (server and client)
  binaries: {
    // PostgreSQL server tools
    postgres?: BinaryConfig
    pg_ctl?: BinaryConfig
    initdb?: BinaryConfig
    // PostgreSQL client tools
    psql?: BinaryConfig
    pg_dump?: BinaryConfig
    pg_restore?: BinaryConfig
    pg_basebackup?: BinaryConfig
    // MySQL server tools
    mysqld?: BinaryConfig
    mysqladmin?: BinaryConfig
    // MySQL client tools
    mysql?: BinaryConfig
    mysqldump?: BinaryConfig
    mysqlpump?: BinaryConfig
    // MariaDB server tools (native names only - no mysql-named binaries to avoid conflicts)
    mariadbd?: BinaryConfig
    'mariadb-admin'?: BinaryConfig
    // MariaDB client tools
    mariadb?: BinaryConfig
    'mariadb-dump'?: BinaryConfig
    // SQLite tools
    sqlite3?: BinaryConfig
    sqldiff?: BinaryConfig
    sqlite3_analyzer?: BinaryConfig
    sqlite3_rsync?: BinaryConfig
    // DuckDB tools
    duckdb?: BinaryConfig
    // MongoDB server tools
    mongod?: BinaryConfig
    // MongoDB client tools
    mongosh?: BinaryConfig
    mongodump?: BinaryConfig
    mongorestore?: BinaryConfig
    // Redis server tools
    'redis-server'?: BinaryConfig
    // Redis client tools
    'redis-cli'?: BinaryConfig
    // Valkey server tools
    'valkey-server'?: BinaryConfig
    // Valkey client tools
    'valkey-cli'?: BinaryConfig
    // ClickHouse tools
    clickhouse?: BinaryConfig
    // Qdrant tools
    qdrant?: BinaryConfig
    // Meilisearch tools
    meilisearch?: BinaryConfig
    // FerretDB tools
    ferretdb?: BinaryConfig
    // CouchDB tools
    couchdb?: BinaryConfig
    // Enhanced shells (optional)
    pgcli?: BinaryConfig
    mycli?: BinaryConfig
    litecli?: BinaryConfig
    iredis?: BinaryConfig
    usql?: BinaryConfig
  }
  // Engine registries (for file-based databases like SQLite)
  registry?: EngineRegistries
  // Default settings
  defaults?: {
    engine?: Engine
    version?: string
    port?: number
  }
  // Last updated timestamp
  updatedAt?: string
  // Self-update tracking
  update?: {
    lastCheck?: string // ISO timestamp of last npm registry check
    latestVersion?: string // Latest version found from registry
    autoCheckEnabled?: boolean // Default true, user can disable
  }
}

/**
 * SQLite registry entry - tracks external database files
 * Unlike PostgreSQL/MySQL, SQLite databases are stored in user project directories
 */
export type SQLiteRegistryEntry = {
  name: string // Container name (used in spindb commands)
  filePath: string // Absolute path to .sqlite file
  created: string // ISO timestamp
  lastVerified?: string // ISO timestamp of last existence check
}

/**
 * SQLite engine registry stored in config.json under registry.sqlite
 * Includes entries and folder ignore list for CWD scanning
 */
export type SQLiteEngineRegistry = {
  version: 1
  entries: SQLiteRegistryEntry[]
  ignoreFolders: Record<string, true> // O(1) lookup for ignored folders
}

/**
 * DuckDB registry entry - tracks external database files
 * Unlike PostgreSQL/MySQL, DuckDB databases are stored in user project directories
 */
export type DuckDBRegistryEntry = {
  name: string // Container name (used in spindb commands)
  filePath: string // Absolute path to .duckdb file
  created: string // ISO timestamp
  lastVerified?: string // ISO timestamp of last existence check
}

/**
 * DuckDB engine registry stored in config.json under registry.duckdb
 * Includes entries and folder ignore list for CWD scanning
 */
export type DuckDBEngineRegistry = {
  version: 1
  entries: DuckDBRegistryEntry[]
  ignoreFolders: Record<string, true> // O(1) lookup for ignored folders
}

/**
 * Engine registries stored in config.json
 * SQLite and DuckDB use this (file-based databases)
 */
export type EngineRegistries = {
  sqlite?: SQLiteEngineRegistry
  duckdb?: DuckDBEngineRegistry
}
