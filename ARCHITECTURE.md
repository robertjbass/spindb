# SpinDB Architecture

This document describes the architecture of SpinDB, a CLI tool for running local databases without Docker. Supports PostgreSQL, MySQL, MariaDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, SQLite, DuckDB, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB, Weaviate, TigerBeetle, and LibSQL.

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
- [Agent Implementation Notes](#agent-implementation-notes)

---

## High-Level Overview

SpinDB follows a **three-tier layered architecture**:

```text
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
│  CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB,          │
│  InfluxDB, Weaviate, TigerBeetle, LibSQL                     │
└─────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **CLI-First**: All functionality available via command-line arguments; interactive menus are syntactic sugar
2. **Wrapper Pattern**: Functions wrap CLI tools (psql, mysql) rather than implementing database logic
3. **Atomic Operations**: Multi-step operations use TransactionManager for rollback support
4. **No Build Step**: Uses `tsx` to run TypeScript directly

---

## Directory Structure

```text
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
│   ├── remote-container.ts     # Remote database linking utilities
│   ├── hostdb-client.ts        # Shared hostdb fetch/caching
│   ├── pg-binary-resolver.ts  # PostgreSQL client-tool lookup (bundled only)
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
```text
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

FerretDB is a **composite engine** that requires two separate processes to function: a FerretDB proxy and a PostgreSQL backend. It is a single engine (`Engine.FerretDB`) with two major versions that use different backends. The `isV1(version)` function in `engines/ferretdb/version-maps.ts` is the decision point for all version-specific behavior.

### v1 vs v2 Summary

| | **v2 (default)** | **v1** |
|---|---|---|
| **Backend** | postgresql-documentdb (DocumentDB extension) | Plain PostgreSQL (shared with standalone PG) |
| **Platforms** | macOS, Linux (4 platforms) | All platforms including Windows (5 platforms) |
| **Auth** | SCRAM enabled by default, uses `--no-auth` | Auth disabled by default, no flag needed |
| **SSL** | Omits sslmode (documentdb handles TLS) | Requires `?sslmode=disable` on PG URL |
| **DB creation** | Uses psql to create ferretdb DB + DocumentDB extension | Falls back to `postgres --single` if psql unavailable |
| **Engine delete** | Cascade deletes postgresql-documentdb binaries | Does NOT delete shared PostgreSQL binaries |
| **Backup/restore** | pg_dump works but DocumentDB metadata can cause conflicts | pg_dump/pg_restore works cleanly (no extension metadata) |

### How It Works

```text
v2: MongoDB Client (:27017) → FerretDB Proxy → PostgreSQL+DocumentDB (:54320+)
v1: MongoDB Client (:27017) → FerretDB Proxy → Plain PostgreSQL (:54320+)
```

**FerretDB** accepts MongoDB wire protocol connections and translates them to SQL queries.
The backend stores documents as JSONB in PostgreSQL tables.

### Two-Port Architecture

Each FerretDB container uses TWO user-relevant ports:

| Port | Purpose | Visibility | Default Range |
|------|---------|------------|---------------|
| **External** | MongoDB wire protocol | User-facing | 27017+ |
| **Internal** | PostgreSQL backend | Hidden | 54320+ |

Users connect to the external port with MongoDB connection strings (`mongodb://localhost:27017`). The internal PostgreSQL port is managed automatically by SpinDB.

> **Note:** FerretDB also binds a debug HTTP port (external port + 10000) for internal metrics/debugging. This port is not exposed to users and is managed automatically by SpinDB.

### Container Structure

```text
~/.spindb/containers/ferretdb/myapp/
├── container.json          # Config (includes backendVersion, backendPort)
├── pg_data/                # PostgreSQL data directory (embedded)
├── logs/
│   ├── ferretdb.log
│   └── postgres.log
└── ferretdb.pid
```

### Binary Dependencies

FerretDB requires TWO binary packages:

**v2:**
1. **ferretdb** (hostdb: `ferretdb`) - The Go proxy binary (~30MB)
2. **postgresql-documentdb** (hostdb: `postgresql-documentdb`) - PostgreSQL 17 with DocumentDB extension and dependencies (pg_cron, pgvector, PostGIS, rum)

**v1:**
1. **ferretdb** (hostdb: `ferretdb`) - The Go proxy binary (older version, same hostdb engine name)
2. **Plain PostgreSQL** - Standard PostgreSQL via `postgresqlBinaryManager` (shared with standalone PG containers, NOT a separate download)

```text
# v2 layout:
~/.spindb/bin/
├── ferretdb-2.7.0-darwin-arm64/
│   └── bin/ferretdb
└── postgresql-documentdb-17-0.107.0-darwin-arm64/
    ├── bin/postgres, pg_ctl, psql, initdb, pg_dump, pg_restore
    ├── lib/pg_documentdb.dylib, pg_documentdb_core.dylib, ...
    └── share/extension/documentdb.control, ...

# v1 layout (reuses existing PostgreSQL binaries):
~/.spindb/bin/
├── ferretdb-1.24.2-darwin-arm64/
│   └── bin/ferretdb
└── postgresql-17.7.0-darwin-arm64/     # Shared with standalone PG containers
    └── bin/postgres, pg_ctl, initdb, ...
```

### Lifecycle Differences

Unlike simple engines, FerretDB must coordinate two processes:

**Start sequence (v2):**
1. Allocate backend port (54320+)
2. Start PostgreSQL on backend port
3. Wait for PostgreSQL health check
4. Create `documentdb` extension if first run
5. Start FerretDB pointing to PostgreSQL (with `--no-auth`)
6. Verify FerretDB can accept connections

**Start sequence (v1):**
1. Allocate backend port (54320+)
2. If psql unavailable: create `ferretdb` database via `postgres --single` (pre-start)
3. Start PostgreSQL on backend port (omits `-w` on Windows)
4. Wait for PostgreSQL health check
5. If psql available: create `ferretdb` database via psql
6. Start FerretDB pointing to PostgreSQL (with `?sslmode=disable`, no `--no-auth`)
7. Verify FerretDB can accept connections

**Stop sequence (both versions):**
1. Stop FerretDB (SIGTERM)
2. Stop PostgreSQL (pg_ctl stop)

**Failure handling:** If any step fails, rollback by stopping any started processes.

### Engine Deletion & Cascade Behavior

- **v2:** Deleting the FerretDB engine also deletes postgresql-documentdb binaries, since they are exclusively used by FerretDB. This is a cascade delete.
- **v1:** Deleting the FerretDB engine does NOT delete PostgreSQL binaries, since they are shared with standalone PostgreSQL containers. Only the FerretDB proxy binary is removed.

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

> **Note:** v2 backups may encounter issues from DocumentDB internal metadata tables. Use `custom` format with `--clean --if-exists` for best results. v1 backups work cleanly since plain PostgreSQL has no extension metadata.

### Configuration Extensions

FerretDB containers have additional fields in `container.json`:

```ts
type FerretDBContainerConfig = ContainerConfig & {
  backendVersion: string   // "17-0.107.0" (v2 documentdb) or "17" (v1 plain PG)
  backendPort: number      // Internal PostgreSQL port (e.g., 54320)
}
```

### Platform Support

| Platform | v2 (FerretDB + DocumentDB) | v1 (FerretDB + Plain PG) |
|----------|---------------------------|--------------------------|
| darwin-arm64 | ✅ | ✅ |
| darwin-x64 | ✅ | ✅ |
| linux-x64 | ✅ | ✅ |
| linux-arm64 | ✅ | ✅ |
| win32-x64 | ❌ (postgresql-documentdb has startup issues) | ✅ |

> **Note:** `spindb create` auto-selects v1 on Windows. `spindb engines download ferretdb 2` on Windows is blocked with a helpful error suggesting v1.

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
```text
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

```text
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

```text
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

```text
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

```text
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

Database binaries are downloaded from the **Layerbase registry** (`registry.layerbase.host`) as the primary source, with **GitHub hostdb** as a fallback (controlled by `ENABLE_GITHUB_FALLBACK` in `core/hostdb-client.ts`). All download logic is centralized in `core/hostdb-client.ts`. Exceptions are noted in the table below.

| Platform | PostgreSQL | MySQL | MariaDB | MongoDB | FerretDB v2 | FerretDB v1 | Redis | Valkey | ClickHouse | SQLite | DuckDB | Qdrant | Meilisearch | CouchDB | CockroachDB | SurrealDB | QuestDB |
|----------|------------|-------|---------|---------|-------------|-------------|-------|--------|------------|--------|--------|--------|-------------|---------|-------------|-----------|---------|
| macOS (ARM) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| macOS (Intel) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Linux (x64) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Linux (ARM) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Windows (x64) | EDB* | ✅ | ✅ | ✅ | ❌** | ✅ | ✅ | ✅ | ❌*** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

*PostgreSQL on Windows uses [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries) binaries.

**FerretDB v2 requires postgresql-documentdb which has startup issues on Windows. v1 uses plain PostgreSQL and works on all platforms. `spindb create` auto-selects v1 on Windows.

***ClickHouse binaries not available for Windows. Use WSL2.

**Binary sources:**
- **Primary**: [Layerbase registry](https://registry.layerbase.host) - Pre-built database binaries for all platforms
- **Fallback**: [hostdb GitHub releases](https://github.com/robertjbass/hostdb) - Same binaries, fallback when Layerbase is unavailable (toggled by `ENABLE_GITHUB_FALLBACK`)
- **Future**: [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries) may be integrated for smaller embedded PostgreSQL binaries


---

## Agent Implementation Notes

Area rules moved verbatim from the former `CLAUDE.md` (now [AGENTS.md](AGENTS.md)). Read the matching subsection before touching that area.

### Engine categories and remote containers

**Engine categories:**
- **Server-based** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB, LibSQL): data in `~/.spindb/containers/{engine}/{name}/`, port management, start/stop lifecycle
- **File-based** (SQLite, DuckDB): data in CWD, no server process, `start()`/`stop()` are no-ops, tracked via registry in `~/.spindb/config.json`
- **Remote/linked** (`spindb link`): linked databases use `status: 'linked'` plus the `remote` field in `ContainerConfig`. `remote.origin` is now first-class: `'external'` for third-party/manual remotes and `'layerbase-cloud'` for Layerbase-managed cloud links. `provider` remains display metadata, and `providerId` is the stable provider-side identifier when available. Credentials are stored via credential-manager with username `'remote'`. Supports `connect`, `url`, `info`, `list`, `delete`, `query`. Does NOT support `backup`, `run`, `restore`, `export`, `clone`, `start`, `stop`, `logs` (these block with clear error messages). See `core/remote-container.ts` for utilities. Query support loads credentials, parses the connection string, and passes `host`/`password`/`username`/`ssl` to engine `executeQuery` via `QueryOptions`.
- **REST API** (Qdrant, Meilisearch, CouchDB, InfluxDB, LibSQL): server-based but HTTP API only, `spindb run` N/A, `spindb connect` opens web dashboard (LibSQL shows curl examples)

Engines extend `BaseEngine`. Use `assertExhaustive(engine)` in switch statements.

### spindb deploy (antiquated)

**`spindb deploy` (antiquated):** The `deploy` command exists but is not used by layerbase-cloud or layerbase-desktop. Cloud deployments are handled by layerbase-cloud's own infrastructure (Docker containers running spindb on Hetzner), not by `spindb deploy`. The command may be worth re-evaluating for users who want to deploy local databases to external (non-Layerbase) cloud services, but it is not part of any current workflow.

### Bind address and auth flags

**Bind address (`--bind` flag):** `spindb start --bind <address>` sets `bindAddress` in `ContainerConfig`, persisted to `config.json`. All server engines read `container.bindAddress ?? '127.0.0.1'` (QuestDB defaults to `0.0.0.0`). Config-file engines (Redis, Valkey, CouchDB, Qdrant) patch existing configs on restart rather than regenerating them, preserving user modifications like credentials and API keys. ClickHouse patches `<listen_host>` in config.xml. TypeDB regenerates config.yml on every start (passes bindAddress via initDataDir options).

**Authentication (`--auth` / `--no-auth` flags):** `spindb start --auth` sets `authEnabled: true` in `ContainerConfig`, persisted to `config.json`. `spindb start --no-auth` sets it to `false`. Only supported for MongoDB and FerretDB; warns and ignores for other engines. MongoDB: passes `--auth` to mongod when enabled. FerretDB v2: omits `--no-auth` flag when enabled (SCRAM authentication enforced). Default for both is auth disabled (backwards-compatible).

**LibSQL JWT authentication:** LibSQL uses Ed25519 JWT tokens for authentication (same pattern as Meilisearch API keys). `createUser()` generates an Ed25519 key pair, signs a JWT, writes the public key to the container directory (`jwt-key.pem`), restarts sqld with `--auth-jwt-key-file`, and stores the JWT via credential-manager. Not controlled by `--auth`/`--no-auth` flags.

### Deprecated version strategy

**Deprecated version strategy:** Deprecated versions are hidden from discovery but fully supported at runtime. The principle: **don't advertise, but don't break.** Specifically:
- **Version picker** (`promptVersion()` in `cli/ui/prompts.ts`): Hides major versions where all versions are deprecated (per `databases.json`). `spindb create --show-deprecated` reveals them. Individual deprecated versions within non-deprecated majors show with `[deprecated]` tag.
- **Version picker preselection**: the major-version list is newest-first (newest keeps the `← latest` label), but the PRESELECTED entry is the engine's configured `defaultVersion` from `config/engine-defaults.ts` - spindb policy, which is not always the newest line (MySQL recommends the `8.4` LTS line over `9.x`). When the configured default is not the newest it also carries a `← default` label. Selection logic is the pure helper `cli/ui/version-picker-defaults.ts` (`resolveDefaultMajorVersion` / `getMajorVersionMarkers`); a prerelease-only line is never preselected, and an absent/unmatched configured default falls back to the newest selectable line.
- **Direct CLI usage** (`--db-version`): Bypasses the filter entirely - users can always create containers with deprecated versions.
- **Existing containers**: `spindb list`, `spindb start`, `spindb info`, etc. work normally regardless of deprecation status. No warnings, no filtering.
- **Installed binaries**: `spindb engines list` shows all installed binaries, deprecated or not.
- **Downloads**: `spindb engines download <engine> <version>` works for deprecated versions - no version picker involved.
- Deprecation data comes from hostdb's `databases.json` (`deprecated: true` on version entries). Fetched at runtime by `getDeprecatedVersions()` in `core/hostdb-metadata.ts`.

### Database capabilities

**Database capabilities** (`core/database-capabilities.ts`): Static capability map for all 22 engines. Controls which engines support `databases create`, `databases rename`, and `databases drop`. PostgreSQL, ClickHouse, CockroachDB, and Meilisearch have native rename; 11 other engines use backup/restore; 7 engines (SQLite, DuckDB, Redis, Valkey, QuestDB, TigerBeetle, LibSQL) are unsupported with clear error messages. When adding a new engine, update `getDatabaseCapabilities()`. The map also carries `durableDatabaseExistence` (true only for PostgreSQL, MySQL, MariaDB, CockroachDB, ClickHouse: a database is listed even when empty, so a listing that omits it proves it is gone). `engine.databaseExists()` (`core/database-presence.ts`) is built on it and returns `'unknown'`, never `false`, whenever the listing is not proof; `spindb start` (`primaryDatabase.state`, `--no-recreate-database`, `core/primary-database.ts`) and `spindb backup` (`code: 'database_not_found'`) rely on that. Never treat `'unknown'` as absent, and when an engine's `listDatabases()` system-database exclusions change, update `getListingHiddenDatabases()` to match.

### Database branching

**Database branching (`spindb branch`):** Neon/Vercel-style copy-on-write forks, local, for every engine. A branch duplicates a container's data dir via a filesystem reflink/clonefile (`core/cow-copy.ts`: `cp -cR` on macOS/APFS, `cp -R --reflink=always` on Linux Btrfs/XFS-reflink/ZFS, full `fs.cp` fallback on ext4/NTFS). `core/branch-manager.ts` orchestrates the lifecycle: running PostgreSQL sources use `pg_basebackup --wal-method=stream` without stopping (full copy, not a reflink); other running server sources are auto stop→snapshot→restart'ed for a consistent copy; file-based engines (SQLite/DuckDB) clone the backing file and register a new entry, and the clone is WAL-complete (SQLite via the online `.backup` API, DuckDB via a pre-clone CHECKPOINT with a copy-the-`.wal` fallback + `warning` when the source is locked by another process) - a bare file clone silently drops everything still in the write-ahead log. Lineage lives on `ContainerConfig.branchParent`/`branchedAt` (and `SQLite/DuckDBRegistryEntry` for file-based). `clone` and `branch` share `containerManager.copyContainerData({ strategy: 'copy' | 'cow', lineage, port? })`; the per-engine `prepareBranchedDataDir()` hook (in `base-engine.ts`) fixes identity baked into a copied data dir (ClickHouse regenerates `config.xml`; FerretDB clears the inherited `backendPort` so start() reallocates a free one; Weaviate self-heals RAFT on start; others no-op). The `--json` output mirrors `clone`/`create` (`{ success, source, name, port, method, branchParent, connectionString, started, warning? }`) so layerbase-desktop/cloud parse it the same way. **Git-driven branching** (`core/git-branch-sync.ts`): `spindb branch init --base <c>` writes `.spindb/branch.json` (`baseContainer`/`engine`/`stablePort`/`mainBranch`) + installs a chain-safe `post-checkout` hook; switching git branches runs `branch sync`, which swaps the matching DB branch onto the **stable port** (one live at a time; git→container mapping is deterministic - `main`→base, else `<base>__<sanitized>`). Subcommands: `init`/`sync`/`status`/`prune`/`hooks install|uninstall`. Server engines only. **Not yet:** time-travel/PITR, merge. Linked/remote containers cannot be branched. Interactive menu: a top-level **Branches** tree view (drill into any node to manage it), branch-aware **Delete** (cascade prompt), and a **Git branching** view (status/sync/prune/hooks) shown when the repo is configured; the tree renderer is shared via `cli/ui/branch-tree.ts`. Downstream integration playbook for desktop/cloud: [docs/BRANCHING-INTEGRATION.md](docs/BRANCHING-INTEGRATION.md). See [docs/BRANCHING.md](docs/BRANCHING.md).

### Version lookups and resolution

All engines use the factory in `core/hostdb-releases-factory.ts` (`createHostdbReleases()`) for version lookups. Each engine's `hostdb-releases.ts` is a ~25-line file that passes engine-specific config to the factory. See `engines/redis/hostdb-releases.ts` as the canonical template.

The factory reads `databases.json` (via `core/hostdb-metadata.ts`) as the authoritative version source, with a three-tier fallback: **databases.json → locally installed binaries → hardcoded version map**. Do NOT write custom fetch/cache/fallback logic in engine files - use the factory.

**Turning a user-supplied version string into a real one is `core/version-resolver.ts` (`resolveEngineVersion`), for every engine.** Every `engines/*/version-maps.ts` `normalizeVersion()` calls it, and `BaseEngine.resolveFullVersion()` overrides delegate to that. The ladder is: exact hostdb resolution, then newest available release matching the input as a version PREFIX (segment-boundary matching, so `3.1` never matches `3.10.5`), then null so the caller reports an unknown version. Prereleases are only considered when the request itself names a channel (it contains a `-`), which is what keeps `19` from resolving to `19.0.0-beta.3`. Do NOT add per-engine version-shape regexes or `${version}.0.0`-style guesses in an engine file: that is exactly the divergence that made `--db-version 18.6` download `18.6.0` and then look for `18.6` binaries (fixed in 0.67.0).

**hostdb data files** are bundled inside the `hostdb` npm package. `core/hostdb-metadata.ts` reads them via `hostdb`'s `loadDatabasesJson()` / `loadDownloadsJson()` - no network call at runtime. The 5-minute cache + `registry.layerbase.host` / GitHub Raw fallback only kicks in if the bundled load throws (corrupt install, etc.). What's bundled:
- `databases.json` - version listings, platform support, CLI tools per engine (used by factory for version lookups, defaults block, deprecation flags)
- `downloads.json` - package manager install commands for tools
- `releases.json` - flat version list with R2 URLs + sha256s (used by `getReleaseInfo()` in hostdb's resolver, by `core/hostdb-client.ts` for binary downloads, and by `tests/integration/hostdb-sync.test.ts` as the bundled-vs-live drift check)

### hostdb npm package and pinning

`hostdb` is the single source of truth for which versions exist, how to resolve shorthand inputs (`'17'` → `'17.10.0'`), and where to download binaries. Spindb's `package.json` should pin **exactly** - not `^` or `~` - because:

- A patch-level hostdb release can add NEW VERSIONS (e.g., `hostdb@0.31.1` adds PostgreSQL 17.11.0). With `^0.31.0`, an end-user `pnpm install spindb@0.49.0` could pick up `hostdb@0.31.5` with versions spindb's tests never validated against.
- The `tests/integration/hostdb-sync.test.ts` drift check passes against a specific hostdb snapshot. Allowing the snapshot to change under your feet defeats the test.
- Spindb's `cli/ui/prompts.ts` displays version lists derived from hostdb. Users expect the same spindb version to show the same options.

**Correct pin format:** `"hostdb": "0.31.0"` (no caret, no tilde). Bumping hostdb is an explicit spindb release.

**Bump-hostdb workflow:**
1. New hostdb published to npm (registry shows new version).
2. Update `spindb/package.json`: change `hostdb` to exact new version.
3. `pnpm install` regenerates lockfile.
4. `pnpm test:hostdb-sync` confirms bundled snapshot matches live registry.
5. `pnpm test:unit` passes (version maps auto-rebuild from new snapshot).
6. Commit: `chore(deps): bump hostdb 0.31.0 → 0.32.0` describing new versions / deprecations.
7. Standard feature → dev → main PR flow.
8. Read the `Docker Linux ARM64` job's result on the bump PR. It is the sole automated linux-arm64 coverage, and a hostdb bump is exactly when arm64 binaries change, so it is the job to check first. **No manual dispatch any more:** it moved off QEMU emulation onto GitHub's hosted native arm64 runner (`ubuntu-24.04-arm`, free for public repos), so it now runs automatically on every PR to `main` and on the nightly cron, takes minutes instead of 30-45, and covers the full engine set including TigerBeetle, SurrealDB and ClickHouse (all three were unrunnable under emulation). It is inside the `CI Success` gate as of 0.70.2, so a red arm64 leg DOES fail the PR - but still read it by name on a hostdb bump rather than only trusting the overall green check. The old dispatch-only rule existed because the QEMU job was too slow for PRs, and it was useless in practice: QEMU implements no io_uring, so TigerBeetle failed every dispatch the job ever had, which is how a hostdb bump once shipped against a permanently red job.

### Container version pinning

Two layered guarantees prevent silent version drift on the user's data:

1. **At create time** (`cli/commands/create.ts`): the major/major-minor shorthand the user passes (`spindb create postgresql 18`) is resolved to a full version through `dbEngine.resolveFullVersion()` BEFORE `containerManager.create()` writes container.json. New containers always persist `version: '18.4.0'`, never `'18'`.

2. **At start time** (`cli/commands/start.ts`): if a container.json still has shorthand (legacy from an older spindb), `isShorthandVersion()` from `core/version-utils.ts` detects it. Spindb resolves through hostdb, writes the full version back to disk, prints a one-line `uiInfo` that the container is now pinned to `<full>`. From that point on the container is drift-immune. Skipped for file-based engines and remote/`'unknown'` containers.

**DuckDB file pins:** newly created DuckDB registry entries retain the exact
selected version. Connect, query, scripts, SQL backup/restore, and branch WAL
checkpointing use that version; branches inherit it and reset follows the
parent's pin. A missing pinned binary fails instead of using another cached
version. Legacy/imported entries without a pin retain their previous behavior;
the displayed default is not persisted as evidence of their original runtime.
DuckDB 2.0 GA is an explicit selection (`--db-version 2`); the configured
1.x default advances to 1.5.6; older exact file pins remain unchanged. The preservation drill
runs both 1.x with 2.0 preferred and 2.0 with 1.x preferred.
SQLite file pins and Cloud's separately embedded proxy runtimes remain separate
work. Cloud engine versions and defaults need separate approval.

Together these mean: new containers are immune from day one; legacy containers self-heal on their next start.

### Binary sources and hostdb engine names

Primary: Layerbase registry (`registry.layerbase.host`). Fallback: GitHub hostdb releases (toggled by `ENABLE_GITHUB_FALLBACK` in `core/hostdb-client.ts`). All download/fetch logic is centralized in `core/hostdb-client.ts` (`fetchWithRegistryFallback()`, `fetchHostdbReleases()`, `getReleasesUrls()`).

Exceptions: PostgreSQL/Windows uses EDB-sourced binaries uploaded to hostdb (same download path as other platforms). ClickHouse is macOS/Linux only. LibSQL is macOS/Linux only. FerretDB v2 is macOS/Linux only; v1 supports all platforms including Windows.

Most SpinDB engines map 1:1 to hostdb engine names. FerretDB v1 and v2 both use the single `ferretdb` hostdb engine name. The `tests/integration/hostdb-sync.test.ts` test verifies the combined `FERRETDB_VERSION_MAP` against the `ferretdb` entry in hostdb releases.json.

### CLI startup, processes and menus

**CLI startup is lazy on purpose; keep it that way.** `cli/index.ts` loads command modules on dispatch through `COMMAND_ENTRIES` (a new top-level command needs an entry there with its exact name and aliases; `tests/unit/cli-lazy-load.test.ts` fails otherwise). `core/container-manager.ts` and `cli/commands/list.ts` load engines through `loadEngine()` in `engines/loader.ts`, never through a static import of `engines/index.ts`, which pulls in all engines (about 200 modules). This is a measured exception to preferring static imports: Layerbase Cloud runs `spindb list --json` in every container each minute on 0.5 CPU, and the eager load made that probe cost over a second. Adding a static `engines/index.ts` import to either file, or anything `list` imports, undoes it; check with a module count of `spindb list --json` (21 for `--version`, 59 for `list --json` at 0.77.1).

**`spindb start` checks the pinned binaries before `engine.start()` for every server engine.** `core/start-binaries.ts` (`ensureStartBinaries`) runs in both `cli/commands/start.ts` and the menu's `handleStartContainer`: it asks `engine.hasStartableBinaries(config.version)` and, when false, downloads the EXACT pinned version through `engine.ensureBinaries(config.version)` (10.11.15 is never substituted for 10.11.16). On a TTY without `--json`/`--force` it prompts first (`<Engine> <version> is not installed. Download now?`, default yes; no prints the `spindb engines download <engine> <version>` command and exits 0 without starting). With `--json`, `--force`, or a non-TTY stdin it downloads with no prompt - never call `promptConfirm` when stdin is not a TTY, it throws. `hasStartableBinaries` defaults to the exact-version `isBinaryInstalled()`; only PostgreSQL overrides it (same-major `hasCompatibleBinaries()`, because its `start()` self-heals onto same-major binaries and repins, which Layerbase Cloud's shared binary store relies on). Do NOT add engine-specific branches in the CLI for this; put engine semantics in the override. A failed download throws `<Engine> <version> not available: <reason>` plus the manual command (the `create` wording, which Layerbase Cloud's exact-version retry and the layerbase TUI's `missingEngineBinary()` both parse). File-based engines are skipped, and the `server binary not found` throw inside `engine.start()` stays as the backstop.

**Spawning background server processes:** MUST use `stdio: ['ignore', 'ignore', 'ignore']` for detached processes. Using `'pipe'` keeps file descriptors open, preventing Node.js exit even after `proc.unref()`. Causes `spindb start` to hang in Docker/CI. All 19 server engines now follow this rule (FerretDB was the last to be fixed in 0.43.0).

**Commander.js:** Use `await program.parseAsync()`, not `program.parse()` - the latter returns immediately without waiting for async actions.

**Interactive menu redraws wipe ad-hoc console output:** `handleList()` clears and redraws the screen, so transient warnings or status messages for menu actions must be passed through the redraw path (for example via `inlineMessage`) instead of being printed with `console.log()` immediately before calling `handleList()` again. If a TUI message "flashes" and disappears, inspect the redraw flow before changing the action logic.

### Docker: never pnpm for global installs

**Never use pnpm to install global packages in a Dockerfile.** pnpm 10+ refuses `pnpm add -g` until `pnpm setup` has written `PNPM_HOME` into a shell profile, but Dockerfile `RUN` doesn't source profiles mid-step - so adding `pnpm setup && pnpm add -g X` in the same `RUN` doesn't actually fix anything. pnpm 11.x also has `@pnpm/exe` install bugs in clean containers. For a single global package, **always use `npm install -g X` in Dockerfiles**. This applies to `core/docker-exporter.ts` (the exported user container) and any future Docker work. The full context lives in `tests/docker/Dockerfile` - that one's safe because it pins pnpm 9 via `corepack` and uses `pnpm link --global`, not `add -g`. End-user behavior (`spindb update`) handles this by falling back to npm when pnpm errors with "global bin directory not in PATH" (see `core/update-manager.ts`).
