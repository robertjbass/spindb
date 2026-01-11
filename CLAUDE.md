# CLAUDE.md - Project Context for Claude Code

## Style Guide

See [STYLEGUIDE.md](STYLEGUIDE.md) for coding conventions and style guidelines.

## Project Overview

SpinDB is a CLI tool for running local databases without Docker. It's a lightweight alternative to DBngin and Postgres.app, downloading database binaries directly from [hostdb](https://github.com/robertjbass/hostdb). Supports PostgreSQL, MySQL, MariaDB, MongoDB, Redis, and SQLite (all via hostdb downloads).

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
├── os-dependencies.ts      # OS-specific deps
├── engines.json            # Engines registry (source of truth)
└── engines-registry.ts     # Type-safe loader for engines.json
engines/
├── base-engine.ts          # Abstract base class
├── index.ts                # Engine registry
├── postgresql/
│   ├── index.ts            # PostgreSQL engine
│   ├── binary-urls.ts      # hostdb URL builder (macOS/Linux)
│   ├── hostdb-releases.ts  # hostdb GitHub releases API
│   ├── edb-binary-urls.ts  # Windows EDB URL builder
│   ├── binary-manager.ts   # Client tool management
│   ├── backup.ts           # pg_dump wrapper
│   ├── restore.ts          # Restore logic
│   └── version-validator.ts
├── mysql/
│   ├── index.ts            # MySQL engine
│   ├── binary-urls.ts      # hostdb URL builder
│   ├── hostdb-releases.ts  # hostdb GitHub releases API
│   ├── version-maps.ts     # Version mapping
│   ├── binary-manager.ts   # Download/extraction
│   ├── binary-detection.ts # Legacy system binary detection
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

```ts
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
- Server binaries from [hostdb](https://github.com/robertjbass/hostdb) (macOS/Linux) or EDB (Windows)
- Client tools (psql, pg_dump) bundled with hostdb binaries
- Versions: 14, 15, 16, 17, 18
- Orphaned container support: if engine is deleted, containers remain and prompt to re-download on start

**MySQL 🐬**
- Server binaries from [hostdb](https://github.com/robertjbass/hostdb) for all platforms
- Client tools (mysql, mysqldump, mysqladmin) bundled with hostdb binaries
- Versions: 8.0, 8.4, 9
- Orphaned container support: if engine is deleted, containers remain and prompt to re-download on start

**MongoDB 🍃**
- Server binaries from [hostdb](https://github.com/robertjbass/hostdb) for all platforms
- Client tools (mongod, mongosh, mongodump, mongorestore) bundled with hostdb binaries
- Versions: 7.0, 8.0, 8.2
- Uses JavaScript for queries instead of SQL

**Redis 🔴**
- Server binaries from [hostdb](https://github.com/robertjbass/hostdb) for all platforms
- Client tools (redis-server, redis-cli) bundled with hostdb binaries
- Versions: 7, 8
- Uses numbered databases (0-15) instead of named databases
- Uses Redis commands instead of SQL

### Engines JSON Registry

The `config/engines.json` file is the source of truth for all supported database engines. It contains metadata like display names, icons, supported versions, binary sources, and status.

**Type-Safe Engine Handling:**

The `Engine` enum in `types/index.ts` defines all supported engines. When adding a new engine:

1. Add to `Engine` enum in `types/index.ts`
2. Add to `ALL_ENGINES` array in `types/index.ts` (TypeScript will error if missing)
3. Add to `config/engines.json` (runtime validation will error if missing)

```ts
// types/index.ts
export enum Engine {
  PostgreSQL = 'postgresql',
  MySQL = 'mysql',
  // ... add new engine here
}

// ALL_ENGINES must include all enum values - compile-time checked
export const ALL_ENGINES = [
  Engine.PostgreSQL,
  Engine.MySQL,
  // ... if you forget to add here, TypeScript errors
] as const

// Use assertExhaustive in switch statements
function getPort(engine: Engine): number {
  switch (engine) {
    case Engine.PostgreSQL: return 5432
    case Engine.MySQL: return 3306
    // ... if you forget a case, TypeScript errors in default
    default: assertExhaustive(engine)
  }
}
```

**CLI Command:**

```bash
spindb engines supported          # List all supported engines
spindb engines supported --json   # Full config as JSON
spindb engines supported --all    # Include pending/planned engines
```

### Backup & Restore Formats

Each engine supports specific backup formats with different restore behaviors:

| Engine | Format 1 | Format 2 | Notes |
|--------|----------|----------|-------|
| PostgreSQL | `.sql` (plain SQL) | `.dump` (pg_dump custom) | Standard pg_dump/pg_restore |
| MySQL | `.sql` (plain SQL) | `.sql.gz` (compressed) | Standard mysqldump |
| SQLite | `.sql` (plain SQL) | `.sqlite` (binary copy) | Direct file operations |
| MongoDB | `.bson` (BSON) | `.archive` (compressed) | mongodump/mongorestore |
| Redis | `.redis` (text commands) | `.rdb` (RDB snapshot) | See notes below |

**Redis-specific restore behavior:**
- **RDB (`.rdb`)**: Binary snapshot. Requires stopping Redis, copying file to data dir, then restart.
- **Text (`.redis`)**: Human-readable Redis commands. Pipes to running Redis instance.
  - Content-based detection: Files are recognized as Redis commands by analyzing content (looking for SET, HSET, DEL, etc.), not just extension. This allows restoring files like `users.txt` or `data.dump`.
  - Merge vs Replace: For text restores, user chooses:
    - **Replace all**: Runs `FLUSHDB` first (clean slate)
    - **Merge**: Adds/updates keys, keeps existing keys not in backup
- **No "Create new database"**: Redis uses numbered databases 0-15 that always exist.

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

```ts
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

```ts
// CORRECT: Wraps psql CLI
async createDatabase(container: ContainerConfig, database: string): Promise<void> {
  await execAsync(
    `"${psqlPath}" -h 127.0.0.1 -p ${port} -U postgres -d postgres -c 'CREATE DATABASE "${database}"'`
  )
}
```

### Transactional Operations
Multi-step operations must be atomic. Use `TransactionManager` for rollback support:

```ts
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
9. Add integration test job to `.github/workflows/ci.yml` for all 3 OSes (see CI Binary Caching below)
10. Update documentation: README.md, CHANGELOG.md, TODO.md

**CI Binary Caching (REQUIRED for hostdb-based engines):**

All engines that download binaries from hostdb MUST have a cache step in `.github/workflows/ci.yml` to avoid re-downloading ~100MB+ binaries on every CI run:

```yaml
# Cache {Engine} binaries - these are downloaded from hostdb
- name: Cache {Engine} binaries
  uses: actions/cache@v4
  id: {engine}-cache
  with:
    path: ~/.spindb/bin
    key: spindb-{engine}-{version}-${{ runner.os }}-${{ runner.arch }}

# Download {Engine} binaries via hostdb
- name: Install {Engine} via SpinDB
  run: pnpm start engines download {engine} {version}
```

Current engines with CI caching:
- PostgreSQL: `spindb-pg-18-${{ runner.os }}-${{ runner.arch }}`
- MariaDB: `spindb-mariadb-11.8-${{ runner.os }}-${{ runner.arch }}`
- MySQL: `spindb-mysql-9-${{ runner.os }}-${{ runner.arch }}`
- MongoDB: `spindb-mongodb-8.0-${{ runner.os }}-${{ runner.arch }}`
- Redis: `spindb-redis-8-${{ runner.os }}-${{ runner.arch }}`
- SQLite: `spindb-sqlite-3-${{ runner.os }}-${{ runner.arch }}`

**Reference implementations:**
- **PostgreSQL** - Server database with downloadable binaries (hostdb/EDB)
- **MySQL** - Server database with downloadable binaries (hostdb)
- **MariaDB** - Server database with downloadable binaries (hostdb)
- **MongoDB** - Server database with downloadable binaries (hostdb), uses JavaScript instead of SQL
- **Redis** - Key-value store with downloadable binaries (hostdb), uses Redis commands instead of SQL
- **SQLite** - File-based (embedded) database with downloadable binaries (hostdb), uses SQL

**Engine Types:**
- **Server databases** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis): Data in `~/.spindb/containers/`, port management, start/stop
- **File-based databases** (SQLite): Data in project directory (CWD), no port/process management

### Migrating an Engine from System Binaries to hostdb

When hostdb adds support for a new engine, follow these steps to migrate from system-installed binaries to downloadable hostdb binaries. **Reference: MariaDB engine** as an example.

**Current status:** All engines now use hostdb downloads:
- PostgreSQL, MySQL, MariaDB, MongoDB, Redis: Complete bundles from hostdb (server + all client tools)
- SQLite: Tools from hostdb (sqlite3, sqldiff, sqlite3_analyzer, sqlite3_rsync)

#### Prerequisites

**CRITICAL: Check hostdb releases.json first**

Before starting, verify binaries exist and note exact versions:
1. View https://github.com/robertjbass/hostdb/blob/main/releases.json
2. Find the engine under `databases.{engine}`
3. Note ALL available versions (e.g., `"8.0.5"`, `"8.2.0"`) - these become your version map
4. Note supported platforms (darwin-arm64, darwin-x64, linux-x64)
5. **The version-maps.ts file MUST match releases.json exactly** - any version not in releases.json will fail to download

**MySQL Migration Note:** When MySQL is migrated to hostdb, it will use actual MySQL binaries on ALL platforms. Previously, SpinDB used MariaDB as a drop-in replacement for MySQL on Linux (since MySQL wasn't easily available via apt). With hostdb providing MySQL binaries directly, this workaround is no longer needed. MySQL and MariaDB will be fully separate engines with their own binaries.

#### Step 1: Create Binary Management Files

Create these new files in `engines/{engine}/`:

**`version-maps.ts`** - Maps major versions to full versions

**SYNC REQUIREMENT:** This file must match hostdb releases.json exactly. Check releases.json first, then create this file with those exact versions.

```ts
/**
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * To update: Check releases.json, find databases.{engine}, copy all version strings.
 */
export const {ENGINE}_VERSION_MAP: Record<string, string> = {
  // Copy ALL versions from releases.json - extract major version as key
  '8': '8.0.5',    // From releases.json: "8.0.5"
  '8.2': '8.2.0',  // From releases.json: "8.2.0" (if minor versions differ)
}

export const SUPPORTED_MAJOR_VERSIONS = Object.keys({ENGINE}_VERSION_MAP)
export const FALLBACK_VERSION_MAP = {ENGINE}_VERSION_MAP
```

**`binary-urls.ts`** - Generates download URLs for hostdb releases
```ts
const HOSTDB_BASE_URL = 'https://github.com/robertjbass/hostdb/releases/download'

export function getBinaryUrl(version: string, platform: string, arch: string): string {
  const fullVersion = FALLBACK_VERSION_MAP[version] || version
  const platformKey = `${platform}-${arch}`
  return `${HOSTDB_BASE_URL}/{engine}-${fullVersion}/${engine}-${fullVersion}-${platformKey}.tar.gz`
}
```

**`binary-manager.ts`** - Handles download, extraction, verification
- Copy structure from `engines/mariadb/binary-manager.ts` or `engines/postgresql/binary-manager.ts`
- Update engine name, binary names, and verification logic

#### Step 2: Update Main Engine File (`index.ts`)

Key changes to make:

1. **Import new modules:**
   ```ts
   import { {engine}BinaryManager } from './binary-manager'
   import { getBinaryUrl, SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './binary-urls'
   ```

2. **Update `supportedVersions`:**
   ```ts
   supportedVersions = SUPPORTED_MAJOR_VERSIONS
   ```

3. **Update `ensureBinaries()` to register engine-native binaries only:**
   ```ts
   async ensureBinaries(version: string, onProgress?: ProgressCallback): Promise<string> {
     const { platform, arch } = this.getPlatformInfo()
     const binPath = await binaryManager.ensureInstalled(version, platform, arch, onProgress)

     // CRITICAL: Register ONLY engine-native binary names to avoid conflicts
     // e.g., for MariaDB: 'mariadb', 'mariadb-dump', 'mariadb-admin'
     // NOT: 'mysql', 'mysqldump', 'mysqladmin' (those belong to MySQL engine)
     const ext = platformService.getExecutableExtension()
     const clientTools = ['{engine}', '{engine}-dump', '{engine}-admin'] as const

     for (const tool of clientTools) {
       const toolPath = join(binPath, 'bin', `${tool}${ext}`)
       if (existsSync(toolPath)) {
         await configManager.setBinaryPath(tool, toolPath, 'bundled')
       }
     }
     return binPath
   }
   ```

4. **Create engine-specific client path method:**
   ```ts
   override async get{Engine}ClientPath(): Promise<string> {
     const configPath = await configManager.getBinaryPath('{engine}')
     if (configPath) return configPath
     throw new Error('{engine} client not found. Run: spindb engines download {engine}')
   }
   ```

5. **Update all internal methods to use engine-specific client:**
   - Replace calls like `getMysqlClientPath()` with `get{Engine}ClientPath()`
   - Update dump/restore methods to use engine-specific binary keys

#### Step 3: Update Type Definitions (`types/index.ts`)

1. **Add to `BinaryTool` type:**
   ```ts
   // {Engine} tools (native names only - no conflicts with other engines)
   | '{engine}'
   | '{engine}-dump'
   | '{engine}d'  // server binary if applicable
   | '{engine}-admin'
   ```

2. **Add to `SpinDBConfig.binaries`:**
   ```ts
   // {Engine} tools
   {engine}?: BinaryConfig
   '{engine}-dump'?: BinaryConfig
   '{engine}d'?: BinaryConfig
   '{engine}-admin'?: BinaryConfig
   ```

#### Step 4: Update BaseEngine (`engines/base-engine.ts`)

Add the engine-specific client path method with default implementation:
```ts
/**
 * Get the path to the {engine} client if available
 * Default implementation throws; {Engine} engine overrides this method.
 */
async get{Engine}ClientPath(): Promise<string> {
  throw new Error('{engine} client not found')
}
```

#### Step 5: Update Test Helpers (`tests/integration/helpers.ts`)

**CRITICAL:** Each engine must have its own case in `executeSQL()` and `executeSQLFile()`:

```ts
} else if (engine === Engine.{Engine}) {
  const engineImpl = getEngine(engine)
  const clientPath = await engineImpl.get{Engine}ClientPath().catch(() => '{engine}')
  const cmd = `"${clientPath}" -h 127.0.0.1 -P ${port} -u root ${database} -e "${sql}"`
  return execAsync(cmd)
}
```

**Why separate cases?** Using a shared case (e.g., `MySQL || MariaDB`) and calling `getMysqlClientPath()` will fail for the new engine because that method returns the wrong binary. Each engine must call its own client path method.

#### Step 6: Update Shell Handlers (`cli/commands/menu/shell-handlers.ts`)

1. **Add to shell option selection (around line 110):**
   ```ts
   } else if (config.engine === '{engine}') {
     defaultShellName = '{engine}'
     engineSpecificCli = 'mycli'  // or appropriate enhanced CLI
     // ...
   }
   ```

2. **Add to `launchShell()` function (around line 435):**
   ```ts
   } else if (config.engine === '{engine}') {
     const clientPath = await configManager.getBinaryPath('{engine}')
     shellCmd = clientPath || '{engine}'
     shellArgs = ['-u', 'root', '-h', '127.0.0.1', '-P', String(config.port), config.database]
     installHint = 'spindb engines download {engine}'
   }
   ```

#### Step 7: Update Manage Engines Screen

**Why this matters:** System-installed engines (MySQL, MongoDB, Redis) don't appear in the "Manage Engines" menu because there's nothing to manage - they're installed via Homebrew/apt. Once migrated to hostdb, the engine WILL appear in this menu and users can download/delete versions. This requires adding detection functions.

1. **Add type in `cli/helpers.ts`:**
   ```ts
   export type Installed{Engine}Engine = {
     engine: '{engine}'
     version: string
     platform: string
     arch: string
     path: string
     sizeBytes: number
     source: 'downloaded'
   }
   ```

2. **Add detection function in `cli/helpers.ts`:**
   ```ts
   export async function getInstalled{Engine}Engines(): Promise<Installed{Engine}Engine[]> {
     const binDir = paths.binaries
     if (!existsSync(binDir)) return []

     const entries = await readdir(binDir, { withFileTypes: true })
     const engines: Installed{Engine}Engine[] = []

     for (const entry of entries) {
       if (!entry.isDirectory()) continue
       // Match pattern: {engine}-{version}-{platform}-{arch}
       const match = entry.name.match(/^{engine}-(\d+\.\d+\.\d+)-(\w+)-(\w+)$/)
       if (!match) continue

       const [, version, platform, arch] = match
       const fullPath = join(binDir, entry.name)
       const stats = await stat(fullPath)

       engines.push({
         engine: '{engine}',
         version,
         platform,
         arch,
         path: fullPath,
         sizeBytes: await getDirectorySize(fullPath),
         source: 'downloaded',
       })
     }
     return engines
   }
   ```

3. **Export from `cli/helpers.ts`** - add to exports

4. **Update `cli/commands/menu/engine-handlers.ts`:**
   ```ts
   import { getInstalled{Engine}Engines } from '../../helpers'

   // In handleManageEngines():
   const {engine}Engines = await getInstalled{Engine}Engines()
   const installedEngines = [...postgresEngines, ...mariadbEngines, ...{engine}Engines]
   ```

5. **Handle deletion in `handleDeleteEngine()`** - add case for the new engine type

#### Step 8: Update Config Defaults (`config/engine-defaults.ts`)

```ts
{engine}: {
  supportedVersions: ['8', '9'],  // Keep in sync with version-maps.ts
  defaultVersion: '8',
  latestVersion: '9',
  // ...
}
```

#### Step 9: Clean Up and Test

1. **Clear stale config entries:** Users with old installations may have binaries registered under wrong keys. They need to:
   ```bash
   # Delete old config entries pointing to wrong binaries
   # Re-download engine: spindb engines download {engine}
   ```

2. **Run all tests:**
   ```bash
   pnpm lint                    # TypeScript compilation
   pnpm test:unit              # Unit tests
   pnpm test:{engine}          # Integration tests for this engine
   pnpm test:mysql             # Verify no regression on similar engines
   ```

#### Common Pitfalls

1. **Binary key conflicts:** Never register binaries under keys used by another engine. MariaDB must use `mariadb`, not `mysql`.

2. **Forgetting BaseEngine method:** If you add `get{Engine}ClientPath()` to the engine but not to `BaseEngine`, TypeScript will fail when test helpers call it.

3. **Shared test helper cases:** Don't combine engines in test helpers like `MySQL || MariaDB`. Each needs its own case calling its own client path method.

4. **Stale config.json:** After migration, old binary registrations may point to wrong paths. Clear and re-register.

5. **Missing `override` keyword:** When overriding BaseEngine methods, always use `override` keyword.

### Updating Supported Engine Versions

#### For hostdb-based engines (PostgreSQL, MariaDB)

When new versions are added to hostdb releases.json:

1. **Check hostdb releases.json:**
   - View: https://github.com/robertjbass/hostdb/blob/main/releases.json
   - Look for new versions under `databases.postgresql` or `databases.mariadb`

2. **Update version-maps.ts:**
   - Add new major versions to `engines/{engine}/version-maps.ts`
   - Example for MariaDB:
     ```ts
     export const MARIADB_VERSION_MAP: Record<string, string> = {
       '10.11': '10.11.15',
       '11.4': '11.4.5',
       '11.8': '11.8.5',  // New version
     }
     ```
   - `SUPPORTED_MAJOR_VERSIONS` is automatically derived from map keys
   - **IMPORTANT:** Versions not in this map will NOT appear in SpinDB, even if in releases.json

3. **Update config/engine-defaults.ts:**
   - Add to `supportedVersions` array
   - Update `defaultVersion` and `latestVersion` if needed

4. **Windows-specific (PostgreSQL only):**
   - PostgreSQL Windows binaries require EDB file IDs
   - Visit: https://www.enterprisedb.com/download-postgresql-binaries
   - Add file ID to `engines/postgresql/edb-binary-urls.ts`

5. **Update tests:**
   - `tests/unit/{engine}-*.test.ts` - Add test cases for new versions

6. **Update CI workflow (if changing default):**
   - `.github/workflows/ci.yml` - Update `engines download {engine} <version>`

7. **Update documentation:**
   - README.md, CLAUDE.md, CHANGELOG.md

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
Major versions (e.g., `"17"`) resolve to full versions (e.g., `"17.7.0"`) via hostdb GitHub API or fallback map. Full versions used everywhere.

### Config Cache
Tool paths cached in `~/.spindb/config.json` with 7-day staleness. Refresh after package manager interactions:

```ts
await configManager.refreshAllBinaries()
```

### Binary Sources by Engine

SpinDB uses different binary sourcing strategies by engine:

**PostgreSQL (Downloadable Binaries):**
- macOS/Linux: [hostdb](https://github.com/robertjbass/hostdb) via GitHub Releases
- Windows: [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries)
- Enables multi-version support (14, 15, 16, 17, 18 side-by-side)
- ~45 MB per version
- macOS: Includes client tools (psql, pg_dump, pg_restore)
- Linux: Client tools downloaded separately from PostgreSQL apt repository if missing

**MariaDB (Downloadable Binaries):**
- All platforms: [hostdb](https://github.com/robertjbass/hostdb) via GitHub Releases
- Enables multi-version support (10.11, 11.4, 11.8 side-by-side)

**MySQL (Downloadable Binaries):**
- All platforms: [hostdb](https://github.com/robertjbass/hostdb) via GitHub Releases
- Enables multi-version support (8.0, 8.4, 9 side-by-side)
- Includes client tools (mysql, mysqldump, mysqladmin)

**MongoDB (Downloadable Binaries):**
- All platforms: [hostdb](https://github.com/robertjbass/hostdb) via GitHub Releases
- Enables multi-version support (7.0, 8.0, 8.2 side-by-side)
- All tools bundled: mongod, mongosh, mongodump, mongorestore

**Redis (Downloadable Binaries):**
- All platforms: [hostdb](https://github.com/robertjbass/hostdb) via GitHub Releases
- Enables multi-version support (7, 8 side-by-side)
- Tools bundled: redis-server, redis-cli

**SQLite (Downloadable Binaries):**
- All platforms: [hostdb](https://github.com/robertjbass/hostdb) via GitHub Releases
- Version 3 (only major version)
- Tools bundled: sqlite3, sqldiff, sqlite3_analyzer, sqlite3_rsync
- File-based database - no server process, data stored in user project directories

### Orphaned Container Support (PostgreSQL)

When a PostgreSQL engine is deleted while containers still reference it:

1. **Engine deletion**: Stops any running containers first, then deletes the engine binary
2. **Orphaned containers**: Container data remains intact in `~/.spindb/containers/`
3. **Starting orphaned container**: Detects missing engine, prompts to download from hostdb
4. **Fallback stop**: If engine is missing, uses direct process kill (SIGTERM/SIGKILL) instead of pg_ctl

This allows users to delete engines to free disk space and re-download them later when needed.

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
