# SpinDB

Spin up local PostgreSQL databases without Docker. A lightweight alternative to DBngin.

## Features

- **No Docker required** - Downloads and runs PostgreSQL binaries directly
- **Multiple containers** - Run multiple isolated PostgreSQL instances on different ports
- **Interactive menu** - Arrow-key navigation for all operations
- **Auto port management** - Automatically finds available ports
- **Clone containers** - Duplicate databases with all data
- **Backup restore** - Restore pg_dump backups (requires system PostgreSQL client tools)
- **Custom database names** - Specify database name separate from container name
- **Engine management** - View installed PostgreSQL versions and free up disk space
- **Dynamic version selection** - Fetches all available versions from Maven Central

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
spindb create mydb
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
| `spindb connect [name]` | Connect with psql |
| `spindb restore [name] [backup]` | Restore a backup file |
| `spindb clone [source] [target]` | Clone a container |
| `spindb delete [name]` | Delete a container |
| `spindb config show` | Show configuration |
| `spindb config detect` | Auto-detect PostgreSQL tools |

## How It Works

SpinDB downloads pre-built PostgreSQL binaries from [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries) on first use. These are the same binaries used by embedded-postgres for Java testing.

Data is stored in `~/.spindb/`:
```
~/.spindb/
├── bin/                    # PostgreSQL server binaries
│   └── postgresql-16-darwin-arm64/
├── containers/             # Container data
│   └── mydb/
│       ├── container.json  # Container config
│       ├── data/           # PostgreSQL data directory
│       └── postgres.log    # Server logs
└── config.json             # SpinDB configuration
```

## PostgreSQL Client Tools

SpinDB bundles the PostgreSQL **server** (postgres, pg_ctl, initdb) but not client tools (psql, pg_dump, pg_restore). For `connect` and `restore` commands, you need PostgreSQL client tools installed:

```bash
# macOS (Homebrew)
brew install libpq
brew link --force libpq

# Ubuntu/Debian
apt install postgresql-client

# Or use Postgres.app (macOS)
# Client tools are automatically detected
```

SpinDB auto-detects installed tools. Check what's configured:

```bash
spindb config show
```

Manually configure tool paths:

```bash
spindb config set psql /path/to/psql
spindb config set pg_restore /path/to/pg_restore
```

## Supported Platforms

- macOS (Apple Silicon & Intel)
- Linux (x64 & ARM64)

## Supported PostgreSQL Versions

- PostgreSQL 14
- PostgreSQL 15
- PostgreSQL 16
- PostgreSQL 17

## Examples

### Create a database with specific version and name

```bash
# Specify PostgreSQL version and port
spindb create mydb --pg-version 15 --port 5433

# Specify a custom database name (different from container name)
spindb create mydb --database my_app_db
# Connection string: postgresql://postgres@localhost:5432/my_app_db
```

### Restore a backup

```bash
# Start the container first
spindb start mydb

# Restore (supports .sql, custom format, and tar format)
spindb restore mydb ./backup.dump -d myapp
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

### Connect and run queries

```bash
# Interactive psql session
spindb connect mydb

# Or use the connection string directly
psql postgresql://postgres@localhost:5432/mydb
```

### Manage installed engines

The Engines menu (accessible from the main menu) shows all installed PostgreSQL versions with their disk usage. You can delete unused versions to free up space.

```
ENGINE      VERSION     PLATFORM            SIZE
────────────────────────────────────────────────────────
postgresql  17          darwin-arm64        45.2 MB
postgresql  16.9.0      darwin-arm64        44.8 MB
postgresql  16          darwin-arm64        44.8 MB
────────────────────────────────────────────────────────
3 version(s)                                134.8 MB
```

## Configuration

Configuration is stored in `~/.spindb/config.json`. You can edit it directly or use the `config` commands:

```bash
# Show all config
spindb config show

# Re-detect system tools
spindb config detect

# Set custom binary path
spindb config set psql /usr/local/bin/psql

# Get path for scripting
spindb config path psql
```

## Troubleshooting

### Port already in use

SpinDB automatically finds an available port if the default (5432) is in use. You can also specify a port:

```bash
spindb create mydb --port 5433
```

### psql not found

Install PostgreSQL client tools (see above) or configure the path manually:

```bash
spindb config set psql /path/to/psql
```

### Container won't start

Check the logs:

```bash
cat ~/.spindb/containers/mydb/postgres.log
```

### Reset everything

```bash
rm -rf ~/.spindb
```

## License

MIT
