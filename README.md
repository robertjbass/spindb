# SpinDB

[![npm version](https://img.shields.io/npm/v/spindb.svg)](https://www.npmjs.com/package/spindb)
[![npm downloads](https://img.shields.io/npm/dm/spindb.svg)](https://www.npmjs.com/package/spindb)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](LICENSE)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#platform-support-vs-alternatives)

**The first npm CLI for running local databases without Docker.**

Spin up PostgreSQL, MySQL, MariaDB, SQLite, MongoDB, Redis, Valkey, and ClickHouse instances for local development. No Docker daemon, no container networking, no volume mounts. Just databases running on localhost, ready in seconds.

---

## Quick Start

```bash
# Install globally (or use pnpm/yarn)
npm install -g spindb

# Create and start a PostgreSQL database
spindb create myapp

# Connect to it
spindb connect myapp

# You're in! Run some SQL:
# postgres=# CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);
```

That's it. Your database is running on `localhost:5432`, and your data persists in `~/.spindb/containers/postgresql/myapp/`.

---

## Why SpinDB?

Docker is great for production parity and complex multi-service setups. But for local development databases, it's often overkill:

- **Resource overhead** - Docker Desktop runs a Linux VM on macOS/Windows
- **Complexity** - Volumes, networks, compose files for a single database
- **Startup time** - Container initialization vs native process launch
- **Licensing** - Docker Desktop requires a paid subscription for larger organizations

Sometimes you just want PostgreSQL on `localhost:5432` without the ceremony.

SpinDB runs databases as native processes with isolated data directories. No VM, no daemon, no container networking. Just databases.

### SpinDB vs Alternatives

| Feature | SpinDB | Docker | DBngin | Postgres.app | XAMPP |
|---------|--------|--------|--------|--------------|-------|
| No Docker required | ✅ | ❌ | ✅ | ✅ | ✅ |
| Multiple DB engines | ✅ | ✅ | ✅ | ❌ | ⚠️ MySQL only |
| CLI-first | ✅ | ✅ | ❌ | ❌ | ❌ |
| Multiple versions | ✅ | ✅ | ✅ | ✅ | ❌ |
| Clone databases | ✅ | Manual | ✅ | ❌ | ❌ |
| Low resource usage | ✅ | ❌ | ✅ | ✅ | ✅ |
| Linux support | ✅ | ✅ | ❌ | ❌ | ✅ |
| Free | ✅ | ⚠️ | ✅ | ✅ | ✅ |

### Platform Support vs Alternatives

| Platform | SpinDB | Docker | DBngin | Postgres.app | XAMPP |
|----------|--------|--------|--------|--------------|-------|
| macOS (ARM64) | ✅ | ✅ | ✅ | ✅ | ✅ |
| macOS (Intel) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Linux (x64) | ✅ | ✅ | ❌ | ❌ | ✅ |
| Linux (ARM64) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Windows (x64) | ✅ | ✅ | ❌ | ❌ | ✅ |

---

## Installation

SpinDB is distributed via npm. A global install is recommended so you can run `spindb` from anywhere.

We recommend [pnpm](https://pnpm.io/) as a faster, more disk-efficient alternative to npm.

```bash
# Using pnpm (recommended)
pnpm add -g spindb

# Using npm
npm install -g spindb

# Or run directly without installing
pnpx spindb
npx spindb
```

### Updating

SpinDB checks for updates automatically and notifies you when a new version is available.

```bash
# Update to latest version
spindb self-update

# Or check manually
spindb version --check

# Disable automatic update checks
spindb config update-check off
```

---

## The Interactive Menu

Most of the time, you don't need to remember commands. Just run:

```bash
spindb
```

You'll get an interactive menu with arrow-key navigation:

```
? What would you like to do?
❯ Create a new container
  Manage containers
  View installed engines
  Check dependencies
  Settings
  Exit
```

**Everything in the menu is also available as a CLI command.** The menu is just a friendlier interface for the same operations. If you prefer typing commands or scripting, SpinDB has full CLI support.

---

## Database Engines

### Supported Engines

#### PostgreSQL

| | |
|---|---|
| Versions | 15, 16, 17, 18 |
| Default port | 5432 |
| Default user | `postgres` |
| Binary source | [hostdb](https://github.com/robertjbass/hostdb) (macOS/Linux), [EDB](https://www.enterprisedb.com/) (Windows) |

SpinDB downloads PostgreSQL server binaries automatically:
- **macOS/Linux:** Pre-compiled binaries from [hostdb](https://github.com/robertjbass/hostdb) on GitHub Releases
- **Windows:** Official binaries from EnterpriseDB (EDB)

**Why download binaries instead of using system PostgreSQL?** The hostdb project provides pre-configured, portable PostgreSQL binaries—just extract and run. This lets you run PostgreSQL 14 for one project and 18 for another, side-by-side, without conflicts.

**Client tools included:** PostgreSQL binaries include `psql`, `pg_dump`, and `pg_restore` for all operations.

#### MariaDB

| | |
|---|---|
| Versions | 10.11, 11.4, 11.8 |
| Default port | 3307 |
| Default user | `root` |
| Binary source | [hostdb](https://github.com/robertjbass/hostdb) |

SpinDB downloads MariaDB server binaries automatically from [hostdb](https://github.com/robertjbass/hostdb) on GitHub Releases—just like PostgreSQL. This provides multi-version support and works across all platforms.

```bash
# Create a MariaDB container
spindb create mydb --engine mariadb

# Or using the alias
spindb create mydb -e maria

# Check what's available
spindb deps check --engine mariadb
```

MariaDB is MySQL-compatible, so most MySQL tools and clients work seamlessly. If you need MySQL-specific features, use the `mysql` engine instead.

#### MySQL

| | |
|---|---|
| Versions | 8.0, 8.4, 9 |
| Default port | 3306 |
| Default user | `root` |
| Binary source | [hostdb](https://github.com/robertjbass/hostdb) |

SpinDB downloads MySQL server binaries automatically from [hostdb](https://github.com/robertjbass/hostdb) on GitHub Releases—just like PostgreSQL and MariaDB. This provides multi-version support and works across all platforms.

```bash
# Create a MySQL container
spindb create mydb --engine mysql

# Create with specific version
spindb create mydb --engine mysql --version 8.0

# Check what's available
spindb deps check --engine mysql
```

**Client tools included:** MySQL binaries include `mysql`, `mysqldump`, and `mysqladmin` for all operations. No system installation required.

#### SQLite

| | |
|---|---|
| Version | 3 |
| Default port | N/A (file-based) |
| Data location | Project directory (CWD) |
| Binary source | [hostdb](https://github.com/robertjbass/hostdb) |

SQLite is a file-based database—no server process, no ports. Databases are stored in your project directory by default, not `~/.spindb/`. SpinDB tracks registered SQLite databases in a registry file.

**Tools included:** SQLite binaries include `sqlite3`, `sqldiff`, `sqlite3_analyzer`, and `sqlite3_rsync`. No system installation required.

```bash
# Create in current directory
spindb create mydb --engine sqlite

# Create with custom path
spindb create mydb --engine sqlite --path ./data/mydb.sqlite

# Connect to it
spindb connect mydb

# Use litecli for enhanced experience
spindb connect mydb --litecli
```

**Note:** Unlike server databases, SQLite databases don't need to be "started" or "stopped"—they're always available as long as the file exists.

#### MongoDB

| | |
|---|---|
| Versions | 7.0, 8.0, 8.2 |
| Default port | 27017 |
| Default user | None (no auth by default) |
| Binary source | [hostdb](https://github.com/robertjbass/hostdb) |

SpinDB downloads MongoDB server binaries automatically from [hostdb](https://github.com/robertjbass/hostdb) on GitHub Releases—just like PostgreSQL, MariaDB, and MySQL. This provides multi-version support on all platforms.

```bash
# Create a MongoDB container (downloads binaries automatically)
spindb create mydb --engine mongodb

# Create with specific version
spindb create mydb --engine mongodb --version 8.0

# Check what's available
spindb deps check --engine mongodb
```

MongoDB uses JavaScript for queries instead of SQL. When using `spindb run`, pass JavaScript code:

```bash
# Insert a document
spindb run mydb -c "db.users.insertOne({name: 'Alice', email: 'alice@example.com'})"

# Query documents
spindb run mydb -c "db.users.find().pretty()"

# Run a JavaScript file
spindb run mydb --file ./scripts/seed.js
```

#### Redis

| | |
|---|---|
| Versions | 7, 8 |
| Default port | 6379 |
| Default user | None (no auth by default) |
| Binary source | [hostdb](https://github.com/robertjbass/hostdb) |

SpinDB downloads Redis server binaries automatically from [hostdb](https://github.com/robertjbass/hostdb) on GitHub Releases—just like PostgreSQL, MariaDB, MySQL, and MongoDB. This provides multi-version support on all platforms.

```bash
# Create a Redis container (downloads binaries automatically)
spindb create mydb --engine redis

# Create with specific version
spindb create mydb --engine redis --version 8

# Check what's available
spindb deps check --engine redis
```

Redis uses numbered databases (0-15) instead of named databases. When using `spindb run`, pass Redis commands:

```bash
# Set a key
spindb run myredis -c "SET mykey myvalue"

# Get a key
spindb run myredis -c "GET mykey"

# Run a Redis command file
spindb run myredis --file ./scripts/seed.redis

# Use iredis for enhanced shell experience
spindb connect myredis --iredis
```

**Note:** Redis doesn't support remote dump/restore. Creating containers from remote Redis connection strings is not supported. Use `backup` and `restore` commands for data migration.

#### Valkey

| | |
|---|---|
| Versions | 8, 9 |
| Default port | 6379 |
| Default user | None (no auth by default) |
| Binary source | [hostdb](https://github.com/robertjbass/hostdb) |

Valkey is a Redis fork created after Redis changed its license (RSALv2/SSPLv1). It's fully API-compatible with Redis, making it a drop-in replacement with permissive BSD-3 licensing.

SpinDB downloads Valkey server binaries automatically from [hostdb](https://github.com/robertjbass/hostdb) on GitHub Releases. This provides multi-version support on all platforms.

```bash
# Create a Valkey container (downloads binaries automatically)
spindb create mydb --engine valkey

# Create with specific version
spindb create mydb --engine valkey --version 9

# Check what's available
spindb deps check --engine valkey
```

Valkey uses the same commands as Redis:

```bash
# Set a key
spindb run myvalkey -c "SET mykey myvalue"

# Get a key
spindb run myvalkey -c "GET mykey"

# Run a command file
spindb run myvalkey --file ./scripts/seed.valkey

# Use iredis for enhanced shell experience (Redis-protocol compatible)
spindb connect myvalkey --iredis
```

**Note:** Valkey uses `redis://` connection scheme for client compatibility since it's wire-compatible with Redis.

#### ClickHouse

| | |
|---|---|
| Versions | 25.12 |
| Default port | 9000 (native TCP), 8123 (HTTP) |
| Default user | `default` |
| Binary source | [hostdb](https://github.com/robertjbass/hostdb) |

ClickHouse is a column-oriented OLAP database designed for fast analytics on large datasets. SpinDB downloads ClickHouse server binaries automatically from [hostdb](https://github.com/robertjbass/hostdb) on GitHub Releases.

**Note:** ClickHouse is only available on macOS and Linux. Windows is not supported.

```bash
# Create a ClickHouse container (downloads binaries automatically)
spindb create mydb --engine clickhouse

# Create with specific version
spindb create mydb --engine clickhouse --version 25.12

# Check what's available
spindb deps check --engine clickhouse
```

ClickHouse uses SQL (with ClickHouse-specific extensions):

```bash
# Create a table
spindb run mych -c "CREATE TABLE users (id UInt64, name String) ENGINE = MergeTree() ORDER BY id"

# Insert data
spindb run mych -c "INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob')"

# Query data
spindb run mych -c "SELECT * FROM users"

# Run a SQL file
spindb run mych --file ./scripts/seed.sql
```

### hostdb Platform Coverage

SpinDB downloads database binaries from [hostdb](https://github.com/robertjbass/hostdb), a repository of pre-built database binaries for all major platforms. The following table shows current platform support and integration status:

| Icon | Meaning |
|:----:|---------|
| ✅ | Integrated with SpinDB |
| 🟦 | Pending SpinDB integration (hostdb ready) |
| 🟪 | Planned for hostdb (pending/in-progress) |

| Database | macOS ARM64 | macOS Intel | Linux x64 | Linux ARM64 | Windows x64 |
|----------|:-----------:|:-----------:|:---------:|:-----------:|:-----------:|
| **Integrated** |||||
| PostgreSQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| MySQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| MariaDB | ✅ | ✅ | ✅ | ✅ | ✅ |
| SQLite | ✅ | ✅ | ✅ | ✅ | ✅ |
| MongoDB* | ✅ | ✅ | ✅ | ✅ | ✅ |
| Redis* | ✅ | ✅ | ✅ | ✅ | ✅ |
| Valkey | ✅ | ✅ | ✅ | ✅ | ✅ |
| ClickHouse* | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Planned for hostdb** |||||
| CockroachDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| TimescaleDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| DuckDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| Meilisearch | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| OpenSearch | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| QuestDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| FerretDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| TiDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| ArangoDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| Qdrant | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| Apache Cassandra | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| InfluxDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| CouchDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| KeyDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| libSQL | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| FoundationDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |
| RocksDB | 🟪 | 🟪 | 🟪 | 🟪 | 🟪 |

**Notes:**
- **\*** Licensing considerations for commercial use — consider Valkey (Redis) or FerretDB (MongoDB) as alternatives
- **PostgreSQL** uses [EDB](https://www.enterprisedb.com/) binaries on Windows instead of hostdb
- **ClickHouse** Windows binaries are not available on hostdb (macOS and Linux only)
- **Valkey** is a Redis-compatible drop-in replacement with permissive licensing
- **CockroachDB** is planned for both hostdb and SpinDB (see [roadmap](TODO.md))
- All databases under "Planned for hostdb" have permissive open-source licenses (Apache 2.0, MIT, or BSD)

For the latest platform support, see the [hostdb databases.json](https://github.com/robertjbass/hostdb/blob/main/databases.json).

---

## Commands

### Container Lifecycle

#### `create` - Create a new container

```bash
spindb create mydb                           # PostgreSQL (default)
spindb create mydb --engine mariadb          # MariaDB
spindb create mydb --engine mysql            # MySQL
spindb create mydb --engine sqlite           # SQLite (file-based)
spindb create mydb --db-version 16           # Specific PostgreSQL version
spindb create mydb --port 5433               # Custom port
spindb create mydb --database my_app         # Custom database name
spindb create mydb --no-start                # Create without starting

# Create, start, and connect in one command
spindb create mydb --start --connect

# SQLite with custom path
spindb create mydb --engine sqlite --path ./data/app.sqlite
```

Create and restore in one command:

```bash
spindb create mydb --from ./backup.dump
spindb create mydb --from "postgresql://user:pass@host:5432/production"
```

<details>
<summary>All options</summary>

| Option | Description |
|--------|-------------|
| `--engine`, `-e` | Database engine (`postgresql`, `mariadb`, `mysql`, `sqlite`, `mongodb`, `redis`, `valkey`, `clickhouse`) |
| `--db-version` | Engine version (e.g., 17 for PostgreSQL, 11.8 for MariaDB, 8 for Redis, 9 for Valkey) |
| `--port`, `-p` | Port number (not applicable for SQLite) |
| `--database`, `-d` | Primary database name (Redis uses 0-15) |
| `--path` | File path for SQLite databases |
| `--max-connections` | Maximum database connections (default: 200) |
| `--from` | Restore from backup file or connection string |
| `--start` | Start container after creation (skip prompt) |
| `--no-start` | Create without starting |
| `--connect` | Open a shell connection after creation |

</details>

#### `start` - Start a container

```bash
spindb start mydb
```

#### `stop` - Stop a container

```bash
spindb stop mydb
```

#### `delete` - Delete a container

```bash
spindb delete mydb
spindb delete mydb --yes      # Skip confirmation prompt
spindb delete mydb --force    # Force stop if running
spindb delete mydb -fy        # Both: force stop + skip confirmation
```

<details>
<summary>All options</summary>

| Option | Description |
|--------|-------------|
| `--force`, `-f` | Force stop if container is running before deleting |
| `--yes`, `-y` | Skip confirmation prompt (for scripts/automation) |
| `--json`, `-j` | Output result as JSON |

</details>

### Data Operations

#### `connect` - Open database shell

```bash
spindb connect mydb                 # Standard shell (psql/mysql)
spindb connect mydb --pgcli         # Enhanced PostgreSQL shell
spindb connect mydb --mycli         # Enhanced MySQL shell
spindb connect mydb --tui           # Universal SQL client (usql)
```

Install enhanced shells on-the-fly:

```bash
spindb connect mydb --install-pgcli
spindb connect mydb --install-mycli
spindb connect mydb --install-tui
```

#### `run` - Execute SQL/scripts/commands

```bash
spindb run mydb script.sql                  # Run a SQL file
spindb run mydb -c "SELECT * FROM users"    # Run inline SQL
spindb run mydb seed.sql --database my_app  # Target specific database

# MongoDB uses JavaScript instead of SQL
spindb run mydb seed.js                               # Run a JavaScript file
spindb run mydb -c "db.users.find().pretty()"         # Run inline JavaScript

# Redis uses Redis commands
spindb run myredis -c "SET foo bar"                   # Run inline command
spindb run myredis seed.redis                         # Run command file
```

#### `url` - Get connection string

```bash
spindb url mydb                    # postgresql://postgres@localhost:5432/mydb
spindb url mydb --copy             # Copy to clipboard
spindb url mydb --json             # JSON output with details

# Use in scripts
export DATABASE_URL=$(spindb url mydb)
psql $(spindb url mydb)
```

#### `backup` - Create a backup

```bash
spindb backup mydb                          # Auto-generated filename
spindb backup mydb --name my-backup         # Custom name
spindb backup mydb --output ./backups/      # Custom directory
spindb backup mydb --database my_app        # Backup specific database
```

Backup formats (vary by engine):

```bash
spindb backup mydb --format sql     # Plain SQL (.sql) or text commands (.redis)
spindb backup mydb --format dump    # Binary format (.dump for PG, .sql.gz for MySQL, .rdb for Redis)

# Shorthand
spindb backup mydb --sql
spindb backup mydb --dump
```

Format by engine:
- PostgreSQL: `.sql` (plain SQL) / `.dump` (pg_dump custom)
- MariaDB: `.sql` (plain SQL) / `.sql.gz` (compressed SQL)
- MySQL: `.sql` (plain SQL) / `.sql.gz` (compressed SQL)
- SQLite: `.sql` (plain SQL) / `.sqlite` (binary copy)
- MongoDB: `.bson` (BSON dump) / `.archive` (compressed archive)
- Redis: `.redis` (text commands) / `.rdb` (RDB snapshot)
- Valkey: `.valkey` (text commands) / `.rdb` (RDB snapshot)

<details>
<summary>All options</summary>

| Option | Description |
|--------|-------------|
| `--database`, `-d` | Database to backup (defaults to primary) |
| `--name`, `-n` | Custom backup filename (without extension) |
| `--output`, `-o` | Output directory (defaults to current directory) |
| `--format` | Output format: `sql` or `dump` |
| `--sql` | Shorthand for `--format sql` |
| `--dump` | Shorthand for `--format dump` |
| `--json`, `-j` | Output result as JSON |

</details>

#### `backups` - List backup files

```bash
spindb backups                       # List backups in current directory
spindb backups ./data                # List backups in specific directory
spindb backups --all                 # Include ~/.spindb/backups
spindb backups --limit 50            # Show more results
spindb backups --json                # JSON output
```

<details>
<summary>All options</summary>

| Option | Description |
|--------|-------------|
| `--all`, `-a` | Include backups from `~/.spindb/backups` |
| `--limit`, `-n` | Limit number of results (default: 20) |
| `--json`, `-j` | Output as JSON |

</details>

#### `restore` - Restore from backup

```bash
spindb restore mydb backup.dump
spindb restore mydb backup.sql --database my_app
spindb restore mydb --from-url "postgresql://user:pass@host/db"
```

**Restore production data alongside existing databases:**

```bash
# Restore into a NEW database without affecting existing data
spindb restore mydb prod-backup.dump --database prod_copy

# Pull from production into a new local database
spindb restore mydb --from-url "postgresql://user:pass@prod-host/proddb" --database prod_local

# View all databases in a container
spindb info mydb
```

<details>
<summary>All options</summary>

| Option | Description |
|--------|-------------|
| `--database`, `-d` | Target database name (creates new if doesn't exist) |
| `--from-url` | Pull data from a remote database connection string |
| `--force`, `-f` | Overwrite existing database without confirmation |
| `--json`, `-j` | Output result as JSON |

</details>

#### Backup & Restore Format Reference

Each engine has specific backup formats and restore behaviors:

<details>
<summary>PostgreSQL</summary>

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| SQL | `.sql` | pg_dump | Plain text SQL, human-readable |
| Custom | `.dump` | pg_dump -Fc | Compressed, supports parallel restore |

**Restore behavior:** Creates new database or replaces existing. Uses `pg_restore` for `.dump`, `psql` for `.sql`.

</details>

<details>
<summary>MariaDB</summary>

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| SQL | `.sql` | mariadb-dump | Plain text SQL |
| Compressed | `.sql.gz` | mariadb-dump + gzip | Gzip compressed SQL |

**Restore behavior:** Creates new database or replaces existing. Pipes to `mariadb` client.

</details>

<details>
<summary>MySQL</summary>

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| SQL | `.sql` | mysqldump | Plain text SQL |
| Compressed | `.sql.gz` | mysqldump + gzip | Gzip compressed SQL |

**Restore behavior:** Creates new database or replaces existing. Pipes to `mysql` client.

</details>

<details>
<summary>SQLite</summary>

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| SQL | `.sql` | .dump | Plain text SQL |
| Binary | `.sqlite` | File copy | Exact copy of database file |

**Restore behavior:** Creates new file or replaces existing.

</details>

<details>
<summary>MongoDB</summary>

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| BSON | `.bson` | mongodump | Binary JSON per collection |
| Archive | `.archive` | mongodump --archive | Single compressed file |

**Restore behavior:** Creates new database or replaces existing. Uses `mongorestore`.

</details>

<details>
<summary>Redis</summary>

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| RDB | `.rdb` | BGSAVE | Binary snapshot, requires restart |
| Text | `.redis` | Custom | Human-readable Redis commands |

**Text format detection:** Files are detected as Redis text commands if they contain valid Redis commands (SET, HSET, DEL, etc.), regardless of file extension. This allows restoring files like `users.txt` or `data` without renaming.

**Restore behavior:**
- **RDB (`.rdb`):** Requires stopping Redis, copies file to data directory, restart loads data
- **Text (`.redis`):** Pipes commands to running Redis instance. Prompts for:
  - **Replace all:** Runs `FLUSHDB` first (clean slate)
  - **Merge:** Adds/updates keys, keeps existing keys not in backup

**Note:** Redis uses numbered databases (0-15) that always exist. "Create new database" is not applicable.

</details>

<details>
<summary>Valkey</summary>

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| RDB | `.rdb` | BGSAVE | Binary snapshot, requires restart |
| Text | `.valkey` | Custom | Human-readable Redis-compatible commands |

**Text format detection:** Files are detected as Valkey text commands if they contain valid Redis commands (SET, HSET, DEL, etc.), regardless of file extension.

**Restore behavior:** Same as Redis (Valkey is Redis-compatible).
- **RDB (`.rdb`):** Requires stopping Valkey, copies file to data directory, restart loads data
- **Text (`.valkey`):** Pipes commands to running Valkey instance. Prompts for:
  - **Replace all:** Runs `FLUSHDB` first (clean slate)
  - **Merge:** Adds/updates keys, keeps existing keys not in backup

**Note:** Valkey uses numbered databases (0-15) that always exist. "Create new database" is not applicable.

</details>

### Container Management

#### `list` - List all containers

```bash
spindb list
spindb list --json
```

#### `info` - Show container details

```bash
spindb info              # All containers
spindb info mydb         # Specific container
spindb info mydb --json
```

#### `clone` - Clone a container

```bash
spindb stop source-db           # Source must be stopped
spindb clone source-db new-db
spindb start new-db
```

#### `edit` - Rename, change port, relocate, or edit database config

```bash
spindb edit mydb --name newname              # Must be stopped
spindb edit mydb --port 5433
spindb edit mydb --relocate ~/new/path       # Move SQLite database file
spindb edit mydb --set-config max_connections=300   # PostgreSQL config
spindb edit mydb                             # Interactive mode
```

#### `logs` - View container logs

```bash
spindb logs mydb
spindb logs mydb --follow       # Follow mode (like tail -f)
spindb logs mydb -n 50          # Last 50 lines
spindb logs mydb --editor       # Open in $EDITOR
```

### Engine & System

#### `engines` - Manage installed engines

```bash
spindb engines                           # List installed engines
spindb engines list --json               # JSON output
spindb engines supported                 # List all supported engines
spindb engines supported --json          # Full engine config as JSON
spindb engines supported --all           # Include pending/planned engines
spindb engines delete postgresql 16      # Delete a version (frees ~45MB)
```

Example output:

```
ENGINE        VERSION     SOURCE            SIZE
────────────────────────────────────────────────────────
🐘 postgresql 18.1        darwin-arm64      46.0 MB
🐘 postgresql 17.7        darwin-arm64      45.2 MB
🐬 mysql      9.0.1       darwin-arm64      150.0 MB
🪶 sqlite     3.51.2      darwin-arm64      5.0 MB
────────────────────────────────────────────────────────

PostgreSQL: 2 version(s), 90.0 MB
MySQL: 1 version(s), 150.0 MB
SQLite: 1 version(s), 5.0 MB
```

`spindb engines supported` output:

```
🐘 postgresql
🐬 mysql
🦭 mariadb
🪶 sqlite
🍃 mongodb
🔴 redis
🔷 valkey
```

#### `deps` - Manage client tools

```bash
spindb deps check                      # Check all dependencies
spindb deps check --engine postgresql  # Check specific engine
spindb deps install                    # Install missing tools
spindb deps install --engine mysql     # Install for specific engine
```

#### `config` - Configuration

```bash
spindb config show                     # Show current configuration
spindb config detect                   # Re-detect tool paths
spindb config update-check on          # Enable update notifications
spindb config update-check off         # Disable update notifications
```

#### `version` - Version info

```bash
spindb version
spindb version --check    # Check for updates
```

#### `self-update` - Update SpinDB

```bash
spindb self-update
```

#### `doctor` - System health check

```bash
spindb doctor            # Interactive health check
spindb doctor --json     # JSON output for scripting
```

Checks performed:
- Configuration file validity and binary cache freshness
- Container status across all engines
- SQLite registry for orphaned entries (files deleted outside SpinDB)
- Database tool availability

Example output:

```
SpinDB Health Check
═══════════════════

✓ Configuration
  └─ Configuration valid, 12 tools cached

✓ Containers
  └─ 4 container(s)
     postgresql: 2 running, 0 stopped
     mysql: 0 running, 1 stopped
     sqlite: 1 exist, 0 missing

⚠ SQLite Registry
  └─ 1 orphaned entry found
     "old-project" → /path/to/missing.sqlite

? What would you like to do?
❯ Remove orphaned entries from registry
  Skip (do nothing)
```

---

## Enhanced CLI Tools

SpinDB supports enhanced database shells that provide features like auto-completion, syntax highlighting, and better output formatting.

| Engine | Standard | Enhanced | Universal |
|--------|----------|----------|-----------|
| PostgreSQL | `psql` | `pgcli` | `usql` |
| MariaDB | `mariadb` | `mycli` | `usql` |
| MySQL | `mysql` | `mycli` | `usql` |
| SQLite | `sqlite3` | `litecli` | `usql` |
| MongoDB | `mongosh` | - | `usql` |
| Redis | `redis-cli` | `iredis` | - |
| Valkey | `valkey-cli` | `iredis` | - |

**pgcli / mycli** provide:
- Intelligent auto-completion (tables, columns, keywords)
- Syntax highlighting
- Multi-line editing
- Query history with search

**usql** is a universal SQL client that works with any database. Great if you work with multiple engines.

Install and connect in one command:

```bash
spindb connect mydb --install-pgcli
spindb connect mydb --install-mycli
spindb connect mydb --install-tui      # usql
```

---

## Architecture

### How It Works

SpinDB uses the term "container" loosely—there's no Docker involved. When you create a container, SpinDB:

1. Downloads the database server binary (or uses your system's installation)
2. Creates an isolated data directory at `~/.spindb/containers/{engine}/{name}/`
3. Runs the database as a native process on your machine

Each "container" is just:
- A configuration file (`container.json`)
- A data directory (`data/`)
- A log file (`postgres.log`, `mysql.log`, or `mongodb.log`)

Native processes mean instant startup and no virtualization overhead.

### Storage Layout

```
~/.spindb/
├── bin/                                    # Downloaded server binaries
│   └── postgresql-18.1.0-darwin-arm64/     # ~45 MB per version
├── containers/
│   ├── postgresql/
│   │   └── mydb/
│   │       ├── container.json              # Configuration
│   │       ├── data/                       # Database files
│   │       └── postgres.log                # Server logs
│   └── mysql/
│       └── mydb/
│           ├── container.json
│           ├── data/
│           └── mysql.log
├── logs/                                   # Error logs
└── config.json                             # Tool paths cache

# SQLite databases are stored in project directories, not ~/.spindb/
./myproject/
└── mydb.sqlite                             # Created with: spindb create mydb -e sqlite
```

### Data Persistence

SpinDB runs databases as **native processes** on your machine. When you start a container:

1. SpinDB launches the database server binary (`pg_ctl start` or `mysqld`)
2. The server binds to `127.0.0.1` on your configured port
3. A PID file tracks the running process
4. Logs are written to the container's log file

When you stop a container:

1. SpinDB sends a graceful shutdown signal
2. The database flushes pending writes to disk
3. The PID file is removed
4. Your data remains in the `data/` directory

**Your data is never deleted unless you explicitly delete the container.**

#### Persistence by Engine

Each database engine has its own persistence mechanism:

| Engine | Mechanism | Durability |
|--------|-----------|------------|
| PostgreSQL | Write-Ahead Logging (WAL) | Every commit is immediately durable |
| MariaDB | InnoDB transaction logs | Every commit is immediately durable |
| MySQL | InnoDB transaction logs | Every commit is immediately durable |
| SQLite | File-based transactions | Every commit is immediately durable |
| MongoDB | WiredTiger with journaling | Writes journaled before acknowledged |
| Redis | RDB snapshots | Periodic snapshots (see below) |

**PostgreSQL, MariaDB, MySQL, MongoDB:** These engines use transaction logs or journaling. Every committed write is guaranteed to survive a crash or unexpected shutdown.

**SQLite:** As a file-based database, SQLite writes directly to disk on each commit. No server process means no risk of losing in-flight data.

**Redis:** SpinDB configures Redis with RDB (Redis Database) snapshots:
- Save after 900 seconds if at least 1 key changed
- Save after 300 seconds if at least 10 keys changed
- Save after 60 seconds if at least 10,000 keys changed

This means Redis may lose up to ~60 seconds of writes on an unexpected crash. For local development, this trade-off (speed over strict durability) is typically acceptable. If you need stronger guarantees, use `spindb backup` before stopping work.

### Binary Sources

**PostgreSQL:** Server binaries are downloaded automatically:
- **macOS/Linux:** From [hostdb](https://github.com/robertjbass/hostdb) on GitHub Releases
- **Windows:** From [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries)

**MariaDB, MySQL, MongoDB, Redis, Valkey:** Server binaries are downloaded automatically from [hostdb](https://github.com/robertjbass/hostdb) on GitHub Releases for all platforms.

### Why Precompiled Binaries?

The [hostdb](https://github.com/robertjbass/hostdb) project provides pre-compiled, portable database binaries:

- Cross-platform (macOS Intel/ARM, Linux x64/ARM, Windows x64)
- Hosted on GitHub Releases (highly reliable CDN)
- ~45-200 MB per version depending on engine
- Actively maintained with new database releases

This makes multi-version support trivial: need PostgreSQL 14 for a legacy project and 18 for a new one? Need MongoDB 7.0 and 8.0? Redis 7 and 8? SpinDB downloads them all, and they run side-by-side without conflicts.

---

## Limitations

- **Local only** - Databases bind to `127.0.0.1`; remote connections planned for v1.1
- **Redis remote dump not supported** - Redis doesn't support creating containers from remote connection strings. Use backup/restore for data migration.

---

## Roadmap

See [TODO.md](TODO.md) for the full roadmap.

### v1.1 - Remote Connections & Secrets
- Connect to remote databases
- Environment variable support in connection strings
- Secrets management (macOS Keychain)

### v1.2 - Additional Engines
- CockroachDB (distributed SQL)

### v1.3 - Advanced Features
- Container templates
- Scheduled backups
- Import from Docker

### Future Infrastructure
- **hostdb npm package**: Available database versions will be published as an npm package from [hostdb](https://github.com/robertjbass/hostdb) and imported into SpinDB, eliminating the need to manually sync version-maps.ts with releases.json
- **pnpm 10 upgrade**: Currently pinned to pnpm 9.x (`packageManager` in package.json and Docker). Consider upgrading to pnpm 10.x when stable—requires updating package.json, Dockerfile, regenerating pnpm-lock.yaml, and testing for lockfile format changes

### Possible Future Engines

These engines are under consideration but not yet on the roadmap. Community interest and feasibility will determine priority:

| Engine | Type | Notes |
|--------|------|-------|
| **DuckDB** | Embedded analytical | File-based like SQLite, popular for data/analytics work |
| **libSQL** | Embedded relational | SQLite fork by Turso with replication and edge support |
| **Meilisearch** | Search engine | Developer-friendly search, good binary distribution |
| **Elasticsearch/OpenSearch** | Search engine | Full-text search, common in web applications |
| **Neo4j** | Graph database | Most popular graph database |
| **InfluxDB** | Time-series | IoT, metrics, and monitoring use cases |

---

## Troubleshooting

### Port already in use

SpinDB automatically finds an available port. To specify one:

```bash
spindb create mydb --port 5433
```

### Client tool not found

Install client tools or configure manually:

```bash
spindb deps install
# or
spindb config set psql /path/to/psql
```

### Container won't start

Check the logs:

```bash
spindb logs mydb
# or read directly
cat ~/.spindb/containers/postgresql/mydb/postgres.log
```

### Reset everything

```bash
rm -rf ~/.spindb
```

---

## Contributing

Note: This repo currently assumes `pnpm` for running tests. `npm test` will shell out to `pnpm` and fail if `pnpm` isn't installed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and distribution info.

See [ARCHITECTURE.md](ARCHITECTURE.md) for project architecture and comprehensive CLI command examples.

See [CLAUDE.md](CLAUDE.md) for AI-assisted development context.

See [ENGINES.md](ENGINES.md) for detailed engine documentation (backup formats, planned engines, etc.).

---

## Acknowledgments

SpinDB wouldn't be possible without:

- **[hostdb](https://github.com/robertjbass/hostdb)** - Pre-compiled database binaries (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, SQLite) that make Docker-free local databases possible. Hosted on GitHub Releases for reliable, fast downloads.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE)

SpinDB is free for:
- Personal use and hobby projects
- Educational and research purposes
- Nonprofit organizations, educational institutions, and government

**SpinDB may not be used for commercial purposes.**
