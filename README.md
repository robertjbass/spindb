# SpinDB

[![npm version](https://img.shields.io/npm/v/spindb.svg)](https://www.npmjs.com/package/spindb)
[![npm downloads](https://img.shields.io/npm/dm/spindb.svg)](https://www.npmjs.com/package/spindb)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](LICENSE)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#supported-engines--platforms)

**One CLI for all your local databases.**

SpinDB is a universal database management tool that combines a package manager, a unified API, and native client tooling for 17 different database engines—all from a single command-line interface. No Docker, no VMs, no platform-specific installers. Just databases, running natively on your machine.

```bash
npm install -g spindb

# PostgreSQL for your API
spindb create api-db

# MongoDB for analytics
spindb create analytics --engine mongodb

# Redis for caching
spindb create cache --engine redis

# All running side-by-side, all managed the same way
```

---

## Supported Engines & Platforms

SpinDB supports **17 database engines** across **5 platform architectures**—all with a consistent API.

| Engine | Type | macOS ARM | macOS Intel | Linux x64 | Linux ARM | Windows |
|--------|------|:---------:|:-----------:|:---------:|:---------:|:-------:|
| 🐘 **PostgreSQL** | Relational SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🐬 **MySQL** | Relational SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦭 **MariaDB** | Relational SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🪶 **SQLite** | Embedded SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦆 **DuckDB** | Embedded OLAP | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🍃 **MongoDB** | Document Store | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦔 **FerretDB** | Document Store | ✅ | ✅ | ✅ | ✅ | ❌ |
| 🔴 **Redis** | Key-Value | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔷 **Valkey** | Key-Value | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🏠 **ClickHouse** | Columnar OLAP | ✅ | ✅ | ✅ | ✅ | ❌ |
| 🧭 **Qdrant** | Vector Search | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔍 **Meilisearch** | Full-Text Search | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🛋️ **CouchDB** | Document Store | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🪳 **CockroachDB** | Distributed SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🌀 **SurrealDB** | Multi-Model | ✅ | ✅ | ✅ | ✅ | ✅ |
| ⏱️ **QuestDB** | Time-Series | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🤖 **TypeDB** | Knowledge Graph | ✅ | ✅ | ✅ | ✅ | ✅ |

**83 combinations. One CLI. Zero configuration.**

> ClickHouse and FerretDB are available on Windows via WSL.

---

## What is SpinDB?

SpinDB is **three tools in one**:

### 1. **Database Package Manager**
Download and manage multiple database engines and versions—just like `apt`, `brew`, or `npm`, but for databases.

```bash
# Run PostgreSQL 14 for legacy projects, 18 for new ones
spindb create old-project --engine postgresql --db-version 14
spindb create new-project --engine postgresql --db-version 18

# Or MySQL 8.0 alongside MySQL 9
spindb create legacy-mysql --engine mysql --db-version 8.0
spindb create modern-mysql --engine mysql --db-version 9
```

### 2. **Unified Database API**
One consistent interface across SQL databases, document stores, key-value stores, and analytics engines.

```bash
# Same commands work for ANY database
spindb create mydb --engine [postgresql|mysql|mariadb|mongodb|ferretdb|redis|valkey|clickhouse|sqlite|duckdb|qdrant|meilisearch|couchdb|cockroachdb|surrealdb|questdb|typedb]
spindb start mydb
spindb connect mydb
spindb backup mydb
spindb restore mydb backup.dump
```

### 3. **Native Database Client**
Access built-in shells, run queries, and execute scripts—all without installing separate clients.

```bash
# Execute SQL/NoSQL/commands across any engine
spindb run mydb script.sql                              # PostgreSQL/MySQL/SQLite
spindb run mydb -c "db.users.find().pretty()"           # MongoDB
spindb run mydb -c "SET mykey myvalue"                  # Redis/Valkey
spindb run mydb -c "SELECT * FROM system.tables"        # ClickHouse
```

---

## Quick Start

Install SpinDB globally using your preferred package manager:

```bash
# Using npm
npm install -g spindb

# Using pnpm (recommended - faster, more efficient)
pnpm add -g spindb

# Or run without installing
npx spindb
```

Create and start a database in seconds:

```bash
# PostgreSQL (default engine)
spindb create myapp
spindb start myapp
spindb connect myapp

# Or all in one command
spindb create myapp --start --connect
```

That's it! Your PostgreSQL database is now running on `localhost:5432`, and data persists in `~/.spindb/containers/postgresql/myapp/`.

### Try Other Engines

```bash
# MySQL for relational data
spindb create shop --engine mysql --start --connect

# MongoDB for document storage
spindb create logs --engine mongodb --start

# Redis for caching and real-time features
spindb create sessions --engine redis --start

# DuckDB for analytics
spindb create analytics --engine duckdb --start
```

Every engine works the same way. Learn one, use them all.

---

## Why SpinDB?

### The Problem with Current Tools

**Docker** is powerful but heavy—requires a daemon, runs containers in a VM (on macOS/Windows), and adds complexity for simple local databases.

**GUI tools** like DBngin and Postgres.app are great but platform-specific, don't support scripting, and lack a unified interface across engines.

**System package managers** (brew, apt, etc.) work but create version conflicts, require manual configuration, and don't provide consistent management across databases.

### SpinDB's Approach

SpinDB runs databases as **native processes** with **isolated data directories**:

- **No Docker daemon or VM overhead** - Direct process execution
- **No system installation conflicts** - Each database version lives in `~/.spindb/bin/`
- **No manual configuration** - Databases start with sensible defaults
- **Cross-platform consistency** - Same commands work on macOS, Linux, and Windows
- **Multi-version support** - Run PostgreSQL 14 and 18 side-by-side
- **Unified interface** - Manage PostgreSQL, MongoDB, and Redis the same way

### Comparison: Database GUI Tools

*For developers who prefer visual interfaces or use macOS-native tools.*

| Feature | SpinDB | DBngin | Postgres.app | Laragon |
|---------|--------|--------|--------------|---------|
| **Engines supported** | 17 | 3 (PG/MySQL/Redis) | 1 (PostgreSQL) | 4 (PG/MySQL/MariaDB/MongoDB) |
| CLI-first | ✅ | ❌ GUI-only | ❌ GUI-only | ⚠️ Limited CLI |
| Multi-version support | ✅ | ✅ | ✅ | ✅ |
| Built-in backup/restore | ✅ | ✅ | ❌ | ⚠️ Manual |
| Clone databases | ✅ | ✅ | ❌ | ❌ |
| macOS | ✅ | ✅ | ✅ | ❌ |
| Linux | ✅ | ❌ | ❌ | ❌ |
| Windows | ✅ | ❌ | ❌ | ✅ |
| Free for commercial use | ❌ | ✅ | ✅ | ✅ |

### Comparison: Docker & Containers

*For developers already using containerization.*

| Feature | SpinDB | Docker Desktop | Podman | OrbStack |
|---------|--------|----------------|--------|----------|
| **Engines supported** | 17 unified | Any (manual setup) | Any (manual setup) | Any (manual setup) |
| Daemon required | ❌ | ✅ | ❌ (rootless) | ✅ |
| Resource overhead | Native | VM + containers | VM + containers | VM + containers |
| Built-in backup/restore | ✅ | ❌ Manual | ❌ Manual | ❌ Manual |
| Connection strings | ✅ Auto-generated | ❌ Manual | ❌ Manual | ❌ Manual |
| Version switching | ✅ Instant | ⚠️ Pull images | ⚠️ Pull images | ⚠️ Pull images |
| Database-specific CLI | ✅ Included | ❌ Exec into container | ❌ Exec into container | ❌ Exec into container |
| Prod parity | ⚠️ Native binaries | ✅ Exact images | ✅ Exact images | ✅ Exact images |
| Free for commercial use | ❌ | ⚠️ Paid for orgs | ✅ | ⚠️ Paid tiers |

### Comparison: Package Managers

*For developers who "just install" databases system-wide.*

| Feature | SpinDB | Homebrew | apt/winget | asdf-vm |
|---------|--------|----------|------------|---------|
| **Engines supported** | 17 unified | Many (separate formulas) | Many (separate packages) | Many (plugins) |
| Multi-version side-by-side | ✅ | ⚠️ Complex | ❌ | ✅ |
| Isolated data directories | ✅ | ❌ System-wide | ❌ System-wide | ❌ |
| Built-in backup/restore | ✅ | ❌ | ❌ | ❌ |
| Unified CLI across engines | ✅ | ❌ | ❌ | ❌ |
| No root/sudo required | ✅ | ✅ | ❌ | ✅ |
| macOS | ✅ | ✅ | ❌ | ✅ |
| Linux | ✅ | ✅ | ✅ | ✅ |
| Windows | ✅ | ❌ | ✅ (winget) | ⚠️ WSL |
| Free for commercial use | ❌ | ✅ | ✅ | ✅ |

> **Note on licensing:** SpinDB requires a commercial license for business use. For personal projects, education, research, nonprofits, and government use, SpinDB is free. See [License](#license) for details.

---

## Supported Databases

SpinDB supports **17 database engines** with **multiple versions** for each:

| Engine | Type | Versions | Default Port | Query Language |
|--------|------|----------|--------------|----------------|
| 🐘 **PostgreSQL** | Relational (SQL) | 15, 16, 17, 18 | 5432 | SQL |
| 🐬 **MySQL** | Relational (SQL) | 8.0, 8.4, 9 | 3306 | SQL |
| 🦭 **MariaDB** | Relational (SQL) | 10.11, 11.4, 11.8 | 3307 | SQL |
| 🪶 **SQLite** | Embedded (SQL) | 3 | N/A (file-based) | SQL |
| 🦆 **DuckDB** | Embedded OLAP | 1.4.3 | N/A (file-based) | SQL |
| 🍃 **MongoDB** | Document Store | 7.0, 8.0, 8.2 | 27017 | JavaScript (mongosh) |
| 🦔 **FerretDB** | Document Store | 2 | 27017 | JavaScript (mongosh) |
| 🔴 **Redis** | Key-Value Store | 7, 8 | 6379 | Redis commands |
| 🔷 **Valkey** | Key-Value Store | 8, 9 | 6379 | Redis commands |
| 🏠 **ClickHouse** | Columnar OLAP | 25.12 | 9000 (TCP), 8123 (HTTP) | SQL (ClickHouse dialect) |
| 🧭 **Qdrant** | Vector Search | 1 | 6333 (HTTP), 6334 (gRPC) | REST API |
| 🔍 **Meilisearch** | Full-Text Search | 1 | 7700 | REST API |
| 🛋️ **CouchDB** | Document Store | 3 | 5984 | REST API |
| 🪳 **CockroachDB** | Distributed SQL | 25 | 26257 | SQL (PostgreSQL-compatible) |
| 🌀 **SurrealDB** | Multi-Model | 2 | 8000 | SurrealQL |
| ⏱️ **QuestDB** | Time-Series SQL | 9 | 8812 (PG), 9000 (HTTP) | SQL |
| 🤖 **TypeDB** | Knowledge Graph | 3 | 1729, 8000 (HTTP) | TypeQL |

### Engine Categories

**Server-Based Databases** (PostgreSQL, MySQL, MariaDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB):
- Start/stop server processes
- Bind to localhost ports
- Data stored in `~/.spindb/containers/{engine}/{name}/`

**File-Based Databases** (SQLite, DuckDB):
- No server process required
- Data stored in your project directories
- Always "running" (embedded, no daemon)

### Binary Sources

All engines download pre-compiled binaries from [**hostdb**](https://github.com/robertjbass/hostdb), a repository of portable database binaries for all major platforms:

- **PostgreSQL**: hostdb (macOS/Linux), [EnterpriseDB](https://www.enterprisedb.com/) (Windows)
- **All other engines**: hostdb (all supported platforms)

This enables **multi-version support** without system package conflicts. Run PostgreSQL 14 for legacy projects and 18 for new ones—simultaneously.

---

## Core Commands

SpinDB provides a comprehensive CLI with commands for every database lifecycle operation.

### Container Lifecycle

```bash
# Create a new database
spindb create mydb                              # PostgreSQL (default)
spindb create mydb --engine mongodb             # MongoDB
spindb create mydb --engine mysql --db-version 8.0  # MySQL 8.0
spindb create mydb --port 5433                  # Custom port
spindb create mydb --start --connect            # Create, start, and connect
spindb create mydb --force                      # Overwrite existing container

# Start/stop databases
spindb start mydb
spindb stop mydb

# Delete database (with confirmation)
spindb delete mydb
spindb delete mydb --yes --force                # Skip prompts, force stop
```

### Data Operations

```bash
# Connect to database shell
spindb connect mydb                             # Standard client (psql, mysql, etc.)
spindb connect mydb --pgcli                     # Enhanced PostgreSQL shell
spindb connect mydb --mycli                     # Enhanced MySQL shell
spindb connect mydb --tui                       # Universal SQL client (usql)

# Execute queries and scripts
spindb run mydb script.sql                      # Run SQL file
spindb run mydb -c "SELECT * FROM users"        # Inline SQL
spindb run mydb seed.js                         # JavaScript (MongoDB)
spindb run mydb -c "SET foo bar"                # Redis command

# Query with structured output
spindb query mydb "SELECT * FROM users LIMIT 5" # Tabular output
spindb query mydb "SELECT * FROM users" --json  # JSON for scripting
spindb query mydb "users.find()" -d mydb        # MongoDB/FerretDB
spindb query myredis "KEYS user:*"              # Redis/Valkey
spindb query myqdrant "GET /collections"        # REST API engines

# Get connection string
spindb url mydb                                 # postgresql://postgres@localhost:5432/mydb
spindb url mydb --copy                          # Copy to clipboard
spindb url mydb --json                          # JSON output with details

# Use in scripts
export DATABASE_URL=$(spindb url mydb)
psql $(spindb url mydb)
```

### User Management

```bash
# Create database users and API keys
spindb users create mydb               # Auto-generate password
spindb users create mydb --password p  # Use specific password
spindb users create mydb --copy        # Copy connection string to clipboard
spindb users create mydb --json        # JSON output for scripting
spindb users create mydb --no-save     # Don't save credential file

# List saved credentials
spindb users list mydb                         # List usernames
spindb users list mydb --json                  # JSON output
```

Supports PostgreSQL, MySQL, MariaDB, CockroachDB, ClickHouse, MongoDB, FerretDB, Redis, Valkey, SurrealDB, CouchDB, Meilisearch, and Qdrant. Not supported: SQLite, DuckDB, QuestDB, TypeDB. Credentials are saved as `.env.<username>` files in `~/.spindb/containers/{engine}/{name}/credentials/`.

### Backup & Restore

```bash
# Create backups
spindb backup mydb                              # Auto-generated filename
spindb backup mydb --name production-backup     # Custom name
spindb backup mydb --output ./backups/          # Custom directory
spindb backup mydb --format sql                 # SQL text format (PostgreSQL)
spindb backup mydb --format custom              # Custom binary format (PostgreSQL)

# Restore from backups
spindb restore mydb backup.dump
spindb restore mydb backup.sql --database prod_copy

# Clone existing database
spindb create prod-copy --from ./prod-backup.dump
spindb create staging --from "postgresql://user:pass@prod:5432/production"
```

### Pull from Remote Database

Sync production data to your local database while automatically backing up your original data:

```bash
# Pull production data (backs up original, replaces with remote)
spindb pull mydb --from "postgresql://user:pass@prod-host/db"

# Read URL from environment variable (keeps credentials out of shell history)
spindb pull mydb --from-env CLONE_FROM_DATABASE_URL

# Clone mode: pull to new database (original untouched)
spindb pull mydb --from-env PROD_URL --as mydb_prod

# Preview what will happen
spindb pull mydb --from-env PROD_URL --dry-run

# Run post-pull script (e.g., sync local credentials)
spindb pull mydb --from-env PROD_URL --post-script ./sync-credentials.ts
```

### Export to Docker

Generate a Docker-ready package from any SpinDB container:

```bash
# Export to Docker (generates Dockerfile, docker-compose.yml, etc.)
spindb export docker mydb

# Custom output directory
spindb export docker mydb -o ./deploy

# Override port (default: engine's standard port, e.g., 5432 for PostgreSQL)
spindb export docker mydb -p 5433

# Skip database backup or TLS certificates
spindb export docker mydb --no-data
spindb export docker mydb --no-tls

# JSON output for scripting
spindb export docker mydb --json --force
```

Generated files:
- `Dockerfile` - Ubuntu 22.04 + Node.js 22 + SpinDB
- `docker-compose.yml` - Container orchestration
- `.env` - Auto-generated credentials
- `certs/` - TLS certificates (self-signed)
- `data/` - Database backup
- `entrypoint.sh` - Startup script
- `README.md` - Instructions

### Deploying Your Container

**SpinDB doesn't require Docker for local development**, but it can repackage your database as a Docker image for deployment to cloud servers, EC2 instances, Kubernetes clusters, or any Docker-compatible environment.

```bash
# Export your local database to Docker
spindb export docker mydb -o ./mydb-deploy

# Build and run
cd ./mydb-deploy
docker compose build --no-cache
docker compose up -d

# Connect from host (credentials in .env)
source .env
psql "postgresql://$SPINDB_USER:$SPINDB_PASSWORD@localhost:$PORT/$DATABASE"
```

**Schema-only vs Full Data:**
```bash
spindb export docker mydb                    # Include all data (default)
spindb export docker mydb --no-data          # Schema only (empty tables)
```

> **Development Tool Notice:** SpinDB is currently a development tool. While Docker exports include TLS encryption and authentication, they are intended for staging and testing—not production workloads. For production databases, consider managed services.

**Future Export Options:** Additional export targets are planned for future releases, including direct deployment to managed database services like Neon, Supabase, and PlanetScale.

See [DEPLOY.md](DEPLOY.md) for comprehensive deployment documentation.

### Container Management

```bash
# List all databases
spindb list
spindb list --json

# Show container details
spindb info mydb
spindb info mydb --json

# Clone a database
spindb clone source-db new-db

# Edit configuration
spindb edit mydb --name newname                 # Rename
spindb edit mydb --port 5433                    # Change port
spindb edit mydb --relocate ~/new/path          # Move SQLite/DuckDB file

# View logs
spindb logs mydb
spindb logs mydb --follow                       # Follow mode (tail -f)
spindb logs mydb -n 100                         # Last 100 lines

# Manage database tracking (for external scripts)
spindb databases list mydb                      # List tracked databases
spindb databases add mydb analytics             # Add to tracking
spindb databases remove mydb old_backup         # Remove from tracking
spindb databases sync mydb oldname newname      # Sync after rename
```

### Engine & System Management

```bash
# Manage installed engines
spindb engines                                  # List installed engines
spindb engines supported                        # Show all supported engines
spindb engines delete postgresql 16             # Remove specific version

# Manage client tools
spindb deps check                               # Check all dependencies
spindb deps check --engine postgresql           # Check specific engine
spindb deps install                             # Install missing tools

# Configuration
spindb config show                              # Show current config
spindb config detect                            # Re-detect tool paths
spindb config update-check on                   # Enable update checks
spindb config update-check off                  # Disable update checks

# Doctor
spindb doctor                                   # Interactive health check
spindb doctor --fix                             # Auto-fix all issues
spindb doctor --dry-run                         # Preview fixes without applying
spindb doctor --json                            # JSON output

# Version management
spindb version                                  # Show current version
spindb version --check                          # Check for updates
spindb self-update                              # Update to latest version
```

### Interactive Menu

Don't want to remember commands? Just run:

```bash
spindb
```

You'll get an interactive menu with arrow-key navigation for all operations. **The menu is just a friendlier interface—everything is also available as a direct CLI command.**

---

## How It Works

### Architecture

SpinDB uses "container" terminology loosely—there's no Docker involved. When you create a container, SpinDB:

1. **Downloads database binaries** from [hostdb](https://github.com/robertjbass/hostdb) or uses system installations
2. **Creates isolated data directories** at `~/.spindb/containers/{engine}/{name}/`
3. **Runs databases as native processes** on your machine

Each container contains:
- `container.json` - Configuration (port, version, status)
- `data/` - Database files
- `{engine}.log` - Server logs

### Storage Layout

```bash
~/.spindb/
├── bin/                                    # Downloaded binaries
│   ├── postgresql-18.1.0-darwin-arm64/     # ~45 MB
│   ├── mysql-9.0.1-darwin-arm64/           # ~200 MB
│   └── mongodb-8.0-darwin-arm64/           # ~200 MB
├── containers/                             # Server-based databases
│   ├── postgresql/
│   │   └── myapp/
│   │       ├── container.json
│   │       ├── data/
│   │       ├── credentials/              # User credential .env.<username> files
│   │       └── postgres.log
│   ├── mysql/
│   └── mongodb/
├── logs/                                   # SpinDB error logs
└── config.json                             # Tool paths and settings

# File-based databases (SQLite, DuckDB) store in project directories
./myproject/
└── app.sqlite                              # Created with: spindb create app -e sqlite
```

### Data Persistence

Databases run as **native processes**, and **data persists across restarts**. When you stop a container:

1. SpinDB sends a graceful shutdown signal
2. The database flushes pending writes to disk
3. Data remains in the `data/` directory

**Your data is never deleted unless you explicitly run `spindb delete`.**

#### Durability by Engine

| Engine | Persistence Mechanism | Durability |
|--------|----------------------|------------|
| PostgreSQL | Write-Ahead Logging (WAL) | Committed transactions survive crashes |
| MySQL | InnoDB transaction logs | Committed transactions survive crashes |
| MariaDB | InnoDB transaction logs | Committed transactions survive crashes |
| SQLite | File-based transactions | Commits written immediately to disk |
| DuckDB | File-based transactions | Commits written immediately to disk |
| MongoDB | WiredTiger journaling | Writes journaled before acknowledged |
| Redis | RDB snapshots (periodic) | May lose ~60 seconds on unexpected crash |
| Valkey | RDB snapshots (periodic) | May lose ~60 seconds on unexpected crash |
| ClickHouse | MergeTree storage | Committed transactions survive crashes |
| CockroachDB | Raft consensus | Strongly consistent, distributed replication |
| QuestDB | Write-ahead logging | Committed transactions survive crashes |
| TypeDB | Write-ahead logging | Committed transactions survive crashes |

---

## Engine-Specific Details

### PostgreSQL 🐘

```bash
# Create PostgreSQL database
spindb create myapp --engine postgresql --db-version 18

# Multiple versions side-by-side
spindb create legacy --engine postgresql --db-version 14
spindb create modern --engine postgresql --db-version 18

# Backup formats
spindb backup myapp --format sql      # Plain SQL (.sql)
spindb backup myapp --format custom   # Binary custom format (.dump)
```

**Versions:** 15, 16, 17, 18
**Tools:** `psql`, `pg_dump`, `pg_restore` (included)
**Enhanced client:** `pgcli` (auto-completion, syntax highlighting)

### MySQL 🐬 & MariaDB 🦭

```bash
# MySQL
spindb create shop --engine mysql --db-version 9
spindb connect shop --mycli

# MariaDB (MySQL-compatible)
spindb create store --engine mariadb --db-version 11.8
```

**MySQL versions:** 8.0, 8.4, 9
**MariaDB versions:** 10.11, 11.4, 11.8
**Tools:** `mysql`, `mysqldump`, `mysqladmin` (included)

### MongoDB 🍃

```bash
# Create MongoDB database
spindb create logs --engine mongodb --db-version 8.0

# JavaScript queries (not SQL)
spindb run logs -c "db.users.insertOne({name: 'Alice'})"
spindb run logs -c "db.users.find().pretty()"
spindb run logs seed.js

# Connect with mongosh
spindb connect logs
```

**Versions:** 7.0, 8.0, 8.2
**Query language:** JavaScript (via `mongosh`)
**Tools:** `mongod`, `mongosh`, `mongodump`, `mongorestore` (included)

### FerretDB 🦔

```bash
# Create FerretDB database (MongoDB-compatible, PostgreSQL backend)
spindb create docs --engine ferretdb

# Same MongoDB queries work
spindb run docs -c "db.users.insertOne({name: 'Alice'})"
spindb run docs -c "db.users.find().pretty()"

# Connect with mongosh
spindb connect docs
```

**Version:** 2 (2.7.0)
**Platforms:** macOS, Linux (no Windows support)
**Architecture:** FerretDB proxy + PostgreSQL with DocumentDB extension
**Query language:** JavaScript (via `mongosh`)
**Backups:** Uses `pg_dump` on embedded PostgreSQL backend
**Tools:** `ferretdb`, `mongosh` (for client connections), `pg_dump`/`pg_restore` (bundled with embedded PostgreSQL)

FerretDB is a MongoDB-compatible database that stores data in PostgreSQL. It's useful when you want MongoDB's API but PostgreSQL's reliability and SQL access to your data.

### Redis 🔴 & Valkey 🔷

```bash
# Redis
spindb create cache --engine redis --db-version 8

# Valkey (Redis fork with BSD-3 license)
spindb create sessions --engine valkey --db-version 9

# Redis commands
spindb run cache -c "SET mykey myvalue"
spindb run cache -c "GET mykey"

# Enhanced shell
spindb connect cache --iredis
```

**Redis versions:** 7, 8
**Valkey versions:** 8, 9
**Query language:** Redis commands
**Databases:** Numbered 0-15 (not named)
**Tools:** `redis-cli`, `redis-server` / `valkey-cli`, `valkey-server` (included)

### SQLite 🪶 & DuckDB 🦆

```bash
# SQLite - embedded relational database
spindb create app --engine sqlite --path ./data/app.sqlite
spindb connect app

# DuckDB - embedded analytics database (OLAP)
spindb create analytics --engine duckdb --path ./data/warehouse.duckdb
spindb connect analytics
```

**No server process** - File-based databases stored in your project directories.
**No start/stop needed** - Always "running" (embedded).
**SQLite tools:** `sqlite3`, `sqldiff`, `sqlite3_analyzer` (included)
**DuckDB tools:** `duckdb` (included)

### ClickHouse 🏠

```bash
# Create ClickHouse database (columnar OLAP)
spindb create warehouse --engine clickhouse

# SQL with ClickHouse extensions
spindb run warehouse -c "CREATE TABLE events (timestamp DateTime, user_id UInt64) ENGINE = MergeTree() ORDER BY timestamp"
spindb run warehouse -c "SELECT * FROM system.tables"
```

**Version:** 25.12 (YY.MM versioning)
**Platforms:** macOS, Linux (no Windows support)
**Ports:** 9000 (native TCP), 8123 (HTTP)
**Tools:** `clickhouse-client`, `clickhouse-server` (included)

### Qdrant 🧭

```bash
# Create Qdrant database (vector similarity search)
spindb create vectors --engine qdrant
spindb start vectors

# Access via REST API
curl http://127.0.0.1:6333/collections
```

**Version:** 1 (1.16.3)
**Platforms:** macOS, Linux, Windows (all platforms)
**Ports:** 6333 (REST/HTTP), 6334 (gRPC)
**Query interface:** REST API (no CLI shell - use curl or API clients)
**Tools:** `qdrant` (included)

### CockroachDB 🪳

```bash
# Create CockroachDB database (distributed SQL)
spindb create cluster --engine cockroachdb
spindb start cluster

# PostgreSQL-compatible SQL
spindb run cluster -c "CREATE TABLE users (id INT PRIMARY KEY, name STRING)"
spindb run cluster -c "SELECT * FROM users"

# Connect with cockroach sql shell
spindb connect cluster
```

**Version:** 25 (25.4.2)
**Platforms:** macOS, Linux, Windows (all platforms)
**Ports:** 26257 (SQL), HTTP Admin UI on SQL port + 1 (default 26258)
**Query language:** SQL (PostgreSQL-compatible)
**Tools:** `cockroach` (included)
**Default user:** `root`
**Default database:** `defaultdb`

CockroachDB is a distributed SQL database with automatic replication and failover. Single-node mode is used for local development.

---

## Enhanced CLI Tools

SpinDB supports enhanced database shells with auto-completion, syntax highlighting, and better formatting:

| Engine | Standard Client | Enhanced Client | Universal Client |
|--------|----------------|-----------------|------------------|
| PostgreSQL | `psql` | `pgcli` | `usql` |
| MySQL | `mysql` | `mycli` | `usql` |
| MariaDB | `mariadb` | `mycli` | `usql` |
| SQLite | `sqlite3` | `litecli` | `usql` |
| DuckDB | `duckdb` | - | `usql` |
| MongoDB | `mongosh` | - | - |
| FerretDB | `mongosh` | - | - |
| Redis | `redis-cli` | `iredis` | - |
| Valkey | `valkey-cli` | `iredis` (compatible) | - |
| ClickHouse | `clickhouse-client` | - | `usql` |
| Qdrant | REST API | - | - |
| Meilisearch | REST API | - | - |
| CouchDB | REST API | - | - |
| CockroachDB | `cockroach sql` | - | - |
| QuestDB | `psql` | `pgcli` | `usql` |
| TypeDB | `typedb console` | - | - |

Install and use in one command:

```bash
spindb connect mydb --install-pgcli
spindb connect mydb --install-mycli
spindb connect mydb --install-tui      # usql (universal)
```

---

## Backup & Restore

Every engine supports backup and restore with engine-specific formats:

### PostgreSQL

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| sql | `.sql` | pg_dump | Human-readable, portable |
| custom | `.dump` | pg_dump -Fc | Compressed, faster restore |

```bash
spindb backup mydb --format sql         # Plain SQL
spindb backup mydb --format custom      # Binary custom format
spindb restore mydb backup.dump
```

### MySQL & MariaDB

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| sql | `.sql` | mysqldump / mariadb-dump | Human-readable |
| compressed | `.sql.gz` | mysqldump + gzip | Smaller file size |

```bash
spindb backup mydb --format sql         # Plain SQL
spindb backup mydb --format compressed  # Compressed SQL
```

### MongoDB

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| bson | _(directory)_ | mongodump | Binary, preserves all types |
| archive | `.archive` | mongodump --archive | Single compressed file |

```bash
spindb backup mydb --format bson        # BSON directory
spindb backup mydb --format archive     # Single .archive file
```

### Redis & Valkey

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| rdb | `.rdb` | BGSAVE | Binary snapshot, requires stop/start |
| text | `.redis` / `.valkey` | Custom | Human-readable commands |

```bash
spindb backup mydb --format rdb         # RDB snapshot (default)
spindb backup mydb --format text        # Text commands

# Restore with merge or replace strategy
spindb restore mydb backup.redis        # Prompts: Replace all / Merge
```

### SQLite & DuckDB

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| sql | `.sql` | .dump / duckdb | Human-readable |
| binary | `.sqlite` / `.duckdb` | File copy | Exact database copy |

```bash
spindb backup mydb --format sql         # SQL dump
spindb backup mydb --format binary      # Binary copy (default)
```

### ClickHouse

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| sql | `.sql` | clickhouse-client | Plain SQL dump |

```bash
spindb backup mydb --format sql         # SQL dump (only format)
```

### Qdrant

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| snapshot | `.snapshot` | REST API | Full database snapshot |

```bash
spindb backup mydb --format snapshot    # Snapshot (only format)
```

### Meilisearch

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| snapshot | `.snapshot` | REST API | Full instance snapshot |

```bash
spindb backup mydb --format snapshot    # Snapshot (only format)
```

### CockroachDB

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| sql | `.sql` | cockroach dump | Plain SQL dump |

```bash
spindb backup mydb --format sql         # SQL dump (only format)
```

### QuestDB

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| sql | `.sql` | psql (PostgreSQL wire protocol) | Plain SQL dump |

```bash
spindb backup mydb --format sql         # SQL dump (only format)
```

> **Note:** QuestDB backup/restore requires the PostgreSQL engine to be installed (for `psql`).

### TypeDB

| Format | Extension | Tool | Use Case |
|--------|-----------|------|----------|
| typeql | `.typeql` | typedb console | TypeQL schema + data export |

```bash
spindb backup mydb --format typeql      # TypeQL export (only format)
```

---

## Advanced Features

### Clone Databases

Create exact copies of existing databases:

```bash
# Clone local database (must be stopped)
spindb stop production
spindb clone production staging
spindb start production
spindb start staging
```

### Restore from Remote

Pull production data into local databases. **All engines support remote restore via connection strings:**

```bash
# Create new database from remote
spindb create prod-copy --from "postgresql://user:pass@prod-host:5432/production"

# Or restore into existing database
spindb restore mydb --from-url "postgresql://user:pass@prod-host:5432/production"
```

**Supported connection string formats:**

| Engine | Format | Example |
|--------|--------|---------|
| PostgreSQL | `postgresql://` or `postgres://` | `postgresql://user:pass@host:5432/db` |
| MySQL | `mysql://` | `mysql://root:pass@host:3306/db` |
| MariaDB | `mysql://` or `mariadb://` | `mariadb://root:pass@host:3307/db` |
| MongoDB | `mongodb://` or `mongodb+srv://` | `mongodb://user:pass@host:27017/db` |
| Redis | `redis://` | `redis://:password@host:6379/0` |
| Valkey | `redis://` | `redis://:password@host:6379/0` |
| ClickHouse | `clickhouse://` or `http://` | `clickhouse://default:pass@host:8123/db` |
| Qdrant | `qdrant://` or `http://` | `http://host:6333?api_key=KEY` |
| Meilisearch | `meilisearch://` or `http://` | `http://host:7700?api_key=KEY` |
| CouchDB | `couchdb://` or `http://` | `http://user:pass@host:5984/db` |
| CockroachDB | `postgresql://` or `postgres://` | `postgresql://root@host:26257/db?sslmode=disable` |
| QuestDB | `postgresql://` or `postgres://` | `postgresql://admin:quest@host:8812/qdb` |
| TypeDB | `typedb://` | `typedb://host:1729` |

### Multi-Version Support

Run different versions of the same database simultaneously:

```bash
# PostgreSQL 14 for legacy app
spindb create legacy-api --engine postgresql --db-version 14 --port 5432

# PostgreSQL 18 for new app
spindb create modern-api --engine postgresql --db-version 18 --port 5433

# Both running at the same time
spindb list
# NAME         ENGINE       VERSION  PORT   STATUS
# legacy-api   postgresql   14       5432   running
# modern-api   postgresql   18       5433   running
```

### Custom Ports

SpinDB auto-assigns ports, but you can override:

```bash
spindb create mydb --port 5433
spindb edit mydb --port 5434          # Change later
```

### SQLite & DuckDB Registry

File-based databases can be registered for easy access:

```bash
# Create and register
spindb create mydb --engine sqlite --path ./data/app.sqlite

# Attach existing database
spindb attach ./existing/data.sqlite --name legacy-db

# Detach (removes from registry, keeps file)
spindb detach legacy-db
```

---

## Roadmap

See [TODO.md](TODO.md) for the complete roadmap.

### v1.1 - Remote Connections & Secrets
- Direct remote database connections (`spindb connect --remote`)
- Environment variable support in connection strings
- Secrets management with macOS Keychain integration

### v1.2 - Advanced Features
- Container templates for common configurations
- Scheduled automated backups
- Import databases from Docker containers

### Future Engines Under Consideration

The following engines may be added based on community interest:

| Engine | Type | Notes |
|--------|------|-------|
| **libSQL** | Embedded relational | SQLite fork with replication |
| **OpenSearch** | Search engine | Elasticsearch alternative |
| **InfluxDB** | Time-series | Metrics and IoT data |
| **Neo4j** | Graph database | Relationships and network data |

---

## Limitations

- **Local only** - Databases bind to `127.0.0.1`. Remote connection support planned for v1.1.
- **ClickHouse Windows** - Not supported (hostdb doesn't build for Windows).
- **FerretDB Windows** - Not supported (postgresql-documentdb has startup issues on Windows).
- **Qdrant, Meilisearch & CouchDB** - Use REST API instead of CLI shell. Access via HTTP at the configured port.

---

## Troubleshooting

### Port Already in Use

SpinDB automatically finds available ports, but you can specify:

```bash
spindb create mydb --port 5433
```

### Container Won't Start

Check the logs:

```bash
spindb logs mydb
# or
cat ~/.spindb/containers/postgresql/mydb/postgres.log
```

### Client Tool Not Found

Install dependencies:

```bash
spindb deps install
spindb deps check
```

### Binary Download Fails

SpinDB downloads from [hostdb GitHub Releases](https://github.com/robertjbass/hostdb/releases). If downloads fail:

1. Check your internet connection
2. Verify GitHub isn't blocked by your firewall
3. Try again (SpinDB has automatic retry logic)

### Reset Everything

```bash
rm -rf ~/.spindb
```

This deletes all containers, binaries, and configuration. Use with caution.

---

## Contributing

We welcome contributions! SpinDB is built with:

- **Runtime:** Node.js 18+ with TypeScript
- **Execution:** `tsx` for direct TypeScript execution
- **Package Manager:** pnpm (strictly enforced)
- **CLI Framework:** Commander.js
- **Interactive UI:** Inquirer.js, Chalk, Ora

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and testing guidelines.

See [ARCHITECTURE.md](ARCHITECTURE.md) for project architecture details.

See [CLAUDE.md](CLAUDE.md) for AI-assisted development context.

See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for adding new database engines.

See [USE_CASES.md](USE_CASES.md) for detailed use cases and infrastructure opportunities.

---

## Acknowledgments

SpinDB is powered by:

- **[hostdb](https://github.com/robertjbass/hostdb)** - Pre-compiled database binaries for 17 engines across all major platforms. Makes Docker-free multi-version database support possible.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE)

SpinDB is **free** for:
- Personal use and hobby projects
- Educational institutions and students
- Academic and scientific research
- Nonprofit organizations
- Government agencies

**Commercial use requires a separate license.** For commercial licensing inquiries, please open an issue or contact the maintainer.

---

## Links

- **GitHub:** [github.com/robertjbass/spindb](https://github.com/robertjbass/spindb)
- **npm:** [npmjs.com/package/spindb](https://www.npmjs.com/package/spindb)
- **hostdb:** [github.com/robertjbass/hostdb](https://github.com/robertjbass/hostdb)
- **Issues:** [github.com/robertjbass/spindb/issues](https://github.com/robertjbass/spindb/issues)

---

**Questions? Found a bug? Have a feature request?**

Open an issue: [github.com/robertjbass/spindb/issues](https://github.com/robertjbass/spindb/issues)
