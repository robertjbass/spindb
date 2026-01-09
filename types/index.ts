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
  MongoDB = 'mongodb',
  Redis = 'redis',
}

export type ProgressCallback = (progress: {
  stage: string
  message: string
}) => void

export type InstalledBinary = {
  engine: Engine
  version: string
  platform: string
  arch: string
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

export type BackupOptions = {
  database: string
  format?: 'sql' | 'dump'
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
 * Binary tool types for all supported engines
 */
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
  // MongoDB tools
  | 'mongod'
  | 'mongosh'
  | 'mongodump'
  | 'mongorestore'
  // Redis tools
  | 'redis-server'
  | 'redis-cli'
  // Enhanced shells (optional)
  | 'pgcli'
  | 'mycli'
  | 'litecli'
  | 'iredis'
  | 'usql'

/**
 * Source of a binary - bundled (downloaded by spindb) or system (found on PATH)
 */
export type BinarySource = 'bundled' | 'system' | 'custom'

/**
 * Configuration for a single binary tool
 */
export type BinaryConfig = {
  tool: BinaryTool
  path: string
  source: BinarySource
  version?: string
}

/**
 * Global spindb configuration stored in ~/.spindb/config.json
 */
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
 * Engine registries stored in config.json
 * Currently only SQLite uses this (file-based databases)
 */
export type EngineRegistries = {
  sqlite?: SQLiteEngineRegistry
}

/**
 * @deprecated Use SQLiteEngineRegistry instead - now stored in config.json
 */
export type SQLiteRegistry = {
  version: 1
  entries: SQLiteRegistryEntry[]
}
