# CLAUDE.md - Project Context for Claude Code

## Style Guide

See [STYLEGUIDE.md](STYLEGUIDE.md) for coding conventions and style guidelines.

## Project Overview

SpinDB is a CLI tool for running local databases without Docker. It's a lightweight alternative to DBngin and Postgres.app, downloading PostgreSQL binaries directly and using system-installed MySQL/MongoDB/Redis. With support for several engines including SQLite, PostgreSQL, MySQL, MongoDB, and Redis.

**Target audience:** Individual developers who want simple local databases with consumer-grade UX.

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Execution**: `tsx` for direct TypeScript execution (no build step)
- **Package Manager**: pnpm (strictly - not npm/yarn)
- **CLI Framework**: Commander.js
- **Interactive UI**: Inquirer.js (prompts), Chalk (colors), Ora (spinners)
- **Module System**: ESM (`"type": "module"`)

## Project Structure

```
cli/
├── bin.ts                  # Entry point (#!/usr/bin/env tsx)
├── index.ts                # Commander setup, routes to commands
├── commands/               # CLI commands
│   ├── menu/               # Interactive menu (default command)
│   │   ├── index.ts        # Main menu orchestrator
│   │   ├── shared.ts       # MenuChoice type, pressEnterToContinue
│   │   ├── container-handlers.ts  # Create, list, start, stop, edit, delete
│   │   ├── backup-handlers.ts     # Backup, restore, clone
│   │   ├── shell-handlers.ts      # Open shell, copy connection string
│   │   ├── sql-handlers.ts        # Run SQL, view logs
│   │   ├── engine-handlers.ts     # List/delete engines
│   │   └── update-handlers.ts     # Check for updates
│   ├── create.ts           # Create container
│   ├── start.ts            # Start container
│   ├── stop.ts             # Stop container
│   ├── delete.ts           # Delete container
│   ├── list.ts             # List containers
│   ├── info.ts             # Show container details (alias: status)
│   ├── connect.ts          # Connect to shell (alias: shell)
│   ├── clone.ts            # Clone container
│   ├── restore.ts          # Restore from backup
│   ├── backup.ts           # Create backup
│   ├── run.ts              # Run SQL files/statements
│   ├── logs.ts             # View container logs
│   ├── edit.ts             # Rename/change port
│   ├── url.ts              # Connection string output
│   ├── config.ts           # Configuration management
│   ├── deps.ts             # Dependency management
│   ├── engines.ts          # Engine management
│   ├── self-update.ts      # Self-update command
│   └── version.ts          # Version info
└── ui/
    ├── prompts.ts          # Inquirer prompts
    ├── spinner.ts          # Ora spinner helpers
    └── theme.ts            # Chalk color theme
core/
├── binary-manager.ts       # PostgreSQL binary downloads
├── config-manager.ts       # ~/.spindb/config.json
├── container-manager.ts    # Container CRUD
├── port-manager.ts         # Port availability
├── process-manager.ts      # Process start/stop
├── dependency-manager.ts   # Tool detection/installation
├── error-handler.ts        # SpinDBError class
├── transaction-manager.ts  # Rollback support
├── start-with-retry.ts     # Port conflict retry
└── platform-service.ts     # Platform abstractions
config/
├── paths.ts                # ~/.spindb/ paths
├── defaults.ts             # Default values
└── os-dependencies.ts      # OS-specific deps
engines/
├── base-engine.ts          # Abstract base class
├── index.ts                # Engine registry
├── postgresql/
│   ├── index.ts            # PostgreSQL engine
│   ├── binary-urls.ts      # Zonky.io URL builder
│   ├── edb-binary-urls.ts  # Windows EDB URL builder
│   ├── binary-manager.ts   # Client tool management
│   ├── backup.ts           # pg_dump wrapper
│   ├── restore.ts          # Restore logic
│   └── version-validator.ts
├── mysql/
│   ├── index.ts            # MySQL engine
│   ├── binary-detection.ts # System binary detection
│   ├── backup.ts           # mysqldump wrapper
│   ├── restore.ts          # Restore logic
│   └── version-validator.ts
├── sqlite/
│   ├── index.ts            # SQLite engine (file-based)
│   ├── registry.ts         # File tracking in config.json
│   └── scanner.ts          # CWD scanning for .sqlite files
├── mongodb/
│   ├── index.ts            # MongoDB engine
│   ├── binary-detection.ts # System binary detection
│   ├── backup.ts           # mongodump wrapper
│   ├── restore.ts          # mongorestore wrapper
│   └── version-validator.ts
└── redis/
    ├── index.ts            # Redis engine
    ├── binary-detection.ts # System binary detection
    ├── backup.ts           # BGSAVE/RDB wrapper
    ├── restore.ts          # RDB restore
    └── version-validator.ts
types/index.ts              # TypeScript types
tests/
├── unit/                   # Unit tests (381 tests)
├── integration/            # Integration tests
└── fixtures/               # Test data
```

## Key Architecture

### Multi-Engine Support

Engines extend `BaseEngine` abstract class:

```typescript
abstract class BaseEngine {
  abstract name: string
  abstract displayName: string
  abstract supportedVersions: string[]
  abstract start(container: ContainerConfig): Promise<void>
  abstract stop(container: ContainerConfig): Promise<void>
  abstract initDataDir(name: string, version: string, options: InitOptions): Promise<void>
  // ...
}
```

**PostgreSQL 🐘**
- Server binaries from [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries)
- Client tools (psql, pg_dump) from system
- Versions: 14, 15, 16, 17, 18

**MySQL 🐬**
- All binaries from system (Homebrew, apt, etc.)
- Requires: mysqld, mysql, mysqldump, mysqladmin

**MongoDB 🍃**
- All binaries from system (Homebrew, apt, etc.)
- Requires: mongod, mongosh, mongodump, mongorestore
- Versions: 6.0, 7.0, 8.0
- Uses JavaScript for queries instead of SQL

**Redis 🔴**
- All binaries from system (Homebrew, apt, etc.)
- Requires: redis-server, redis-cli
- Versions: 6, 7, 8
- Uses numbered databases (0-15) instead of named databases
- Uses Redis commands instead of SQL

### File Structure

```
~/.spindb/
├── bin/                              # PostgreSQL server binaries
│   └── postgresql-18.1.0-darwin-arm64/
├── containers/
│   ├── postgresql/
│   │   └── mydb/
│   │       ├── container.json
│   │       ├── data/
│   │       └── postgres.log
│   ├── mysql/
│   │   └── mydb/
│   │       ├── container.json
│   │       ├── data/
│   │       └── mysql.log
│   ├── mongodb/
│   │   └── mydb/
│   │       ├── container.json
│   │       ├── data/
│   │       └── mongodb.log
│   └── redis/
│       └── mydb/
│           ├── container.json
│           ├── data/
│           └── redis.log
└── config.json                       # Tool paths cache
```

### Container Config

```typescript
type ContainerConfig = {
  name: string
  engine: 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' | 'redis'
  version: string
  port: number
  database: string        // Primary database
  databases?: string[]    // All databases
  created: string
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string
}
```

## Core Principles

### CLI-First Design
All functionality must be available via command-line arguments. Interactive menus are syntactic sugar for CLI commands.

```bash
# These are equivalent:
spindb create mydb -p 5433              # CLI
spindb → Create container → mydb → 5433 # Interactive
```

### Wrapper Pattern
Functions should wrap CLI tools, not implement database logic directly:

```typescript
// CORRECT: Wraps psql CLI
async createDatabase(container: ContainerConfig, database: string): Promise<void> {
  await execAsync(
    `"${psqlPath}" -h 127.0.0.1 -p ${port} -U postgres -d postgres -c 'CREATE DATABASE "${database}"'`
  )
}
```

### Transactional Operations
Multi-step operations must be atomic. Use `TransactionManager` for rollback support:

```typescript
const tx = new TransactionManager()
tx.addRollback(async () => await cleanup())
try {
  await step1()
  await step2()
  tx.commit()
} catch (error) {
  await tx.rollback()
  throw error
}
```

## Common Tasks

### Running the CLI

**IMPORTANT:** During development, always use `pnpm start` instead of `spindb` to ensure you're running the development version, not the globally installed version.

```bash
pnpm start              # Interactive menu
pnpm start create mydb  # Direct command
pnpm start --help       # Help
```

Note: `pnpm start` and `pnpm run start` are equivalent.

### Running Tests
```bash
pnpm test           # All tests
pnpm test:unit      # Unit only
pnpm test:pg        # PostgreSQL integration
pnpm test:mysql     # MySQL integration
pnpm test:mongodb   # MongoDB integration
pnpm test:redis     # Redis integration
```

**Note:** All test scripts use `--test-concurrency=1 --experimental-test-isolation=none` to disable Node's test runner worker threads. This prevents a macOS-specific serialization bug in Node 22 where worker thread IPC fails with "Unable to deserialize cloned data." The `--test-concurrency=1` alone only limits parallelism but still uses workers for isolation; `--experimental-test-isolation=none` completely disables worker isolation.

### Adding a New Command
1. Create `cli/commands/{name}.ts`
2. Export a Commander `Command` instance
3. Import and register in `cli/index.ts`
4. Add to `cli/commands/menu.ts` if needed

### After Adding Any New Feature
After completing a feature, ensure these files are updated:

1. **CLAUDE.md** - Update with new conventions, architecture changes, or commands
2. **README.md** - Document new commands and usage examples
3. **TODO.md** - Check off completed items, add any discovered future enhancements
4. **CHANGELOG.md** - Add entry under `[Unreleased]` section (check git history if needed)
5. **Tests** - Add unit and/or integration tests for new functionality

### Adding a New Engine

**IMPORTANT:** [FEATURE.md](FEATURE.md) is the authoritative guide for adding new database engines. It contains the complete specification including:

- **Quick Start Checklist** - All files and tests that must be created
- **BaseEngine Methods** - Full list of abstract methods with implementation guidance
- **Configuration Files** - All files requiring updates (`types/index.ts`, `config/engine-defaults.ts`, etc.)
- **Testing Requirements** - Integration tests (14+ tests), unit tests, CLI E2E tests, test fixtures
- **GitHub Actions / CI** - How to add your engine to the CI workflow for all 3 OSes
- **Binary Management** - Downloadable binaries vs system binaries approach
- **OS Dependencies** - Package manager definitions for Homebrew, apt, choco, etc.
- **Windows Considerations** - Command quoting, spawn options, PATH handling
- **Pass/Fail Criteria** - Explicit verification steps before an engine is complete

**Summary of what's involved:**
1. Create `engines/{engine}/` directory with index.ts, backup.ts, restore.ts, version-validator.ts
2. Implement ALL `BaseEngine` abstract methods
3. Register engine in `engines/index.ts` with aliases
4. Add to `types/index.ts` (Engine enum, BinaryTool type)
5. Add to `config/engine-defaults.ts` and `config/os-dependencies.ts`
6. Create test fixtures: `tests/fixtures/{engine}/seeds/sample-db.sql`
7. Create integration tests: `tests/integration/{engine}.test.ts` (14+ tests)
8. Update `tests/integration/helpers.ts` with engine support
9. Add integration test job to `.github/workflows/ci.yml` for all 3 OSes
10. Update documentation: README.md, CHANGELOG.md, TODO.md

**Reference implementations:**
- **PostgreSQL** - Server database with downloadable binaries (zonky.io/EDB)
- **MySQL** - Server database with system binaries
- **SQLite** - File-based database with registry tracking
- **MongoDB** - Server database with system binaries, uses JavaScript instead of SQL

**Engine Types:**
- **Server databases** (PostgreSQL, MySQL, MongoDB): Data in `~/.spindb/containers/`, port management, start/stop
- **File-based databases** (SQLite): Data in project directory (CWD), no port/process management

### Updating Supported Engine Versions

When new major versions of supported engines are released (e.g., PostgreSQL 18):

1. **Check binary availability:**
   - PostgreSQL (macOS/Linux): Verify zonky.io has binaries at [Maven Central](https://mvnrepository.com/artifact/io.zonky.test.postgres/embedded-postgres-binaries-darwin-arm64)
   - PostgreSQL (Windows): Check EDB download page (see step 2b below)
   - MySQL: System-installed, no action needed

2. **Update code:**
   - `config/engine-defaults.ts` - Add new version to `supportedVersions`, update `defaultVersion` and `latestVersion`
   - `engines/postgresql/version-maps.ts` - Add version mapping (e.g., `'18': '18.1.0'`)
   - `engines/postgresql/binary-urls.ts` - Add to `SUPPORTED_MAJOR_VERSIONS` and `FALLBACK_VERSION_MAP`
   - **Windows EDB file IDs** (required for Windows support):
     1. Visit: https://www.enterprisedb.com/download-postgresql-binaries
     2. Find the new version in the Windows x86-64 column
     3. Right-click the download link and copy the URL (e.g., `?fileid=1259913`)
     4. Extract the numeric file ID and add to `engines/postgresql/edb-binary-urls.ts`:
        ```typescript
        export const EDB_FILE_IDS: Record<string, string> = {
          '18.1.0': '1259913',
          '18': '1259913', // Alias for latest 18.x
          // ... existing versions
        }
        ```
     5. See the detailed instructions in `edb-binary-urls.ts` header comments

3. **Update tests:**
   - `tests/unit/binary-manager.test.ts` - Add test case for new version
   - `tests/unit/version-validator.test.ts` - Add version to test arrays

4. **Update CI workflow** (if changing the default version):
   - `.github/workflows/ci.yml` - Update `engines download postgresql <version>` in both `test-postgresql` and `test-cli-e2e` jobs to match the new default

5. **Update documentation:**
   - **README.md** - Update "Supported Engines" section (versions list)
   - **CLAUDE.md** - Update version references in this file
   - **CHANGELOG.md** - Add to unreleased section

## Implementation Details

### Port Management
- PostgreSQL default: 5432 (range: 5432-5500)
- MySQL default: 3306 (range: 3306-3400)
- MongoDB default: 27017 (range: 27017-27100)
- Redis default: 6379 (range: 6379-6400)
- Auto-increment on conflict

### Process Management

**PostgreSQL:**
```bash
pg_ctl start -D {dataDir} -l {logFile} -w -o "-p {port}"
pg_ctl stop -D {dataDir} -m fast -w
```

**MySQL:**
```bash
mysqld --datadir={dataDir} --port={port} --socket={socket} ...
mysqladmin -h 127.0.0.1 -P {port} -u root shutdown
```

**MongoDB:**
```bash
mongod --dbpath {dataDir} --port {port} --logpath {logFile} --fork
mongosh --port {port} --eval "db.adminCommand({shutdown: 1})"
```

### Version Resolution (PostgreSQL)
Major versions (e.g., `"17"`) resolve to full versions (e.g., `"17.7.0"`) via Maven Central or fallback map. Full versions used everywhere.

### Config Cache
Tool paths cached in `~/.spindb/config.json` with 7-day staleness. Refresh after package manager interactions:

```typescript
await configManager.refreshAllBinaries()
```

### Binary Sources by Engine

SpinDB uses different binary sourcing strategies by engine:

**PostgreSQL (Downloadable Binaries):**
- macOS/Linux: [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries) via Maven Central
- Windows: [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries)
- Enables multi-version support (14, 15, 16, 17, 18 side-by-side)
- ~45 MB per version

**MySQL, MongoDB, Redis (System Binaries):**
- Uses system-installed binaries via Homebrew, apt, choco, etc.
- Single version per machine (whatever the package manager provides)
- SpinDB detects and orchestrates, doesn't download

**Why the difference?**
PostgreSQL is unique in having zonky.io—a well-maintained, cross-platform embedded binary distribution hosted on Maven Central. No equivalent exists for other databases:
- MySQL: Oracle provides installers with system dependencies, not embeddable binaries
- MongoDB: Binaries are ~300-500 MB with no portable distribution
- Redis: No official portable distribution; macOS has no options at all

**Windows Redis exception:** For CI testing, SpinDB uses [tporadowski/redis](https://github.com/tporadowski/redis) community port since official Redis doesn't support Windows.

## Error Handling

**Interactive mode:** Log error, show "Press Enter to continue"
**Direct CLI:** Log error, write to `~/.spindb/logs/`, exit non-zero

Error messages should include actionable fix suggestions.

## UI Conventions

### Menu Navigation
- Submenus have "Back" and "Back to main menu" options
- Back buttons: `${chalk.blue('←')} Back`
- Main menu: `${chalk.blue('⌂')} Back to main menu`

### Engine Icons
- PostgreSQL: 🐘
- MySQL: 🐬
- MongoDB: 🍃
- Redis: 🔴
- SQLite: 🗄️

## Known Limitations

1. **Client tools required** - psql/mysql/mongosh/redis-cli must be installed separately
2. **MySQL, MongoDB, and Redis use system binaries** - Unlike PostgreSQL which downloads binaries
3. **Local only** - Binds to 127.0.0.1 (remote connections planned for v1.1)

## Publishing & Versioning

npm publishing via GitHub Actions with OIDC trusted publishing.

### Release Process
1. Create PR to `main`
2. Bump version in `package.json`
3. **Update CHANGELOG.md:**
   - Move items from `[Unreleased]` to new version section
   - Add date in format `[X.Y.Z] - YYYY-MM-DD`
   - Keep `[Unreleased]` section for future changes
4. Merge PR
5. GitHub Actions publishes automatically

### Version Bump Checklist
When bumping the version in `package.json`, always:
1. Update `CHANGELOG.md` with the new version and date
2. Move unreleased items to the new version section
3. Ensure all changes since last release are documented

## Code Style

- ESM imports, no `.js` extensions
- `async/await` over callbacks
- Ora spinners for long operations
- Conventional commits (`feat:`, `fix:`, `chore:`)

See `TODO.md` for roadmap and `CHANGELOG.md` for release history.
