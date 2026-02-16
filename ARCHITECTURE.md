# SpinDB Architecture

This document describes the architecture of SpinDB, a CLI tool for running local databases without Docker. Supports PostgreSQL, MySQL, MariaDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, SQLite, DuckDB, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB, Weaviate, and TigerBeetle.

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

