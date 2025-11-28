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

- Downloads server binaries from [zonky.io embedded-postgres-binaries](https://github.com/zonkyio/embedded-postgres-binaries)
- Versions: 14, 15, 16, 17
- Requires system client tools (psql, pg_dump, pg_restore) for some operations

**Why zonky.io?** Zonky.io provides pre-compiled PostgreSQL server binaries for multiple platforms (macOS, Linux) and architectures (x64, ARM64) hosted on Maven Central. This allows SpinDB to download and run PostgreSQL without requiring a full system installation. The binaries are extracted from official PostgreSQL distributions and repackaged for easy embedding in applications.

### MySQL 🐬

- Uses system-installed MySQL (via Homebrew, apt, etc.)
- Version determined by system installation
- Requires: mysqld, mysql, mysqldump, mysqladmin

**Linux Note:** On Linux systems, MariaDB is commonly used as a drop-in replacement for MySQL. SpinDB fully supports MariaDB and will automatically detect it. When MariaDB is installed, the `mysql`, `mysqld`, and `mysqldump` commands work the same way. Install with:
```bash
# Ubuntu/Debian
sudo apt install mariadb-server

# Arch
sudo pacman -S mariadb
```

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

**Note:** On Linux, package managers (apt, pacman, dnf) require `sudo` privileges. You may be prompted for your password when installing dependencies.

### Manual Installation

#### PostgreSQL

```bash
# macOS (Homebrew) - use the latest PostgreSQL version (currently 17)
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

## Project Structure

```
spindb/
├── bin.ts                      # Entry point (#!/usr/bin/env tsx)
├── cli/
│   ├── index.ts                # Commander setup, routes to commands
│   ├── commands/               # CLI commands
│   │   ├── menu.ts             # Interactive arrow-key menu
│   │   ├── create.ts           # Create container command
│   │   ├── delete.ts           # Delete container command
│   │   └── ...                 # Other commands
│   └── ui/
│       ├── prompts.ts          # Inquirer prompts
│       ├── spinner.ts          # Ora spinner helpers
│       └── theme.ts            # Chalk color theme
├── core/
│   ├── binary-manager.ts       # Downloads PostgreSQL from zonky.io
│   ├── config-manager.ts       # Manages ~/.spindb/config.json
│   ├── container-manager.ts    # CRUD for containers
│   ├── port-manager.ts         # Port availability checking
│   ├── process-manager.ts      # Process start/stop wrapper
│   ├── dependency-manager.ts   # Client tool detection
│   ├── error-handler.ts        # Centralized error handling
│   └── transaction-manager.ts  # Rollback support for operations
├── config/
│   ├── paths.ts                # ~/.spindb/ path definitions
│   ├── defaults.ts             # Default values, platform mappings
│   └── os-dependencies.ts      # OS-specific dependency definitions
├── engines/
│   ├── base-engine.ts          # Abstract base class
│   ├── index.ts                # Engine registry
│   ├── postgresql/
│   │   ├── index.ts            # PostgreSQL engine implementation
│   │   ├── binary-urls.ts      # Zonky.io URL builder
│   │   ├── restore.ts          # Backup detection and restore
│   │   └── version-validator.ts # Version compatibility checks
│   └── mysql/
│       ├── index.ts            # MySQL engine implementation
│       ├── binary-detection.ts # MySQL binary path detection
│       ├── restore.ts          # Backup detection and restore
│       └── version-validator.ts # Version compatibility checks
├── types/
│   └── index.ts                # TypeScript interfaces
└── tests/
    ├── unit/                   # Unit tests
    ├── integration/            # Integration tests
    └── fixtures/               # Test data
        ├── postgresql/
        │   └── seeds/
        └── mysql/
            └── seeds/
```

## Contributing

### Version Updates

SpinDB uses versioned PostgreSQL packages from Homebrew (e.g., `postgresql@17`). When new major versions are released:

1. Check [PostgreSQL releases](https://www.postgresql.org/docs/release/) and [Homebrew formulae](https://formulae.brew.sh/formula/postgresql)
2. Update `config/engine-defaults.ts`:
   - Change `latestVersion` to the new version
   - Add the new version to `supportedVersions`

See `CLAUDE.md` for detailed maintenance instructions.

## License

MIT
