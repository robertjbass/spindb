# SpinDB

[![npm version](https://img.shields.io/npm/v/spindb.svg)](https://www.npmjs.com/package/spindb)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](LICENSE)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#supported-platforms)

**Local databases without the Docker baggage.**

Spin up PostgreSQL, MySQL, and SQLite instances for local development. No Docker daemon, no container networking, no volume mounts. Just databases running on localhost, ready in seconds.

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

| Feature | SpinDB | Docker | DBngin | Postgres.app |
|---------|--------|--------|--------|--------------|
| No Docker required | ✅ | ❌ | ✅ | ✅ |
| Multiple DB engines | ✅ | ✅ | ✅ | ❌ |
| CLI-first | ✅ | ✅ | ❌ | ❌ |
| Multiple versions | ✅ | ✅ | ✅ | ✅ |
| Clone databases | ✅ | Manual | ✅ | ❌ |
| Low resource usage | ✅ | ❌ | ✅ | ✅ |
| Linux support | ✅ | ✅ | ❌ | ❌ |
| Free | ✅ | ⚠️ | ✅ | ✅ |

### How It Works

SpinDB uses the term "container" loosely—there's no Docker involved. When you create a container, SpinDB:

1. Downloads the database server binary (or uses your system's installation)
2. Creates an isolated data directory at `~/.spindb/containers/{engine}/{name}/`
3. Runs the database as a native process on your machine

Each "container" is just:
- A configuration file (`container.json`)
- A data directory (`data/`)
- A log file (`postgres.log` or `mysql.log`)

Native processes mean instant startup and no virtualization overhead.

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

## Quick Start

```bash
# Create and start a PostgreSQL database
spindb create myapp

# Connect to it
spindb connect myapp

# You're in! Run some SQL:
# postgres=# CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);
```

That's it. Your database is running on `localhost:5432`, and your data persists in `~/.spindb/containers/postgresql/myapp/`.

---

## Database Engines

### Supported Engines

#### PostgreSQL

| | |
|---|---|
| Versions | 14, 15, 16, 17 |
| Default port | 5432 |
| Default user | `postgres` |
| Binary source | [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries) (macOS/Linux), [EDB](https://www.enterprisedb.com/) (Windows) |

SpinDB downloads PostgreSQL server binaries automatically:
- **macOS/Linux:** Pre-compiled binaries from the zonky.io project, hosted on Maven Central
- **Windows:** Official binaries from EnterpriseDB (EDB)

**Why download binaries instead of using system PostgreSQL?** You might want PostgreSQL 14 for one project and 17 for another. SpinDB lets you run different versions side-by-side without conflicts.

**Client tools required:** You still need `psql`, `pg_dump`, and `pg_restore` installed on your system for some operations (connecting, backups, restores). SpinDB can install these for you:

```bash
spindb deps install --engine postgresql
```

#### MySQL

| | |
|---|---|
| Versions | Depends on system installation |
| Default port | 3306 |
| Default user | `root` |
| Binary source | System installation |

Unlike PostgreSQL, SpinDB uses your system's MySQL installation. This is because MySQL doesn't have a nice cross-platform binary distribution like zonky.io provides for PostgreSQL.

```bash
# macOS
brew install mysql

# Ubuntu/Debian
sudo apt install mysql-server

# Windows (Chocolatey)
choco install mysql

# Windows (winget)
winget install Oracle.MySQL

# Check if SpinDB can find MySQL
spindb deps check --engine mysql
```

**Linux users:** MariaDB works as a drop-in replacement for MySQL. If you have MariaDB installed, SpinDB will detect and use it automatically. In a future release, MariaDB will be available as its own engine with support for MariaDB-specific features.

#### SQLite

| | |
|---|---|
| Version | 3 (system) |
| Default port | N/A (file-based) |
| Data location | Project directory (CWD) |
| Binary source | System installation |

SQLite is a file-based database—no server process, no ports. Databases are stored in your project directory by default, not `~/.spindb/`. SpinDB tracks registered SQLite databases in a registry file.

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

### Planned Engines

| Engine | Type | Status |
|--------|------|--------|
| Redis | In-memory key-value | Planned for v1.2 |
| MongoDB | Document database | Planned for v1.2 |

---

## Commands

### Container Lifecycle

#### `create` - Create a new container

```bash
spindb create mydb                           # PostgreSQL (default)
spindb create mydb --engine mysql            # MySQL
spindb create mydb --engine sqlite           # SQLite (file-based)
spindb create mydb --version 16              # Specific PostgreSQL version
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
| `--engine`, `-e` | Database engine (`postgresql`, `mysql`, `sqlite`) |
| `--version`, `-v` | Engine version |
| `--port`, `-p` | Port number (not applicable for SQLite) |
| `--database`, `-d` | Primary database name |
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

#### `run` - Execute SQL

```bash
spindb run mydb script.sql                    # Run a SQL file
spindb run mydb --sql "SELECT * FROM users"   # Run inline SQL
spindb run mydb seed.sql --database my_app    # Target specific database
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

Backup formats:

```bash
spindb backup mydb --format sql     # Plain SQL (.sql)
spindb backup mydb --format dump    # Compressed (.dump for PG, .sql.gz for MySQL)

# Shorthand
spindb backup mydb --sql
spindb backup mydb --dump
```

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

#### `restore` - Restore from backup

```bash
spindb restore mydb backup.dump
spindb restore mydb backup.sql --database my_app
spindb restore mydb --from-url "postgresql://user:pass@host/db"
```

<details>
<summary>All options</summary>

| Option | Description |
|--------|-------------|
| `--database`, `-d` | Target database name |
| `--from-url` | Pull data from a remote database connection string |
| `--force`, `-f` | Overwrite existing database without confirmation |
| `--json`, `-j` | Output result as JSON |

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
spindb engines delete postgresql 16      # Delete a version (frees ~45MB)
```

Example output:

```
ENGINE        VERSION     SOURCE            SIZE
────────────────────────────────────────────────────────
🐘 postgresql 17.7        darwin-arm64      45.2 MB
🐘 postgresql 16.8        darwin-arm64      44.8 MB
🐬 mysql      8.0.35      system            (system-installed)
🪶 sqlite     3.43.2      system            (system-installed)
────────────────────────────────────────────────────────

PostgreSQL: 2 version(s), 90.0 MB
MySQL: system-installed at /opt/homebrew/bin/mysqld
SQLite: system-installed at /usr/bin/sqlite3
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
| MySQL | `mysql` | `mycli` | `usql` |
| SQLite | `sqlite3` | `litecli` | `usql` |
| Redis (planned) | `redis-cli` | `iredis` | - |
| MongoDB (planned) | `mongosh` | - | - |

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

### Storage Layout

```
~/.spindb/
├── bin/                                    # Downloaded server binaries
│   └── postgresql-17.7.0-darwin-arm64/     # ~45 MB per version
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
├── sqlite-registry.json                    # Tracks SQLite file locations
├── logs/                                   # Error logs
└── config.json                             # Tool paths cache

# SQLite databases are stored in project directories, not ~/.spindb/
./myproject/
└── mydb.sqlite                             # Created with: spindb create mydb -e sqlite
```

### How Data Persists

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

### Binary Sources

**PostgreSQL:** Server binaries are downloaded automatically:
- **macOS/Linux:** From [zonky.io/embedded-postgres-binaries](https://github.com/zonkyio/embedded-postgres-binaries), hosted on Maven Central
- **Windows:** From [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries), official PostgreSQL distributions

**MySQL:** Uses your system's MySQL installation. SpinDB detects binaries from Homebrew (macOS), apt/pacman (Linux), or Chocolatey/winget/Scoop (Windows).

---

## Supported Platforms

| Platform | Architecture | Status |
|----------|-------------|--------|
| macOS | Apple Silicon (ARM64) | ✅ Supported |
| macOS | Intel (x64) | ✅ Supported |
| Linux | x64 | ✅ Supported |
| Linux | ARM64 | ✅ Supported |
| Windows | x64 | ✅ Supported |

Windows uses EnterpriseDB (EDB) official binaries for PostgreSQL. MySQL and SQLite require system installations via Chocolatey, winget, or Scoop.

---

## Limitations

- **Client tools required** - `psql` and `mysql` must be installed separately for some operations
- **Local only** - Databases bind to `127.0.0.1`; remote connections planned for v1.1
- **MySQL requires system install** - Unlike PostgreSQL, we don't download MySQL binaries

---

## Roadmap

See [TODO.md](TODO.md) for the full roadmap.

### v1.1 - Remote Connections & Secrets
- Connect to remote databases
- Environment variable support in connection strings
- Secrets management (macOS Keychain)

### v1.2 - Additional Engines
- Redis (in-memory key-value)
- MongoDB (document database)
- MariaDB as standalone engine

### v1.3 - Advanced Features
- Container templates
- Scheduled backups
- Import from Docker

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

- **[zonky.io/embedded-postgres-binaries](https://github.com/zonkyio/embedded-postgres-binaries)** - Pre-compiled PostgreSQL binaries that make Docker-free PostgreSQL possible. These binaries are extracted from official PostgreSQL distributions and hosted on Maven Central.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE)

SpinDB is free for:
- Personal use and hobby projects
- Educational and research purposes
- Nonprofit organizations, educational institutions, and government

**SpinDB may not be used for commercial purposes.**
