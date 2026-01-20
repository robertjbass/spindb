# SpinDB

[![npm version](https://img.shields.io/npm/v/spindb.svg)](https://www.npmjs.com/package/spindb)
[![npm downloads](https://img.shields.io/npm/dm/spindb.svg)](https://www.npmjs.com/package/spindb)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](LICENSE)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#platform-coverage)

**One CLI for all your local databases.**

SpinDB is a universal database management tool that combines a package manager, a unified API, and native client tooling for 9 different database engines—all from a single command-line interface. No Docker, no VMs, no platform-specific installers. Just databases, running natively on your machine.

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
spindb create mydb --engine [postgresql|mysql|mariadb|mongodb|redis|valkey|clickhouse|sqlite|duckdb]
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

## Platform Coverage

SpinDB works across **9 database engines** and **5 platform architectures** with a **single, consistent API**.

| Database | macOS ARM64 | macOS Intel | Linux x64 | Linux ARM64 | Windows x64 |
|----------|:-----------:|:-----------:|:---------:|:-----------:|:-----------:|
| 🐘 **PostgreSQL** | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🐬 **MySQL** | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦭 **MariaDB** | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🪶 **SQLite** | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦆 **DuckDB** | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🍃 **MongoDB** | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔴 **Redis** | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔷 **Valkey** | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🏠 **ClickHouse** | ✅ | ✅ | ✅ | ✅ | ❌ |

**44 combinations. One CLI. Zero configuration.**

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

### Comparison Matrix

| Feature | SpinDB | Docker | DBngin | Postgres.app | XAMPP |
|---------|--------|--------|--------|--------------|-------|
| No Docker required | ✅ | ❌ | ✅ | ✅ | ✅ |
| Multiple DB engines | ✅ 9 engines | ✅ Unlimited | ✅ 3 engines | ❌ PostgreSQL only | ⚠️ MySQL only |
| CLI-first | ✅ | ✅ | ❌ GUI-first | ❌ GUI-first | ❌ GUI-first |
| Multiple versions | ✅ | ✅ | ✅ | ✅ | ❌ |
| Clone databases | ✅ | Manual | ✅ | ❌ | ❌ |
| Backup/restore built-in | ✅ | Manual | ✅ | ❌ | ❌ |
| Low resource usage | ✅ Native | ❌ VM on macOS/Win | ✅ Native | ✅ Native | ✅ Native |
| Linux support | ✅ | ✅ | ❌ | ❌ | ✅ |
| ARM64 support | ✅ | ✅ | ✅ | ✅ | ❌ |
| Free for commercial use | ❌ | ⚠️ Paid for orgs | ✅ | ✅ | ✅ |

---

## Supported Databases

SpinDB supports **9 database engines** with **multiple versions** for each:

| Engine | Type | Versions | Default Port | Query Language |
|--------|------|----------|--------------|----------------|
| 🐘 **PostgreSQL** | Relational (SQL) | 15, 16, 17, 18 | 5432 | SQL |
| 🐬 **MySQL** | Relational (SQL) | 8.0, 8.4, 9 | 3306 | SQL |
| 🦭 **MariaDB** | Relational (SQL) | 10.11, 11.4, 11.8 | 3307 | SQL |
| 🪶 **SQLite** | Embedded (SQL) | 3 | N/A (file-based) | SQL |
| 🦆 **DuckDB** | Embedded OLAP | 1.4.3 | N/A (file-based) | SQL |
| 🍃 **MongoDB** | Document Store | 7.0, 8.0, 8.2 | 27017 | JavaScript (mongosh) |
| 🔴 **Redis** | Key-Value Store | 7, 8 | 6379 | Redis commands |
| 🔷 **Valkey** | Key-Value Store | 8, 9 | 6379 | Redis commands |
| 🏠 **ClickHouse** | Columnar OLAP | 25.12 | 9000 (TCP), 8123 (HTTP) | SQL (ClickHouse dialect) |

### Engine Categories

**Server-Based Databases** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse):
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

# Get connection string
spindb url mydb                                 # postgresql://postgres@localhost:5432/mydb
spindb url mydb --copy                          # Copy to clipboard
spindb url mydb --json                          # JSON output with details

# Use in scripts
export DATABASE_URL=$(spindb url mydb)
psql $(spindb url mydb)
```

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

# Pull from remote database
spindb restore mydb --from-url "postgresql://user:pass@prod-host/db"

# Clone existing database
spindb create prod-copy --from ./prod-backup.dump
spindb create staging --from "postgresql://user:pass@prod:5432/production"
```

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
spindb config update-check on                   # Enable update notifications

# System health
spindb doctor                                   # Interactive health check
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

---

## Engine-Specific Details

Each database engine has unique features and behaviors. See full documentation in [ENGINES.md](ENGINES.md).

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
| Redis | `redis-cli` | `iredis` | - |
| Valkey | `valkey-cli` | `iredis` (compatible) | - |
| ClickHouse | `clickhouse-client` | - | `usql` |

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

Pull production data into local databases:

```bash
# Create new database from remote
spindb create prod-copy --from "postgresql://user:pass@prod-host:5432/production"

# Or restore into existing database
spindb restore mydb --from-url "postgresql://user:pass@prod-host:5432/production"
```

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

### v1.2 - Additional Engines
- **CockroachDB** - Distributed PostgreSQL-compatible database
- **FerretDB** - MongoDB-compatible database built on PostgreSQL

### v1.3 - Advanced Features
- Container templates for common configurations
- Scheduled automated backups
- Import databases from Docker containers

### Future Engines Under Consideration

The following engines may be added based on community interest:

| Engine | Type | Notes |
|--------|------|-------|
| **libSQL** | Embedded relational | SQLite fork with replication |
| **Meilisearch** | Search engine | Developer-friendly full-text search |
| **OpenSearch** | Search engine | Elasticsearch alternative |
| **InfluxDB** | Time-series | Metrics and IoT data |
| **Neo4j** | Graph database | Relationships and network data |

---

## Limitations

- **Local only** - Databases bind to `127.0.0.1`. Remote connection support planned for v1.1.
- **ClickHouse Windows** - Not supported (hostdb doesn't build for Windows).
- **Redis/Valkey remote dump** - Cannot create containers directly from remote connection strings. Use backup/restore workflow instead.

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

See [FEATURE.md](FEATURE.md) for adding new database engines.

---

## Acknowledgments

SpinDB is powered by:

- **[hostdb](https://github.com/robertjbass/hostdb)** - Pre-compiled database binaries for 9 engines across all major platforms. Makes Docker-free multi-version database support possible.

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
