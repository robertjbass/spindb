# SpinDB Architecture

This document describes the architecture of SpinDB, a CLI tool for running local databases without Docker. Supports PostgreSQL, MySQL, MariaDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, SQLite, DuckDB, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, and InfluxDB.

## Table of Contents

- [High-Level Overview](#high-level-overview)
- [Directory Structure](#directory-structure)
- [Architectural Layers](#architectural-layers)
- [Engine Abstraction](#engine-abstraction)
- [Core Modules](#core-modules)
- [Data Flow](#data-flow)
- [Configuration & State](#configuration--state)
- [Key Patterns](#key-patterns)
- [Type System](#type-system)

---

## High-Level Overview

SpinDB follows a **three-tier layered architecture**:

```
┌─────────────────────────────────────────────────────────────┐
│                     CLI Layer (cli/)                        │
│         Commands, Menu, Prompts, Spinners, Theme            │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    Core Layer (core/)                       │
│    ContainerManager, PortManager, ProcessManager,           │
│    ConfigManager, BaseBinaryManagers, DependencyManager,    │
│    TransactionManager, ErrorHandler, PlatformService        │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                   Engine Layer (engines/)                   │
│  PostgreSQL, MySQL, MariaDB, MongoDB, FerretDB, Redis,      │
│  Valkey, ClickHouse, SQLite, DuckDB, Qdrant, Meilisearch,   │
│  CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB │
└─────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **CLI-First**: All functionality available via command-line arguments; interactive menus are syntactic sugar
2. **Wrapper Pattern**: Functions wrap CLI tools (psql, mysql) rather than implementing database logic
3. **Atomic Operations**: Multi-step operations use TransactionManager for rollback support
4. **No Build Step**: Uses `tsx` to run TypeScript directly

---

## Directory Structure

```
spindb/
├── cli/                    # CLI layer
│   ├── bin.ts              # Entry point (#!/usr/bin/env tsx)
│   ├── index.ts            # Commander.js setup, routes to commands
│   ├── commands/           # CLI commands (26 files)
│   │   ├── menu/           # Interactive menu
│   │   │   ├── index.ts    # Main menu orchestrator
│   │   │   ├── shared.ts   # MenuChoice type, utilities
│   │   │   └── *-handlers.ts  # Domain-specific handlers
│   │   ├── create.ts       # Container creation
│   │   ├── start.ts        # Start container
│   │   ├── stop.ts         # Stop container
│   │   └── ...             # Other commands
│   └── ui/                 # UI utilities
│       ├── prompts.ts      # Inquirer.js prompts
│       ├── spinner.ts      # Ora spinner helpers
│       └── theme.ts        # Chalk color theme
│
├── core/                   # Core business logic
│   ├── container-manager.ts    # Container CRUD operations
│   ├── port-manager.ts         # Port availability/allocation
│   ├── process-manager.ts      # Process start/stop
│   ├── config-manager.ts       # Global config persistence
│   ├── base-binary-manager.ts        # Base class for key-value stores (Redis, Valkey)
│   ├── base-server-binary-manager.ts # Base class for SQL servers (MySQL, MariaDB, ClickHouse)
│   ├── base-document-binary-manager.ts # Base class for document DBs (MongoDB, FerretDB)
│   ├── base-embedded-binary-manager.ts # Base class for embedded DBs (SQLite, DuckDB)
│   ├── dependency-manager.ts   # Tool detection/installation
│   ├── transaction-manager.ts  # Rollback support
│   ├── start-with-retry.ts     # Port conflict retry logic
│   ├── error-handler.ts        # SpinDBError class
│   ├── platform-service.ts     # Platform abstractions
│   ├── backup-restore.ts       # Backup/restore orchestration
│   ├── hostdb-client.ts        # Shared hostdb fetch/caching
│   ├── homebrew-version-manager.ts  # Homebrew version detection
│   ├── update-manager.ts       # Update checking
│   └── version-utils.ts        # Version parsing/comparison
│
├── engines/                # Database engine implementations
│   ├── base-engine.ts      # Abstract base class
│   ├── index.ts            # Engine registry
│   ├── postgresql/         # PostgreSQL implementation
│   │   ├── index.ts        # PostgreSQLEngine class
│   │   ├── binary-urls.ts  # hostdb URL builder
│   │   ├── hostdb-releases.ts  # hostdb GitHub releases API
│   │   ├── version-maps.ts # Version mapping
│   │   ├── binary-manager.ts  # Client tool management
│   │   ├── backup.ts       # pg_dump wrapper
│   │   ├── restore.ts      # Restore logic
│   │   └── version-validator.ts
│   ├── mysql/              # MySQL implementation
│   │   ├── index.ts        # MySQLEngine class
│   │   ├── binary-urls.ts  # hostdb URL builder
│   │   ├── hostdb-releases.ts  # hostdb GitHub releases API
│   │   ├── version-maps.ts # Version mapping
│   │   ├── binary-manager.ts  # Download/extraction
│   │   ├── backup.ts       # mysqldump wrapper
│   │   ├── restore.ts      # Restore logic
│   │   └── version-validator.ts
│   ├── mariadb/            # MariaDB implementation
│   │   ├── index.ts        # MariaDBEngine class
│   │   ├── binary-urls.ts  # hostdb URL builder
│   │   ├── hostdb-releases.ts  # hostdb GitHub releases API
│   │   ├── version-maps.ts # Version mapping
│   │   ├── binary-manager.ts  # Download/extraction
│   │   ├── backup.ts       # mariadb-dump wrapper
│   │   ├── restore.ts      # Restore logic
│   │   └── version-validator.ts
│   ├── mongodb/            # MongoDB implementation
│   │   ├── index.ts        # MongoDBEngine class
│   │   ├── binary-urls.ts  # hostdb URL builder
│   │   ├── version-maps.ts # Version mapping
│   │   ├── backup.ts       # mongodump wrapper
│   │   ├── restore.ts      # mongorestore logic
│   │   └── version-validator.ts
│   ├── redis/              # Redis implementation
│   │   ├── index.ts        # RedisEngine class
│   │   ├── binary-urls.ts  # hostdb URL builder
│   │   ├── version-maps.ts # Version mapping
│   │   ├── backup.ts       # RDB/text backup
│   │   ├── restore.ts      # RDB/text restore
│   │   └── version-validator.ts
│   └── sqlite/             # SQLite implementation
│       ├── index.ts        # SQLiteEngine class
│       ├── binary-urls.ts  # hostdb URL builder
│       ├── version-maps.ts # Version mapping
│       ├── registry.ts     # File tracking in config.json
│       └── scanner.ts      # CWD scanning for .sqlite files
│
├── config/                 # Configuration
│   ├── paths.ts            # ~/.spindb/ path utilities
│   ├── defaults.ts         # General defaults
│   ├── engine-defaults.ts  # Engine-specific defaults
│   ├── backup-formats.ts   # Backup format definitions
│   ├── os-dependencies.ts  # Platform-specific dependencies
│   ├── engines.json        # Engine metadata (source of truth)
│   ├── engines.schema.json # JSON schema for engines.json
│   └── engines-registry.ts # Type-safe engines.json loader
│
├── types/                  # TypeScript types
│   └── index.ts            # All type definitions
│
└── tests/                  # Tests
    ├── unit/               # Unit tests
    └── integration/        # Integration tests
```

---

## Architectural Layers

### CLI Layer (`cli/`)

The CLI layer handles user interaction and command routing.

**Entry Flow:**
```
bin.ts → index.ts → Commander.js → commands/*.ts
```

**Components:**
- **Commands**: 26 discrete commands (create, start, stop, list, etc.)
- **Menu**: Interactive mode with submenus and handlers
- **UI**: Prompts (Inquirer), spinners (Ora), colors (Chalk)

**Command Categories:**
| Category | Commands |
|----------|----------|
| Lifecycle | create, list, start, stop, delete, edit, info |
| Data | backup, restore, clone, run, logs, url |
| Shell | connect |
| System | config, deps, engines, doctor, attach, detach |
| Updates | self-update, version |
| Interactive | menu (default) |

### Core Layer (`core/`)

The core layer contains business logic independent of CLI concerns.

**Key Modules:**
| Module | Responsibility |
|--------|----------------|
| ContainerManager | Container CRUD, config persistence |
| PortManager | Port availability checks, allocation |
| ProcessManager | Database process start/stop |
| ConfigManager | Global config (~/.spindb/config.json) |
| BaseBinaryManagers | Engine binary download/extraction (4 base classes) |
| DependencyManager | Tool detection, installation |
| TransactionManager | Rollback for multi-step operations |
| StartWithRetry | Port conflict retry handling |
| ErrorHandler | Centralized error definitions |
| PlatformService | OS-specific abstractions |

### Engine Layer (`engines/`)

The engine layer implements database-specific logic via the abstract `BaseEngine` class.

**Engine Types:**
- **Server-based** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB): Process management, port allocation
- **File-based** (SQLite, DuckDB): No server, files in project directories
- **Composite** (FerretDB): Multiple processes working together (see [FerretDB Architecture](#ferretdb-architecture))

---

## FerretDB Architecture

FerretDB is a **composite engine** that requires two separate processes to function: FerretDB (a stateless proxy) and PostgreSQL+DocumentDB (the storage backend). This makes it architecturally distinct from other engines.

### How It Works

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────────────┐
│  MongoDB Client │   TCP   │    FerretDB     │   TCP   │  PostgreSQL+DocumentDB  │
│   (mongosh,     │ ──────► │     Proxy       │ ──────► │      Backend            │
│    app, etc.)   │  :27017 │                 │ :54320  │                         │
└─────────────────┘         └─────────────────┘         └─────────────────────────┘
                            Translates MongoDB          Stores data as JSONB
                            queries to SQL              in PostgreSQL tables
```

**FerretDB** accepts MongoDB wire protocol connections and translates them to SQL queries.
**PostgreSQL+DocumentDB** is a PostgreSQL instance with the DocumentDB extension that stores documents as JSONB.

### Two-Port Architecture

Each FerretDB container uses TWO user-relevant ports:

| Port | Purpose | Visibility | Default Range |
|------|---------|------------|---------------|
| **External** | MongoDB wire protocol | User-facing | 27017+ |
| **Internal** | PostgreSQL backend | Hidden | 54320+ |

Users connect to the external port with MongoDB connection strings (`mongodb://localhost:27017`). The internal PostgreSQL port is managed automatically by SpinDB.

> **Note:** FerretDB also binds a debug HTTP port (external port + 10000) for internal metrics/debugging. This port is not exposed to users and is managed automatically by SpinDB.

### Container Structure

```
~/.spindb/containers/ferretdb/myapp/
├── container.json          # Config (includes backendVersion, backendPort)
├── pg_data/                # PostgreSQL data directory (embedded)
├── logs/
│   ├── ferretdb.log
│   └── postgres.log
└── ferretdb.pid
```

### Binary Dependencies

FerretDB requires TWO binary packages from hostdb:

1. **ferretdb** - The Go proxy binary (~30MB)
2. **postgresql-documentdb** - PostgreSQL 17 with DocumentDB extension and dependencies (pg_cron, pgvector, PostGIS, rum)

```
~/.spindb/bin/
├── ferretdb-2.7.0-darwin-arm64/
│   └── bin/ferretdb
└── postgresql-documentdb-17-0.107.0-darwin-arm64/
    ├── bin/postgres, pg_ctl, psql, initdb, pg_dump, pg_restore
    ├── lib/pg_documentdb.dylib, pg_documentdb_core.dylib, ...
    └── share/extension/documentdb.control, ...
```

### Lifecycle Differences

Unlike simple engines, FerretDB must coordinate two processes:

**Start sequence:**
1. Allocate backend port (54320+)
2. Start PostgreSQL on backend port
3. Wait for PostgreSQL health check
4. Create `documentdb` extension if first run
5. Start FerretDB pointing to PostgreSQL
6. Verify FerretDB can accept connections

**Stop sequence:**
1. Stop FerretDB (SIGTERM)
2. Stop PostgreSQL (pg_ctl stop)

**Failure handling:** If any step fails, rollback by stopping any started processes.

### Backup Strategy

FerretDB uses PostgreSQL-native backup (pg_dump) on the embedded backend, not MongoDB tools:

```bash
# Internally calls pg_dump on the backend port
spindb backup myferret --format sql
```

This approach:
- Reuses existing PostgreSQL binaries (no extra dependencies)
- Provides consistent backup/restore behavior with other PostgreSQL-based engines
- Avoids MongoDB licensing concerns

### Configuration Extensions

FerretDB containers have additional fields in `container.json`:

```ts
type FerretDBContainerConfig = ContainerConfig & {
  backendVersion: string   // PostgreSQL version (e.g., "17")
  backendPort: number      // Internal PostgreSQL port (e.g., 54320)
}
```

### Platform Support

| Platform | FerretDB | PostgreSQL+DocumentDB | Notes |
|----------|----------|----------------------|-------|
| darwin-arm64 | ✅ | ✅ | Full support |
| darwin-x64 | ✅ | ✅ | Full support |
| linux-x64 | ✅ | ✅ | Full support |
| linux-arm64 | ✅ | ✅ | Full support |
| win32-x64 | ✅ | ❌ | postgresql-documentdb has startup issues on Windows |

> **Note:** FerretDB requires both the proxy binary and the PostgreSQL+DocumentDB backend to function. Windows is not supported due to postgresql-documentdb startup issues; use WSL2 on Windows.

---

## Engine Abstraction

All engines extend `BaseEngine`, which defines the contract for database operations:

```ts
abstract class BaseEngine {
  // Identity
  abstract name: string
  abstract displayName: string
  abstract defaultPort: number
  abstract supportedVersions: string[]

  // Binary Management
  abstract getBinaryUrl(version, platform, arch): string
  abstract verifyBinary(binPath): Promise<boolean>
  abstract isBinaryInstalled(version): Promise<boolean>
  abstract ensureBinaries(version, onProgress?): Promise<string>

  // Lifecycle
  abstract initDataDir(name, version, options?): Promise<string>
  abstract start(container, onProgress?): Promise<{port, connectionString}>
  abstract stop(container): Promise<void>
  abstract status(container): Promise<StatusResult>

  // Database Operations
  abstract createDatabase(container, database): Promise<void>
  abstract dropDatabase(container, database): Promise<void>
  abstract connect(container, database?): Promise<void>
  abstract runScript(container, options): Promise<void>

  // Backup/Restore
  abstract backup(container, outputPath, options): Promise<BackupResult>
  abstract restore(container, backupPath, options?): Promise<RestoreResult>
  abstract detectBackupFormat(filePath): Promise<BackupFormat>
  abstract dumpFromConnectionString(connStr, outputPath): Promise<DumpResult>

  // Utility
  abstract getConnectionString(container, database?): string
  abstract getDatabaseSize(container): Promise<number | null>
}
```

**Engine Registry** (`engines/index.ts`):
```ts
// Singleton instances with alias support
getEngine('postgresql')  // or 'postgres', 'pg'
getEngine('mysql')       // MySQL engine
getEngine('mariadb')     // MariaDB engine (separate from MySQL)
getEngine('mongodb')     // or 'mongo'
getEngine('ferretdb')    // or 'ferret' - MongoDB-compatible with PostgreSQL backend
getEngine('redis')       // Redis engine
getEngine('valkey')      // Redis-compatible fork
getEngine('clickhouse')  // OLAP database
getEngine('sqlite')      // or 'lite'
getEngine('duckdb')      // or 'duck' - OLAP file-based
getEngine('qdrant')      // or 'qd' - Vector database
getEngine('meilisearch') // or 'meili', 'ms' - Full-text search
getEngine('couchdb')     // or 'couch' - Document database
getEngine('cockroachdb') // or 'crdb' - Distributed SQL
getEngine('surrealdb')   // or 'surreal' - Multi-model database
getEngine('questdb')     // or 'quest' - Time-series database
getEngine('typedb')      // or 'tdb' - Knowledge graph database
getEngine('influxdb')    // or 'influx' - Time-series database (REST API)
```

---

## Core Modules

### ContainerManager

Manages container lifecycle and configuration.

**Responsibilities:**
- Create, read, update, delete container configs
- Cross-engine container discovery
- Config schema migration (old → new format)
- SQLite registry integration

**Storage:**
```
~/.spindb/containers/{engine}/{name}/container.json
```

### PortManager

Handles port allocation and availability.

**Features:**
- Port availability detection via `net.createServer()`
- Engine-specific port ranges (PostgreSQL: 5432-5500, MySQL: 3306-3400)
- Exclusion of already-assigned ports
- Diagnostic info via `lsof`

### ConfigManager

Manages global configuration.

**Storage:** `~/.spindb/config.json`

**Responsibilities:**
- Binary tool path caching (7-day staleness)
- SQLite registry management
- Default settings (engine, version, port)
- Update tracking (version checks)

### TransactionManager

Provides rollback support for atomic operations.

**Usage:**
```ts
const tx = new TransactionManager()
try {
  await step1()
  tx.addRollback({ description: '...', execute: rollback1 })
  await step2()
  tx.commit()
} catch (error) {
  await tx.rollback()  // LIFO execution
  throw error
}
```

### PlatformService

Abstracts platform-specific behavior.

**Features:**
- Home directory resolution (including sudo)
- Tool path detection with platform-specific search paths
- Clipboard operations (pbcopy/xclip)
- Package manager detection (Homebrew/apt/dnf/yum/pacman)
- WSL detection on Linux

---

## Data Flow

### Container Creation Flow

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ CLI: create │ ──▶ │ ContainerManager │ ──▶ │ Engine.initDataDir │
└─────────────┘     └──────────────────┘     └─────────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │ PortManager  │
                    │ (allocate)   │
                    └──────────────┘
                            │
                            ▼
                    ┌──────────────────┐
                    │ TransactionManager │
                    │ (commit/rollback) │
                    └──────────────────┘
```

### Container Start Flow

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│ CLI: start  │ ──▶ │ DependencyManager │ ──▶ │ PortManager  │
└─────────────┘     │ (validate tools)│     │ (check port) │
                    └─────────────────┘     └──────────────┘
                                                   │
                                                   ▼
                                           ┌──────────────┐
                                           │ Engine.start │
                                           └──────────────┘
                                                   │
                                                   ▼
                                           ┌────────────────┐
                                           │ StartWithRetry │
                                           │ (handle EADDR) │
                                           └────────────────┘
```

### Backup/Restore Flow

```
┌─────────────┐     ┌────────────────────┐     ┌──────────────┐
│ CLI: backup │ ──▶ │ Engine.backup      │ ──▶ │ pg_dump /    │
└─────────────┘     │ (detect format)    │     │ mysqldump    │
                    └────────────────────┘     └──────────────┘

┌──────────────┐     ┌────────────────────┐     ┌──────────────┐
│ CLI: restore │ ──▶ │ Engine.restore     │ ──▶ │ psql /       │
└──────────────┘     │ (validate version) │     │ mysql        │
                     └────────────────────┘     └──────────────┘
```

---

## Configuration & State

### File System Layout

Location: `~/.spindb/` (macOS/Linux) or `%USERPROFILE%\.spindb\` (Windows)

```
~/.spindb/
├── bin/                              # PostgreSQL server binaries
│   └── postgresql-17.7.0-{platform}/  # e.g., darwin-arm64, linux-x64, win32-x64
│       └── bin/
│           ├── postgres
│           ├── initdb
│           └── pg_ctl
│
├── containers/
│   ├── postgresql/
│   │   └── mydb/
│   │       ├── container.json        # Container config
│   │       ├── data/                 # PostgreSQL data directory
│   │       └── postgres.log          # Server logs
│   └── mysql/
│       └── mydb/
│           ├── container.json
│           ├── data/
│           └── mysql.log
│
├── config.json                       # Global config
└── spindb.log                        # Error log
```

### Container Config Schema

```ts
type ContainerConfig = {
  name: string
  engine: 'postgresql' | 'mysql' | 'mariadb' | 'mongodb' | 'ferretdb' | 'redis' | 'valkey' | 'clickhouse' | 'sqlite' | 'duckdb' | 'qdrant' | 'meilisearch' | 'couchdb' | 'cockroachdb' | 'surrealdb' | 'questdb' | 'typedb' | 'influxdb'
  version: string
  port: number
  database: string        // Primary database
  databases?: string[]    // All databases
  created: string         // ISO timestamp
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string     // Source container if cloned

  // FerretDB-specific (composite engine)
  backendVersion?: string // PostgreSQL backend version
  backendPort?: number    // PostgreSQL backend port
}
```

### Global Config Schema

```ts
type SpinDBConfig = {
  binaries: {
    // PostgreSQL tools
    psql?: BinaryConfig
    pg_dump?: BinaryConfig
    pg_restore?: BinaryConfig
    // MySQL tools
    mysql?: BinaryConfig
    mysqldump?: BinaryConfig
    mysqladmin?: BinaryConfig
    // MariaDB tools
    mariadb?: BinaryConfig
    'mariadb-dump'?: BinaryConfig
    'mariadb-admin'?: BinaryConfig
    // MongoDB tools
    mongod?: BinaryConfig
    mongosh?: BinaryConfig
    mongodump?: BinaryConfig
    mongorestore?: BinaryConfig
    // Redis tools
    'redis-server'?: BinaryConfig
    'redis-cli'?: BinaryConfig
    // SQLite tools
    sqlite3?: BinaryConfig
  }
  registry?: {
    sqlite?: {
      version: 1
      entries: SQLiteRegistryEntry[]
      ignoreFolders: Record<string, true>
    }
  }
  defaults?: {
    engine?: Engine
    version?: string
    port?: number
  }
  update?: {
    lastCheck?: string
    latestVersion?: string
    autoCheckEnabled?: boolean
  }
  updatedAt?: string
}
```

---

## Key Patterns

### 1. CLI-First Design

All functionality must be available via CLI arguments:

```bash
# CLI commands
spindb create mydb -e postgresql --db-version 17 -p 5433

# Interactive menu is syntactic sugar
spindb  # Opens menu → same operations
```

### 2. Wrapper Pattern

Functions wrap CLI tools rather than implementing logic:

```ts
// CORRECT: Wraps psql CLI
async createDatabase(container, database) {
  await execAsync(
    `"${psqlPath}" -h 127.0.0.1 -p ${port} -U postgres -c 'CREATE DATABASE "${database}"'`
  )
}
```

### 3. Transactional Operations

Multi-step operations are atomic with rollback:

```ts
const tx = new TransactionManager()
try {
  await createDataDir()
  tx.addRollback({ description: 'Remove data dir', execute: removeDir })
  await initDatabase()
  tx.commit()
} catch (error) {
  await tx.rollback()
  throw error
}
```

### 4. Engine Registry

Singleton pattern with aliases:

```ts
const engines = {
  postgresql: new PostgreSQLEngine(),
  mysql: new MySQLEngine(),
  mariadb: new MariaDBEngine(),
  mongodb: new MongoDBEngine(),
  ferretdb: new FerretDBEngine(),
  redis: new RedisEngine(),
  valkey: new ValkeyEngine(),
  clickhouse: new ClickHouseEngine(),
  sqlite: new SQLiteEngine(),
  duckdb: new DuckDBEngine(),
  qdrant: new QdrantEngine(),
  meilisearch: new MeilisearchEngine(),
  couchdb: new CouchDBEngine(),
  cockroachdb: new CockroachDBEngine(),
  surrealdb: new SurrealDBEngine(),
  questdb: new QuestDBEngine(),
}

const aliases = {
  postgres: 'postgresql',
  pg: 'postgresql',
  mongo: 'mongodb',
  ferret: 'ferretdb',
  lite: 'sqlite',
  duck: 'duckdb',
  qd: 'qdrant',
  meili: 'meilisearch',
  ms: 'meilisearch',
  couch: 'couchdb',
  crdb: 'cockroachdb',
  surreal: 'surrealdb',
  quest: 'questdb',
}
```

### 5. Port Retry Strategy

Handles race conditions with automatic retry:

```ts
async function startWithRetry(container, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await engine.start(container)
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        container.port = await portManager.findAvailable()
        continue
      }
      throw error
    }
  }
}
```

---

## Type System

Core types are centralized in `types/index.ts`:

| Type | Purpose |
|------|---------|
| `ContainerConfig` | Container state and metadata |
| `Engine` | Enum: PostgreSQL, MySQL, MariaDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, SQLite, DuckDB, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB |
| `BackupFormat` | Backup file format detection |
| `BackupOptions` | Backup command options |
| `BackupResult` | Backup operation result |
| `RestoreResult` | Restore operation result |
| `StatusResult` | Container status check result |
| `BinaryTool` | Supported binary tool names |
| `BinarySource` | bundled, system, custom |
| `BinaryConfig` | Tool path configuration |
| `SpinDBConfig` | Global config structure |
| `SQLiteRegistryEntry` | SQLite file tracking |
| `EngineInfo` | Runtime engine metadata |

---

## Error Handling

Centralized in `core/error-handler.ts`:

**Error Categories (20+ codes):**
- Port errors: in use, permission denied, exhausted
- Process errors: start/stop failures, stale PID
- Container errors: not found, already exists, running
- Restore errors: version mismatch, format unknown
- Dependency errors: missing, incompatible versions

**Error Strategy:**
- **CLI mode**: Log error, write to `~/.spindb/spindb.log`, exit with code 1
- **Interactive mode**: Log error, show "Press Enter to continue"
- **Transactional**: Rollback on failure, then propagate error

Error messages include actionable fix suggestions.

---

## Platform Support

Database binaries are downloaded from [hostdb](https://github.com/robertjbass/hostdb), which provides pre-built binaries for most platform combinations. Exceptions are noted in the table below.

| Platform | PostgreSQL | MySQL | MariaDB | MongoDB | FerretDB | Redis | Valkey | ClickHouse | SQLite | DuckDB | Qdrant | Meilisearch | CouchDB | CockroachDB | SurrealDB | QuestDB |
|----------|------------|-------|---------|---------|----------|-------|--------|------------|--------|--------|--------|-------------|---------|-------------|-----------|---------|
| macOS (ARM) | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb |
| macOS (Intel) | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb |
| Linux (x64) | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb |
| Linux (ARM) | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb |
| Windows (x64) | EDB* | hostdb | hostdb | hostdb | ❌*** | hostdb | hostdb | ❌** | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb | hostdb |

*PostgreSQL on Windows uses [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries) binaries.

**ClickHouse binaries not available for Windows in hostdb. Use WSL2.

***FerretDB requires postgresql-documentdb which has startup issues on Windows. Use WSL2.

**Binary source:**
- **hostdb**: https://github.com/robertjbass/hostdb - Pre-built database binaries for all platforms
- **Future**: [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries) may be integrated for smaller embedded PostgreSQL binaries

---

## CLI Command Reference

Comprehensive examples of CLI commands grouped by engine and utility.

### PostgreSQL Commands

```bash
# Container Lifecycle
spindb create pgdb                              # Create with defaults (v17, port 5432)
spindb create pgdb --db-version 16              # Specific version
spindb create pgdb --port 5433                  # Custom port
spindb create pgdb --database myapp             # Custom database name
spindb create pgdb --max-connections 300        # Custom max connections
spindb create pgdb --no-start                   # Create without starting
spindb create pgdb --start --connect            # Create, start, and connect
spindb start pgdb                               # Start container
spindb stop pgdb                                # Stop container
spindb delete pgdb                              # Delete (with confirmation)
spindb delete pgdb --force                      # Delete without confirmation

# Connection & Shell
spindb connect pgdb                             # Connect with psql
spindb connect pgdb --database myapp            # Connect to specific database
spindb connect pgdb --pgcli                     # Connect with pgcli (enhanced)
spindb connect pgdb --tui                       # Connect with usql (universal)
spindb connect pgdb --install-pgcli             # Install pgcli and connect
spindb url pgdb                                 # Print connection string
spindb url pgdb --copy                          # Copy to clipboard
spindb url pgdb --json                          # JSON output with details

# SQL Execution
spindb run pgdb script.sql                      # Run SQL file
spindb run pgdb -c "SELECT * FROM users"        # Run inline SQL
spindb run pgdb seed.sql --database myapp       # Target specific database

# Backup & Restore
spindb backup pgdb                              # Backup with auto-generated name
spindb backup pgdb --name production-backup     # Custom backup name
spindb backup pgdb --output ./backups/          # Custom output directory
spindb backup pgdb --format sql                 # Plain SQL format (.sql)
spindb backup pgdb --format custom              # Custom binary format (.dump)
spindb backup pgdb --database myapp             # Backup specific database
spindb restore pgdb backup.dump                 # Restore from backup
spindb restore pgdb backup.sql --database myapp # Restore to specific database

# Clone
spindb stop source-db                           # Source must be stopped
spindb clone source-db new-db                   # Clone container
spindb start new-db                             # Start cloned container

# Create from Backup/Remote
spindb create pgdb --from ./backup.dump         # Create and restore from file
spindb create pgdb --from "postgresql://user:pass@host:5432/prod"  # From remote

# Container Info & Logs
spindb info pgdb                                # Show container details
spindb info pgdb --json                         # JSON output
spindb logs pgdb                                # View logs
spindb logs pgdb --follow                       # Follow mode (tail -f)
spindb logs pgdb -n 50                          # Last 50 lines
spindb logs pgdb --editor                       # Open in $EDITOR

# Edit Container
spindb edit pgdb --name newname                 # Rename (must be stopped)
spindb edit pgdb --port 5433                    # Change port
spindb edit pgdb --set-config max_connections=300  # Edit PostgreSQL config
spindb edit pgdb                                # Interactive mode
```

### MySQL Commands

```bash
# Container Lifecycle
spindb create mydb --engine mysql               # Create MySQL container
spindb create mydb -e mysql --port 3307         # Custom port
spindb create mydb -e mysql --database app      # Custom database name
spindb create mydb -e mysql --no-start          # Create without starting
spindb start mydb                               # Start container
spindb stop mydb                                # Stop container
spindb delete mydb                              # Delete container
spindb delete mydb --force                      # Delete without confirmation

# Connection & Shell
spindb connect mydb                             # Connect with mysql client
spindb connect mydb --database app              # Connect to specific database
spindb connect mydb --mycli                     # Connect with mycli (enhanced)
spindb connect mydb --tui                       # Connect with usql (universal)
spindb connect mydb --install-mycli             # Install mycli and connect
spindb url mydb                                 # Print connection string
spindb url mydb --copy                          # Copy to clipboard

# SQL Execution
spindb run mydb script.sql                      # Run SQL file
spindb run mydb -c "SHOW TABLES"                # Run inline SQL
spindb run mydb seed.sql --database app         # Target specific database

# Backup & Restore
spindb backup mydb                              # Backup with mysqldump
spindb backup mydb --name backup-2024           # Custom backup name
spindb backup mydb --format sql                 # Plain SQL (.sql)
spindb backup mydb --format compressed          # Compressed (.sql.gz)
spindb backup mydb --database app               # Backup specific database
spindb restore mydb backup.sql                  # Restore from backup
spindb restore mydb backup.sql.gz               # Restore from compressed

# Clone
spindb stop source-mysql                        # Source must be stopped
spindb clone source-mysql new-mysql             # Clone container
spindb start new-mysql                          # Start cloned container

# Container Info & Logs
spindb info mydb                                # Show container details
spindb logs mydb                                # View logs
spindb logs mydb --follow                       # Follow mode

# Edit Container
spindb edit mydb --name newname                 # Rename (must be stopped)
spindb edit mydb --port 3307                    # Change port
```

### SQLite Commands

```bash
# Container Lifecycle (file-based, no start/stop needed)
spindb create lite --engine sqlite              # Create in current directory
spindb create lite -e sqlite --path ./data/app.sqlite  # Custom path
spindb create lite -e sqlite --database myapp   # Custom filename (myapp.sqlite)
spindb delete lite                              # Remove from registry
spindb delete lite --force                      # Remove without confirmation

# Attach/Detach (registry management)
spindb attach ./existing.sqlite                 # Register existing file
spindb attach ./existing.sqlite --name mydb     # Register with custom name
spindb detach lite                              # Remove from registry (keeps file)

# Connection & Shell
spindb connect lite                             # Connect with sqlite3
spindb connect lite --litecli                   # Connect with litecli (enhanced)
spindb connect lite --tui                       # Connect with usql (universal)
spindb connect lite --install-litecli           # Install litecli and connect
spindb url lite                                 # Print file path

# SQL Execution
spindb run lite script.sql                      # Run SQL file
spindb run lite -c "SELECT * FROM users"        # Run inline SQL

# Backup (file copy)
spindb backup lite                              # Copy database file
spindb backup lite --name backup                # Custom backup name
spindb backup lite --output ./backups/          # Custom output directory

# Container Info
spindb info lite                                # Show file path and size

# Edit Container
spindb edit lite --name newname                 # Rename in registry
spindb edit lite --relocate ~/new/path/         # Move database file
```

### System & Utility Commands

```bash
# List Containers
spindb list                                     # List all containers
spindb list --json                              # JSON output

# Container Info
spindb info                                     # Info for all containers
spindb info mydb                                # Specific container
spindb info --json                              # JSON output

# Engine Management
spindb engines                                  # List installed engines
spindb engines delete postgresql 16             # Delete specific version

# Dependency Management
spindb deps check                               # Check all dependencies
spindb deps check --engine postgresql           # Check specific engine
spindb deps check --engine mysql                # Check MySQL dependencies
spindb deps install                             # Install missing tools
spindb deps install --engine postgresql         # Install for specific engine

# Configuration
spindb config show                              # Show current config
spindb config detect                            # Re-detect tool paths
spindb config update-check on                   # Enable update notifications
spindb config update-check off                  # Disable update notifications

# Health Check
spindb doctor                                   # Interactive health check
spindb doctor --json                            # JSON output for scripting

# Version & Updates
spindb version                                  # Show version
spindb version --check                          # Check for updates
spindb self-update                              # Update SpinDB

# Interactive Menu
spindb                                          # Open interactive menu
spindb menu                                     # Explicit menu command
```

### Scripting Examples

```bash
# Export connection string to environment
export DATABASE_URL=$(spindb url pgdb)

# Use in psql
psql $(spindb url pgdb)

# Backup all PostgreSQL containers
for container in $(spindb list --json | jq -r '.[] | select(.engine=="postgresql") | .name'); do
  spindb backup "$container" --output ./backups/
done

# Start all stopped containers
spindb list --json | jq -r '.[] | select(.status=="stopped") | .name' | while read name; do
  spindb start "$name"
done

# Check if container is running
if spindb info mydb --json | jq -e '.status == "running"' > /dev/null; then
  echo "Container is running"
fi

# Create test database, run migrations, seed data
spindb create testdb --start --database app
spindb run testdb ./migrations/schema.sql --database app
spindb run testdb ./seeds/test-data.sql --database app
```

### Common Workflows

```bash
# New project setup
spindb create myproject --database app --start
spindb run myproject ./schema.sql --database app
spindb connect myproject --database app

# Clone production for local testing
spindb create prod-clone --from "postgresql://user:pass@prod.example.com/app"
spindb start prod-clone
spindb connect prod-clone

# Backup before risky migration
spindb backup mydb --name before-migration --format custom
spindb run mydb ./migrations/risky-change.sql
# If something goes wrong:
spindb restore mydb ./backups/before-migration.dump

# Switch between database versions
spindb stop pgdb
spindb create pgdb-16 --db-version 16 --port 5433
spindb clone pgdb pgdb-backup              # Backup current
spindb start pgdb-16

# Clean up old engine versions
spindb engines                              # List installed
spindb engines delete postgresql 14         # Remove old version
spindb engines delete postgresql 15         # Remove another
```
