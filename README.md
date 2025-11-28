# SpinDB

Spin up local PostgreSQL and MySQL databases without Docker. A lightweight alternative to DBngin and Postgres.app.

## Features

- **No Docker required** - Downloads PostgreSQL binaries directly, uses system MySQL
- **Multiple engines** - PostgreSQL and MySQL support
- **Multiple containers** - Run multiple isolated database instances on different ports
- **Interactive menu** - Arrow-key navigation for all operations
- **Auto port management** - Automatically finds available ports
- **Clone containers** - Duplicate databases with all data
- **Backup restore** - Restore pg_dump/mysqldump backups
- **Custom database names** - Specify database name separate from container name
- **Engine management** - View installed PostgreSQL versions and free up disk space
- **Dynamic version selection** - Fetches available PostgreSQL versions from Maven Central

## Installation

```bash
# Run directly with pnpx (no install needed)
pnpx spindb

# Or install globally
pnpm add -g spindb
```

## Quick Start

```bash
# Launch interactive menu
spindb

# Or use commands directly
spindb create mydb                    # PostgreSQL (default)
spindb create mydb --engine mysql     # MySQL
spindb list
spindb connect mydb
```

## Commands

| Command | Description |
|---------|-------------|
| `spindb` | Open interactive menu |
| `spindb create [name]` | Create a new database container |
| `spindb list` | List all containers |
| `spindb start [name]` | Start a container |
| `spindb stop [name]` | Stop a container |
| `spindb connect [name]` | Connect with psql/mysql shell |
| `spindb restore [name] [backup]` | Restore a backup file |
| `spindb clone [source] [target]` | Clone a container |
| `spindb delete [name]` | Delete a container |
| `spindb config show` | Show configuration |
| `spindb config detect` | Auto-detect database tools |
| `spindb deps check` | Check status of client tools |
| `spindb deps install` | Install missing client tools |

## Supported Engines

### PostgreSQL 🐘

- Downloads binaries from [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries)
- Versions: 14, 15, 16, 17
- Requires system client tools (psql, pg_dump, pg_restore) for some operations

### MySQL 🐬

- Uses system-installed MySQL (via Homebrew, apt, etc.)
- Version determined by system installation
- Requires: mysqld, mysql, mysqldump, mysqladmin

## How It Works

Data is stored in `~/.spindb/`:
```
~/.spindb/
├── bin/                              # PostgreSQL server binaries
│   └── postgresql-17-darwin-arm64/
├── containers/
│   ├── postgresql/                   # PostgreSQL containers
│   │   └── mydb/
│   │       ├── container.json
│   │       ├── data/
│   │       └── postgres.log
│   └── mysql/                        # MySQL containers
│       └── mydb/
│           ├── container.json
│           ├── data/
│           └── mysql.log
└── config.json
```

## Client Tools

SpinDB bundles the PostgreSQL **server** but not client tools. For `connect` and `restore` commands, you need client tools installed.

### Automatic Installation

```bash
# Check status of all client tools
spindb deps check

# Install missing tools
spindb deps install

# Install for a specific engine
spindb deps install --engine postgresql
spindb deps install --engine mysql
```

### Manual Installation

#### PostgreSQL

```bash
# macOS (Homebrew)
brew install postgresql@17
brew link --overwrite postgresql@17

# Ubuntu/Debian
sudo apt install postgresql-client

# Arch
sudo pacman -S postgresql-libs
```

#### MySQL

```bash
# macOS (Homebrew)
brew install mysql

# Ubuntu/Debian
sudo apt install mysql-server

# Arch
sudo pacman -S mysql
```

## Supported Platforms

- macOS (Apple Silicon & Intel)
- Linux (x64 & ARM64)

## Examples

### Create databases

```bash
# PostgreSQL with specific version and port
spindb create mydb --engine postgresql --version 16 --port 5433

# MySQL
spindb create mydb --engine mysql --port 3307

# With custom database name
spindb create mydb --database my_app_db
```

### Create and restore in one command

```bash
# Create and restore from a dump file
spindb create mydb --from ./backup.dump

# Create and pull from a remote database
spindb create mydb --from "postgresql://user:pass@remote-host:5432/production_db"
```

### Clone for testing

```bash
# Stop the source container
spindb stop production-copy

# Clone it
spindb clone production-copy test-branch

# Start the clone
spindb start test-branch
```

### Connect to databases

```bash
# Interactive shell (auto-detects engine)
spindb connect mydb

# Or use connection string directly
psql postgresql://postgres@localhost:5432/mydb
mysql -u root -h 127.0.0.1 -P 3306 mydb
```

### Manage installed engines

The Engines menu shows installed PostgreSQL versions with disk usage:

```
ENGINE      VERSION     PLATFORM            SIZE
────────────────────────────────────────────────────────
postgresql  17          darwin-arm64        45.2 MB
postgresql  16          darwin-arm64        44.8 MB
────────────────────────────────────────────────────────
2 version(s)                                90.0 MB
```

## Running Tests

```bash
# Run all tests (PostgreSQL + MySQL)
pnpm test

# Run individual test suites
pnpm test:pg
pnpm test:mysql
```

## Troubleshooting

### Port already in use

SpinDB automatically finds an available port. You can also specify one:

```bash
spindb create mydb --port 5433
```

### Client tool not found

Install client tools or configure the path:

```bash
spindb deps install
# or
spindb config set psql /path/to/psql
```

### Container won't start

Check the logs:

```bash
cat ~/.spindb/containers/postgresql/mydb/postgres.log
cat ~/.spindb/containers/mysql/mydb/mysql.log
```

### Reset everything

```bash
rm -rf ~/.spindb
```

## License

MIT
