# New Database Engine Implementation Guide

This document provides the complete specification for adding a new database engine to SpinDB. Follow this checklist to ensure all requirements are met before the engine is considered complete.

## Table of Contents

1. [Overview](#overview)
2. [Engine Types](#engine-types)
3. [Quick Start Checklist](#quick-start-checklist)
4. [Core Implementation](#core-implementation)
5. [Configuration Files](#configuration-files)
6. [CLI Menu Handlers](#cli-menu-handlers)
7. [Testing Requirements](#testing-requirements)
8. [GitHub Actions / CI](#github-actions--ci)
9. [Docker Tests](#docker-tests)
10. [Binary Management](#binary-management)
11. [Restore Implementation](#restore-implementation)
12. [OS Dependencies](#os-dependencies)
13. [Windows Considerations](#windows-considerations)
14. [Documentation Updates](#documentation-updates)
15. [Pass/Fail Criteria](#passfail-criteria)
16. [Reference Implementations](#reference-implementations)

---

## Overview

SpinDB supports multiple database engines through an abstract `BaseEngine` class. Each engine must implement all abstract methods and integrate with the existing CLI infrastructure.

**Key Principles:**

1. **CLI-First**: All functionality must be available via command-line arguments
2. **Wrapper Pattern**: Functions wrap CLI tools (psql, mysql, mongosh, redis-cli) rather than implementing database logic
3. **Cross-Platform**: Must work on macOS, Linux, and Windows
4. **Transactional**: Multi-step operations must be atomic with rollback support

---

## Engine Types

SpinDB supports two types of database engines:

### Server-Based Databases (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse, Qdrant)

- Data stored in `~/.spindb/containers/{engine}/{name}/`
- Require start/stop lifecycle management
- Use port allocation and process management
- Have log files and PID tracking

**Sub-types:**
- **CLI-based servers** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse): Interact via CLI tools (psql, mysql, redis-cli, etc.)
- **REST API servers** (Qdrant): Interact via HTTP REST API instead of CLI tools. These require special handling in tests and CLI commands since `spindb run` doesn't apply.

### File-Based Databases (SQLite, DuckDB)

- Data stored in user project directories (CWD)
- No start/stop required (embedded)
- No port management needed (`port: 0`)
- Connection string is the file path
- Use a registry to track file locations
- Status is `running` when file exists, `stopped` when missing

**Edge cases for file-based engines:**

When implementing a file-based engine like SQLite or DuckDB, these operations behave differently:

| Operation | Server DB (PostgreSQL, etc.) | File-Based (SQLite, DuckDB) |
|-----------|------------------------------|---------------------|
| `start()` | Starts server process | No-op or skip |
| `stop()` | Stops server process | No-op or skip |
| `port` | Allocated from port range | Always `0` |
| `status` | `running` / `stopped` based on process | `running` / `stopped` based on file existence |
| `waitForReady()` | Poll until server responds | Run query directly (no wait) |
| `test_engine_lifecycle()` | Full start/stop/status cycle | Skip start/stop, just query |
| Connection string | `scheme://host:port/db` | File path (e.g., `/path/to/db.sqlite`) |

**In integration tests and test-local.sh:**

```ts
// Integration test example - skip start/stop for file-based engines
const isFileBased = engine === Engine.SQLite || engine === Engine.DuckDB
if (!isFileBased) {
  await engineInstance.start(container)
  const ready = await waitForReady(engine, port)
  // ...
  await engineInstance.stop(container)
}

// Query test works for all engines (file-based engines run query directly)
const result = await executeSQL(engine, port, database, 'SELECT 1;')
```

```bash
# In test-local.sh - lifecycle skips start/stop for file-based engines
if [ "$engine" != "sqlite" ] && [ "$engine" != "duckdb" ]; then
  pnpm start start "$container_name"
  # wait_for_ready, status check, etc.
fi
# Query test runs for all engines including file-based
```

**Test reliability for file-based engines:**

Integration tests for file-based engines (SQLite, DuckDB) verify they're using downloaded binaries, not system-installed ones. This ensures tests actually validate the binary extraction pipeline:

```ts
// In before() hook of sqlite.test.ts and duckdb.test.ts
async function verifyUsingDownloadedBinaries(): Promise<void> {
  const config = await configManager.getBinaryConfig('sqlite3') // or 'duckdb'
  if (config?.source === 'system') {
    throw new Error(
      'Tests are using system binary, not downloaded binaries. ' +
        'Run: spindb engines download sqlite 3',
    )
  }
}
```

---

## Quick Start Checklist

Use this checklist to track implementation progress. **Reference: Valkey implementation** for a complete example.

### Core Engine Files (8 required + 1 optional)

- [ ] `engines/{engine}/index.ts` - Main engine class extending `BaseEngine`
- [ ] `engines/{engine}/backup.ts` - Backup creation wrapper
- [ ] `engines/{engine}/restore.ts` - Backup detection and restore logic
- [ ] `engines/{engine}/version-validator.ts` - Version parsing and compatibility
- [ ] `engines/{engine}/version-maps.ts` - Major version to full version mapping (hostdb sync)
- [ ] `engines/{engine}/binary-urls.ts` - hostdb download URL construction
- [ ] `engines/{engine}/binary-manager.ts` - Download, extraction, verification
- [ ] `engines/{engine}/hostdb-releases.ts` - Fetch versions from releases.json
- [ ] `engines/{engine}/cli-utils.ts` - Shared CLI utilities (optional)

### Configuration Files (12 files)

- [ ] `engines/index.ts` - Register engine with aliases
- [ ] `types/index.ts` - Add to `Engine` enum, `ALL_ENGINES`, and `BinaryTool` type
- [ ] `config/engine-defaults.ts` - Add engine defaults
- [ ] `config/engines.json` - Add engine metadata (icon, versions, status)
- [ ] `config/engines.schema.json` - Update `queryLanguage` enum if adding new query type (e.g., `rest`)
- [ ] `config/backup-formats.ts` - Add backup format configuration (extensions, labels, defaults)
- [ ] `config/os-dependencies.ts` - Add system dependencies
- [ ] `core/dependency-manager.ts` - Add binary tools to `KNOWN_BINARY_TOOLS` array
- [ ] `core/config-manager.ts` - Add `XXX_TOOLS` constant and to `ENGINE_BINARY_MAP`
- [ ] `cli/constants.ts` - Add engine icon to `ENGINE_ICONS`
- [ ] `cli/helpers.ts` - Add `InstalledXxxEngine` type and detection function
- [ ] `cli/commands/engines.ts` - Add download case and list display for the engine

### CLI Commands (1 file)

- [ ] `cli/commands/create.ts` - Update `--engine` help text and `detectLocationType()` for connection strings

### CLI Menu Handlers (5 files)

- [ ] `cli/commands/menu/container-handlers.ts` - Skip database name prompt if numbered DBs; **hide "Run SQL file" for REST API engines**
- [ ] `cli/commands/menu/shell-handlers.ts` - Add engine-specific shell and enhanced CLI (skip for REST API engines)
- [ ] `cli/commands/menu/sql-handlers.ts` - Update script type terminology (SQL/Script/Command)
- [ ] `cli/commands/menu/backup-handlers.ts` - Add connection string validation for the engine in `handleRestore()` and `handleRestoreForContainer()`
- [ ] `cli/commands/menu/engine-handlers.ts` - Add to "Manage Engines" display

### Package Metadata (1 file)

- [ ] `package.json` - Add engine name to `keywords` array for npm discoverability

### Testing (6+ files)

- [ ] `tests/fixtures/{engine}/seeds/sample-db.{ext}` - Test seed file (REQUIRED - see "Test Fixtures" section)
  - **CRITICAL:** Every engine MUST have a fixtures directory, even REST API engines
  - SQL engines: `sample-db.sql` with 5 test_user records
  - Key-value engines: `sample-db.{engine}` with 6 keys (5 users + count)
  - REST API engines (e.g., Qdrant): `README.md` explaining the API-based approach
- [ ] `tests/integration/{engine}.test.ts` - Integration tests (14+ tests minimum)
- [ ] `tests/integration/helpers.ts` - Add engine to helper functions
- [ ] `tests/unit/{engine}-version-validator.test.ts` - Version validator unit tests
- [ ] `tests/unit/{engine}-restore.test.ts` - Restore/backup format unit tests
- [ ] `package.json` - Add `test:{engine}` script

### CI/CD (2 files)

- [ ] `.github/workflows/ci.yml` - Add integration test job with binary caching
- [ ] `.github/workflows/ci.yml` - Add to `ci-success` job needs and checks

### Docker Tests (2 files) - CRITICAL

**Run `pnpm test:docker` to verify your engine works on Linux.** This catches library dependency issues AND verifies backup/restore functionality.

```bash
pnpm test:docker              # Run all engine tests
pnpm test:docker -- {engine}  # Run single engine test (faster for debugging)
```

Valid engines: `postgresql`, `mysql`, `mariadb`, `sqlite`, `mongodb`, `redis`, `valkey`, `clickhouse`, `duckdb`, `qdrant`

- [ ] `tests/docker/Dockerfile` - Add engine to comments listing downloaded engines
- [ ] `tests/docker/Dockerfile` - Add any required library dependencies (e.g., `libaio1` for MySQL, `libncurses6` for MariaDB)
- [ ] `tests/docker/run-e2e.sh` - Add to `EXPECTED_COUNTS` array (number of records in seed file)
- [ ] `tests/docker/run-e2e.sh` - Add to `BACKUP_FORMATS` array (primary|secondary formats)
- [ ] `tests/docker/run-e2e.sh` - Add case in `insert_seed_data()` function
- [ ] `tests/docker/run-e2e.sh` - Add case in `get_data_count()` function
- [ ] `tests/docker/run-e2e.sh` - Add case in `create_backup()` function
- [ ] `tests/docker/run-e2e.sh` - Add case in `create_restore_target()` function
- [ ] `tests/docker/run-e2e.sh` - Add case in `restore_backup()` function
- [ ] `tests/docker/run-e2e.sh` - Add case in `verify_restored_data()` function
- [ ] `tests/docker/run-e2e.sh` - Add connectivity test case in `run_test()` function
- [ ] `tests/docker/run-e2e.sh` - Add engine test execution at bottom of file
- [ ] For file-based engines: Update `cleanup_data_lifecycle()` and start/stop skip conditions
- [ ] For REST API engines: Add curl-based connectivity test and seed data insertion (see Qdrant example)

### Documentation (7 files)

- [ ] `README.md` - Add engine section with full documentation
- [ ] `README.md` - Update `--engine` option help text to include new engine
- [ ] `CHANGELOG.md` - Add to unreleased section
- [ ] `TODO.md` - Update engine status
- [ ] `ENGINES.md` - Add to supported engines table and details
- [ ] `ENGINES.md` - Add to Engine Emojis table
- [ ] `CLAUDE.md` - Update project documentation

---

## Core Implementation

### Engine Directory Structure

Create a new directory at `engines/{engine}/` with these files:

```
engines/{engine}/
├── index.ts              # Main engine class (required)
├── backup.ts             # Backup wrapper (required)
├── restore.ts            # Restore logic (required)
├── version-validator.ts  # Version parsing (required)
├── version-maps.ts       # Version mapping for hostdb (required)
├── binary-urls.ts        # Download URL construction (required)
├── binary-manager.ts     # Binary download/extraction (required)
├── hostdb-releases.ts    # Fetch versions from hostdb (required)
└── cli-utils.ts          # Shared utilities (optional)
```

### BaseEngine Abstract Methods

Your engine class must extend `BaseEngine` and implement ALL abstract methods. See `engines/base-engine.ts` for the complete interface.

Key methods to implement:

```ts
import { BaseEngine } from '../base-engine'
import type { ContainerConfig, ProgressCallback } from '../../types'

export class YourEngine extends BaseEngine {
  // Required properties
  name = 'yourengine'
  displayName = 'YourEngine'
  defaultPort = 6379
  supportedVersions = ['8', '9']

  // Binary management
  getBinaryUrl(version: string, platform: Platform, arch: Arch): string
  async verifyBinary(binPath: string): Promise<boolean>
  async isBinaryInstalled(version: string): Promise<boolean>
  async ensureBinaries(version: string, onProgress?: ProgressCallback): Promise<string>

  // Lifecycle
  async initDataDir(name: string, version: string, options?: Record<string, unknown>): Promise<string>
  async start(container: ContainerConfig, onProgress?: ProgressCallback): Promise<{ port: number; connectionString: string }>
  async stop(container: ContainerConfig): Promise<void>
  async status(container: ContainerConfig): Promise<StatusResult>

  // Connection
  getConnectionString(container: ContainerConfig, database?: string): string
  async connect(container: ContainerConfig, database?: string): Promise<void>

  // Database operations
  async createDatabase(container: ContainerConfig, database: string): Promise<void>
  async dropDatabase(container: ContainerConfig, database: string): Promise<void>
  async runScript(container: ContainerConfig, options: { file?: string; sql?: string; database?: string }): Promise<void>

  // Backup & restore
  async detectBackupFormat(filePath: string): Promise<BackupFormat>
  async backup(container: ContainerConfig, outputPath: string, options: BackupOptions): Promise<BackupResult>
  async restore(container: ContainerConfig, backupPath: string, options?: Record<string, unknown>): Promise<RestoreResult>
  async dumpFromConnectionString(connectionString: string, outputPath: string): Promise<DumpResult>

  // Engine-specific client path (add to base-engine.ts too)
  async getYourEngineClientPath(): Promise<string>
}

export const yourEngine = new YourEngine()
```

### Engine Registration

Register your engine in `engines/index.ts`:

```ts
import { yourEngine } from './yourengine'

export const engines: Record<string, BaseEngine> = {
  // ... existing engines
  yourengine: yourEngine,
  alias: yourEngine,  // Optional alias (e.g., 'mongo' for 'mongodb')
}
```

---

## Configuration Files

### 1. Types (`types/index.ts`)

Add to the `Engine` enum and `ALL_ENGINES` array:

```ts
export enum Engine {
  PostgreSQL = 'postgresql',
  MySQL = 'mysql',
  SQLite = 'sqlite',
  MongoDB = 'mongodb',
  Redis = 'redis',
  Valkey = 'valkey',
  YourEngine = 'yourengine',  // Add this
}

// ALL_ENGINES must include all enum values - TypeScript will error if you miss one
export const ALL_ENGINES = [
  Engine.PostgreSQL,
  Engine.MySQL,
  Engine.SQLite,
  Engine.MongoDB,
  Engine.Redis,
  Engine.Valkey,
  Engine.YourEngine,  // Add this
] as const
```

Add binary tools to `BinaryTool` type:

```ts
export type BinaryTool =
  // ... existing tools
  // YourEngine tools
  | 'yourengine-server'
  | 'yourengine-cli'
```

### 2. Engine Defaults (`config/engine-defaults.ts`)

Add your engine's defaults:

```ts
export const engineDefaults: Record<string, EngineDefaults> = {
  // ... existing engines

  yourengine: {
    defaultVersion: '9',
    defaultPort: 6379,
    portRange: { start: 6379, end: 6479 },
    supportedVersions: ['8', '9'],
    latestVersion: '9',
    superuser: '',  // Empty if no auth
    connectionScheme: 'redis',  // Use existing scheme if protocol-compatible
    logFileName: 'yourengine.log',
    pidFileName: 'yourengine.pid',
    dataSubdir: 'data',
    clientTools: ['yourengine-cli'],
  },
}
```

### 3. Engines JSON (`config/engines.json`)

Add your engine to the JSON registry:

```json
{
  "yourengine": {
    "displayName": "YourEngine",
    "icon": "🔷",
    "status": "integrated",
    "binarySource": "hostdb",
    "supportedVersions": ["8.0.6", "9.0.1"],
    "defaultVersion": "9.0.1",
    "defaultPort": 6379,
    "runtime": "server",
    "queryLanguage": "redis",
    "connectionScheme": "redis",
    "superuser": null,
    "clientTools": ["yourengine-server", "yourengine-cli"],
    "licensing": "BSD-3-Clause",
    "notes": "Optional notes about the engine"
  }
}
```

### 4. Backup Formats (`config/backup-formats.ts`)

Add your engine's backup format configuration. **Important:** Format names are engine-specific and semantically meaningful.

**Format names by engine type:**

| Engine | Format 1 | Format 2 | Default |
|--------|----------|----------|---------|
| PostgreSQL | `sql` | `custom` | `sql` |
| MySQL | `sql` | `compressed` | `sql` |
| MariaDB | `sql` | `compressed` | `sql` |
| SQLite | `sql` | `binary` | `binary` |
| DuckDB | `sql` | `binary` | `binary` |
| MongoDB | `bson` | `archive` | `archive` |
| Redis | `text` | `rdb` | `rdb` |
| Valkey | `text` | `rdb` | `rdb` |
| ClickHouse | `sql` | _(none)_ | `sql` |

```ts
export const BACKUP_FORMATS: Record<string, EngineBackupFormats> = {
  // ... existing engines

  yourengine: {
    formats: {
      text: {   // Use semantic format name, not 'sql' or 'dump'
        extension: '.yourengine',
        label: '.yourengine',
        description: 'Text commands - human-readable, editable',
        spinnerLabel: 'text',
      },
      rdb: {    // Binary format with semantic name
        extension: '.rdb',
        label: '.rdb',
        description: 'RDB snapshot - binary format, faster restore',
        spinnerLabel: 'RDB',
      },
    },
    supportsFormatChoice: true,      // Whether user can choose format
    defaultFormat: 'rdb',            // Default when not specified
  },
}
```

**Note:** All helper functions (`getBackupFormatInfo`, `supportsFormatChoice`, `getDefaultFormat`, `isValidFormat`) will throw an error if your engine is not configured here. This ensures configuration errors are caught early.

### 5. OS Dependencies (`config/os-dependencies.ts`)

Add system dependencies for fallback installation:

```ts
const yourengineDependencies: EngineDependencies = {
  engine: 'yourengine',
  displayName: 'YourEngine',
  dependencies: [
    {
      name: 'yourengine-server',
      binary: 'yourengine-server',
      description: 'YourEngine server daemon',
      packages: {
        brew: { package: 'yourengine' },
        // Add other package managers as available
      },
      manualInstall: {
        darwin: [
          'brew install yourengine',
          'Or use SpinDB: spindb engines download yourengine 9',
        ],
        linux: [
          'Use SpinDB to download binaries: spindb engines download yourengine 9',
        ],
        win32: [
          'Use SpinDB to download binaries: spindb engines download yourengine 9',
        ],
      },
    },
    {
      name: 'yourengine-cli',
      binary: 'yourengine-cli',
      description: 'YourEngine command-line client',
      packages: {
        brew: { package: 'yourengine' },
      },
      manualInstall: {
        // ... same as above
      },
    },
  ],
}

// Add to registry
export const engineDependencies: EngineDependencies[] = [
  // ... existing engines
  yourengineDependencies,
]
```

### 6. Dependency Manager (`core/dependency-manager.ts`)

**CRITICAL:** Add your binary tools to the `KNOWN_BINARY_TOOLS` array. Without this, `findBinary()` cannot look up your tools from the config cache, causing "Missing tools" errors even after binaries are downloaded.

```ts
const KNOWN_BINARY_TOOLS: readonly BinaryTool[] = [
  // ... existing tools
  'redis-server',
  'redis-cli',
  'valkey-server',    // Add your engine's server
  'valkey-cli',       // Add your engine's client
  'yourengine-server',
  'yourengine-cli',
  // ... other tools
] as const
```

### 7. Config Manager (`core/config-manager.ts`)

**CRITICAL:** Add your engine to the binary scanning system. Without this, `scanInstalledBinaries()` won't re-register your binaries if the config is cleared.

1. **Add tools constant:**

```ts
const YOURENGINE_TOOLS: BinaryTool[] = ['yourengine-server', 'yourengine-cli']
```

2. **Add to ALL_TOOLS array:**

```ts
const ALL_TOOLS: BinaryTool[] = [
  // ... existing tools
  ...REDIS_TOOLS,
  ...VALKEY_TOOLS,
  ...YOURENGINE_TOOLS,  // Add your engine
  ...SQLITE_TOOLS,
  ...ENHANCED_SHELLS,
]
```

3. **Add to ENGINE_BINARY_MAP:**

```ts
const ENGINE_BINARY_MAP: Partial<Record<Engine, BinaryTool[]>> = {
  // ... existing engines
  [Engine.Redis]: REDIS_TOOLS,
  [Engine.Valkey]: VALKEY_TOOLS,
  [Engine.YourEngine]: YOURENGINE_TOOLS,  // Add your engine
}
```

4. **Add to `initialize()` return type and implementation:**

```ts
async initialize(): Promise<{
  // ... existing fields
  valkey: { found: BinaryTool[]; missing: BinaryTool[] }
  yourengine: { found: BinaryTool[]; missing: BinaryTool[] }  // Add this
  enhanced: { found: BinaryTool[]; missing: BinaryTool[] }
}> {
  // ... in the return object:
  yourengine: {
    found: found.filter((t) => YOURENGINE_TOOLS.includes(t)),
    missing: missing.filter((t) => YOURENGINE_TOOLS.includes(t)),
  },
}
```

5. **Export the tools constant:**

```ts
export {
  // ... existing exports
  VALKEY_TOOLS,
  YOURENGINE_TOOLS,  // Add your engine
  // ...
}
```

### 8. Engine Icon (`cli/constants.ts`)

Add your engine's icon:

```ts
export const ENGINE_ICONS: Record<string, string> = {
  postgresql: '🐘',
  mysql: '🐬',
  mariadb: '🦭',
  sqlite: '🪶',
  mongodb: '🍃',
  redis: '🔴',
  valkey: '🔷',
  yourengine: '🔶',  // Add your engine icon
}
```

### 9. CLI Helpers (`cli/helpers.ts`)

Add installed engine type and detection function:

```ts
export type InstalledYourEngineEngine = {
  engine: 'yourengine'
  version: string
  platform: Platform
  arch: Arch
  path: string
  sizeBytes: number
  source: 'downloaded'
}

export async function getInstalledYourEngineEngines(): Promise<InstalledYourEngineEngine[]> {
  const binDir = paths.bin
  if (!existsSync(binDir)) return []

  const entries = await readdir(binDir, { withFileTypes: true })
  const engines: InstalledYourEngineEngine[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Match pattern: yourengine-{version}-{platform}-{arch}
    const match = entry.name.match(/^yourengine-(\d+\.\d+\.\d+)-(\w+)-(\w+)$/)
    if (!match) continue

    const [, version, platform, arch] = match
    const fullPath = join(binDir, entry.name)

    engines.push({
      engine: 'yourengine',
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

Update the union type and `getInstalledEngines()` function to include your engine.

### 10. Engines Command (`cli/commands/engines.ts`)

**CRITICAL:** This file handles `spindb engines download` and `spindb engines list`. Without this update, the Docker E2E tests will fail.

1. **Import the binary manager:**

```ts
import { yourengineBinaryManager } from '../../engines/yourengine/binary-manager'
```

2. **Import the installed engine type:**

```ts
import {
  // ... existing imports
  type InstalledYourEngineEngine,
} from '../helpers'
```

3. **Add case in download subcommand (after Redis case):**

```ts
if (normalizedEngine === 'yourengine') {
  if (!version) {
    console.error(uiError('YourEngine requires a version (e.g., 9)'))
    process.exit(1)
  }

  const engine = getEngine(Engine.YourEngine)

  const spinner = createSpinner(`Checking YourEngine ${version} binaries...`)
  spinner.start()

  let wasCached = false
  await engine.ensureBinaries(version, ({ stage, message }) => {
    if (stage === 'cached') {
      wasCached = true
      spinner.text = `YourEngine ${version} binaries ready (cached)`
    } else {
      spinner.text = message
    }
  })

  if (wasCached) {
    spinner.succeed(`YourEngine ${version} binaries already installed`)
  } else {
    spinner.succeed(`YourEngine ${version} binaries downloaded`)
  }

  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = yourengineBinaryManager.getFullVersion(version)
  const binPath = paths.getBinaryPath({
    engine: 'yourengine',
    version: fullVersion,
    platform,
    arch,
  })
  console.log(chalk.gray(`  Location: ${binPath}`))

  await checkAndInstallClientTools('yourengine', binPath)
  return
}
```

4. **Update error message to include your engine:**

```ts
console.error(
  uiError(
    `Unknown engine "${engineName}". Supported: postgresql, mysql, sqlite, mongodb, redis, valkey, yourengine`,
  ),
)
```

5. **Add to `listEngines()` function:**

```ts
// Filter engines
const yourengineEngines = engines.filter(
  (e): e is InstalledYourEngineEngine => e.engine === 'yourengine',
)

// Display rows (after Redis rows)
for (const engine of yourengineEngines) {
  const icon = ENGINE_ICONS.yourengine
  const platformInfo = `${engine.platform}-${engine.arch}`
  const engineDisplay = `${icon} yourengine`

  console.log(
    chalk.gray('  ') +
      chalk.cyan(padWithEmoji(engineDisplay, 13)) +
      chalk.yellow(engine.version.padEnd(12)) +
      chalk.gray(platformInfo.padEnd(18)) +
      chalk.white(formatBytes(engine.sizeBytes)),
  )
}

// Summary (after Redis summary)
if (yourengineEngines.length > 0) {
  const totalSize = yourengineEngines.reduce((acc, e) => acc + e.sizeBytes, 0)
  console.log(
    chalk.gray(
      `  YourEngine: ${yourengineEngines.length} version(s), ${formatBytes(totalSize)}`,
    ),
  )
}
```

---

## CLI Commands

### Create Command (`cli/commands/create.ts`)

Two updates are required:

**1. Update `--engine` help text:**

```ts
.option(
  '-e, --engine <engine>',
  'Database engine (postgresql, mysql, mariadb, sqlite, mongodb, redis, valkey, yourengine)',
)
```

**2. Update `detectLocationType()` for connection string inference:**

If your engine uses a connection string scheme (like `yourengine://`), add detection:

```ts
function detectLocationType(location: string): {
  type: 'connection' | 'file' | 'not_found'
  inferredEngine?: Engine
} {
  // ... existing checks ...

  // Add your engine's connection string scheme
  if (location.startsWith('yourengine://') || location.startsWith('yourengines://')) {
    return { type: 'connection', inferredEngine: Engine.YourEngine }
  }

  // ... rest of function
}
```

This enables `spindb create mydb --from yourengine://host:port/db` to auto-detect the engine.

---

## CLI Menu Handlers

### 1. Container Handlers (`cli/commands/menu/container-handlers.ts`)

If your engine uses numbered databases (like Redis 0-15) instead of named databases:

```ts
// Skip database name prompt for engines with numbered DBs
if (engine === 'redis' || engine === 'valkey' || engine === 'yourengine') {
  database = '0'
} else {
  // Prompt for database name
}
```

**For REST API engines** (like Qdrant), hide the "Run SQL file" option entirely since there's no CLI shell:

```ts
// Hide "Run SQL file" for REST API engines (they don't have CLI shells)
if (config.engine !== 'qdrant') {
  const canRunSql = isFileBasedDB ? existsSync(config.database) : isRunning
  // ... add the run-sql action choice
}
```

### 2. Shell Handlers (`cli/commands/menu/shell-handlers.ts`)

**CRITICAL:** Add your engine to avoid defaulting to PostgreSQL tools.

1. **Add to shell option selection (around line 110):**

```ts
} else if (config.engine === 'yourengine') {
  defaultShellName = 'yourengine-cli'
  engineSpecificCli = 'enhanced-cli'  // Or null if no enhanced CLI
  engineSpecificInstalled = enhancedCliInstalled
  engineSpecificValue = 'enhanced-cli'
  engineSpecificInstallValue = 'install-enhanced-cli'
}
```

2. **Update usql eligibility for non-SQL engines:**

```ts
const isNonSqlEngine = config.engine === 'redis' || config.engine === 'valkey' ||
                        config.engine === 'mongodb' || config.engine === 'yourengine'
```

3. **Add to launchShell function:**

```ts
} else if (config.engine === 'yourengine') {
  const clientPath = await configManager.getBinaryPath('yourengine-cli')
  shellCmd = clientPath || 'yourengine-cli'
  shellArgs = ['-h', '127.0.0.1', '-p', String(config.port)]
  installHint = 'spindb engines download yourengine'
}
```

4. **For engines with built-in web UIs** (like Qdrant, ClickHouse):

If your engine has a built-in web dashboard or query interface, open it in the browser instead of launching a CLI shell:

```ts
} else if (config.engine === 'yourengine') {
  // YourEngine has a built-in web UI - open in browser
  const dashboardUrl = `http://127.0.0.1:${config.port}/dashboard`
  console.log()
  console.log(uiInfo(`Opening YourEngine Dashboard in browser...`))
  console.log(chalk.gray(`  ${dashboardUrl}`))
  console.log()
  // Show API info for REST API engines
  console.log(chalk.cyan('YourEngine REST API:'))
  console.log(chalk.white(`  HTTP: http://127.0.0.1:${config.port}`))
  console.log()

  openInBrowser(dashboardUrl)
  await pressEnterToContinue()
  return
}
```

Also update the menu option to show a browser icon instead of the shell icon:

```ts
// In the choices array
{
  name: config.engine === 'yourengine'
    ? `🌐 Open Web Dashboard in browser`
    : `>_ Use default shell (${defaultShellName})`,
  value: 'default',
}
```

The `openInBrowser()` helper uses platform-specific commands (`open` on macOS, `xdg-open` on Linux, `cmd /c start` on Windows).

**Engines with built-in web UIs:**
- **Qdrant**: Dashboard at `/dashboard`
- **ClickHouse**: Play UI at `/play` (on HTTP port 8123)

### 3. SQL Handlers (`cli/commands/menu/sql-handlers.ts`)

Update terminology for non-SQL engines:

```ts
const isRedisLike = config.engine === 'redis' || config.engine === 'valkey' || config.engine === 'yourengine'
const isMongoDB = config.engine === 'mongodb'
const scriptType = isRedisLike ? 'Command' : isMongoDB ? 'Script' : 'SQL'
```

### 4. Engine Handlers (`cli/commands/menu/engine-handlers.ts`)

Add to "Manage Engines" menu:

```ts
import { type InstalledYourEngineEngine } from '../../helpers'

// Filter engines
const yourengineEngines = engines.filter(
  (e): e is InstalledYourEngineEngine => e.engine === 'yourengine',
)

// Calculate size
const totalYourEngineSize = yourengineEngines.reduce((acc, e) => acc + e.sizeBytes, 0)

// Add to sorted array
const allEnginesSorted = [
  ...pgEngines,
  ...mariadbEngines,
  ...mysqlEngines,
  ...sqliteEngines,
  ...mongodbEngines,
  ...redisEngines,
  ...valkeyEngines,
  ...yourengineEngines,
]

// Add summary display
if (yourengineEngines.length > 0) {
  console.log(chalk.gray(`  YourEngine: ${yourengineEngines.length} version(s), ${formatBytes(totalYourEngineSize)}`))
}
```

### 5. Backup Handlers (`cli/commands/menu/backup-handlers.ts`)

**CRITICAL:** Add connection string validation for your engine. The `handleRestore()` and `handleRestoreForContainer()` functions validate connection string schemes.

Add your engine to the validation switch statement in **both functions**:

```ts
validate: (input: string) => {
  if (!input) return true
  switch (config.engine) {
    // ... existing engines ...
    case 'yourengine':
      if (!input.startsWith('yourengine://') && !input.startsWith('http://') && !input.startsWith('https://')) {
        return 'Connection string must start with yourengine://, http://, or https://'
      }
      break
    default:
      // PostgreSQL and others
      if (!input.startsWith('postgresql://') && !input.startsWith('postgres://')) {
        return 'Connection string must start with postgresql:// or postgres://'
      }
  }
  return true
}
```

**Note:** REST API engines (like Qdrant) typically use `http://` or `https://` schemes, while CLI-based engines use their protocol schemes (e.g., `redis://`, `mongodb://`).

---

## Testing Requirements

### Test Fixtures

**CRITICAL:** Every engine MUST have a fixtures directory. This is a required part of adding any new engine.

Create test fixtures with the appropriate file extension. **These seed files are used by both integration tests AND Docker E2E tests.**

```
tests/fixtures/{engine}/
└── seeds/
    └── sample-db.{ext}    # Use .sql for SQL, .redis/.valkey for Redis-like, etc.
```

**Important:** The seed file must create exactly the number of records specified in `EXPECTED_COUNTS` in `run-e2e.sh`. The standard is **5 records** for SQL databases (in `test_user` table) and **6 keys** for key-value stores (5 user keys + 1 count key).

**For REST API engines** (like Qdrant), create a `README.md` instead of a seed file:
```text
tests/fixtures/{engine}/
└── seeds/
    └── README.md    # Explains the REST API approach and sample data structure
```

The README should document:
1. Why no traditional seed file exists
2. How seed data is inserted via REST API (curl commands)
3. Sample data structure (JSON format)
4. Expected data count for verification

**Note on Qdrant snapshots:** Qdrant snapshots are NOT suitable as test fixtures because even a collection with 3 points creates a ~334MB snapshot file (includes indices, segments, and WAL). Use the REST API approach for Qdrant testing.

**For SQL databases** (`sample-db.sql`):
```sql
CREATE TABLE IF NOT EXISTS test_user (
    id INT PRIMARY KEY,
    name VARCHAR(100),
    email VARCHAR(100)
);

INSERT INTO test_user (id, name, email) VALUES
    (1, 'Alice', 'alice@example.com'),
    (2, 'Bob', 'bob@example.com'),
    (3, 'Charlie', 'charlie@example.com'),
    (4, 'Diana', 'diana@example.com'),
    (5, 'Eve', 'eve@example.com');
```

**For Redis-like databases** (`sample-db.yourengine`):
```
DEL user:1 user:2 user:3 user:4 user:5 user:count
SET user:1 '{"id":1,"name":"Alice","email":"alice@example.com"}'
SET user:2 '{"id":2,"name":"Bob","email":"bob@example.com"}'
SET user:3 '{"id":3,"name":"Charlie","email":"charlie@example.com"}'
SET user:4 '{"id":4,"name":"Diana","email":"diana@example.com"}'
SET user:5 '{"id":5,"name":"Eve","email":"eve@example.com"}'
SET user:count 5
```

### Integration Test Helpers (`tests/integration/helpers.ts`)

Add your engine to all helper functions:

```ts
// 1. Add to TEST_PORTS
export const TEST_PORTS = {
  postgresql: { base: 5454, clone: 5456, renamed: 5455 },
  mysql: { base: 3333, clone: 3335, renamed: 3334 },
  // ... other engines
  yourengine: { base: 6420, clone: 6422, renamed: 6421 },
}

// 2. Add to executeSQL function
export async function executeSQL(engine: Engine, port: number, database: string, sql: string) {
  if (engine === Engine.YourEngine) {
    const engineImpl = getEngine(engine)
    const clientPath = await engineImpl.getYourEngineClientPath().catch(() => 'yourengine-cli')
    const cmd = `"${clientPath}" -h 127.0.0.1 -p ${port} -n ${database} ${sql}`
    return execAsync(cmd)
  }
  // ... existing engines
}

// 3. Add to waitForReady function
export async function waitForReady(engine: Engine, port: number, timeoutMs = 30000): Promise<boolean> {
  if (engine === Engine.YourEngine) {
    // Use PING or equivalent health check
    const engineImpl = getEngine(engine)
    const clientPath = await engineImpl.getYourEngineClientPath().catch(() => 'yourengine-cli')
    await execAsync(`"${clientPath}" -h 127.0.0.1 -p ${port} PING`)
    return true
  }
  // ... existing engines
}

// 4. Add to getConnectionString function
export function getConnectionString(engine: Engine, port: number, database: string): string {
  if (engine === Engine.YourEngine) {
    return `redis://127.0.0.1:${port}/${database}`
  }
  // ... existing engines
}

// 5. Add engine-specific helper functions
export async function getYourEngineValue(port: number, db: string, key: string): Promise<string | null> {
  // Implementation for getting values from your engine
}

export async function getYourEngineKeyCount(port: number, db: string, pattern: string): Promise<number> {
  // Implementation for counting keys
}
```

### Integration Test File

Create `tests/integration/{engine}.test.ts` with **at least 14 tests**:

```ts
import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { rm } from 'fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  waitForReady,
  containerDataExists,
  assert,
  assertEqual,
} from './helpers'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.YourEngine
const DATABASE = '0'  // Or 'testdb' for SQL databases
const SEED_FILE = join(__dirname, '../fixtures/yourengine/seeds/sample-db.yourengine')

describe('YourEngine Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string

  before(async () => {
    // Setup: cleanup, find ports, generate names
  })

  after(async () => {
    // Cleanup: stop and delete test containers
  })

  // Required tests (minimum 14):
  it('should create container without starting (--no-start)', async () => { })
  it('should start the container', async () => { })
  it('should seed the database with test data using runScript', async () => { })
  it('should clone via backup and restore to new container', async () => { })
  it('should verify cloned data matches source', async () => { })
  it('should stop and delete the cloned container', async () => { })
  it('should create text format backup', async () => { })
  it('should restore from text format backup (merge mode)', async () => { })
  it('should restore from text format backup (replace mode)', async () => { })
  it('should detect backup format from file content', async () => { })
  it('should modify data using runScript inline command', async () => { })
  it('should stop, rename container, and change port', async () => { })
  it('should verify data persists after rename', async () => { })
  it('should delete container with --force', async () => { })
})
```

### Integration Test Best Practices

**Always wait for readiness after starting/restarting containers:**

```ts
// After starting a container, always call waitForReady before proceeding
await engine.start(config)
await containerManager.updateConfig(containerName, { status: 'running' })

const ready = await waitForReady(ENGINE, port)
assert(ready, 'Container should be ready to accept connections')

// Now safe to run queries, backups, etc.
```

**Clone test pattern (backup/restore):**

The clone test stops the source container to perform the restore, then restarts both containers. **Both containers need readiness checks:**

```ts
it('should clone via backup and restore', async () => {
  // 1. Create backup from running source
  await engine.backup(sourceConfig, backupPath, options)

  // 2. Stop source for restore
  await engine.stop(sourceConfig)

  // 3. Restore to target container
  await engine.restore(targetConfig, backupPath, options)

  // 4. Start target and wait for ready
  await engine.start(targetConfig)
  const targetReady = await waitForReady(ENGINE, targetPort)
  assert(targetReady, 'Target should be ready')

  // 5. Restart source and wait for ready
  await engine.start(sourceConfig)
  const sourceReady = await waitForReady(ENGINE, sourcePort)
  assert(sourceReady, 'Source should be ready after restart')
})
```

### Unit Tests

Create unit tests for engine-specific logic:

**`tests/unit/{engine}-version-validator.test.ts`:**
```ts
import { describe, it } from 'node:test'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
} from '../../engines/yourengine/version-validator'
import { assert, assertEqual } from '../utils/assertions'

describe('YourEngine Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse standard version string', () => { })
    it('should parse version with just major.minor', () => { })
    it('should return null on invalid version', () => { })
  })

  describe('isVersionSupported', () => {
    it('should return true for supported versions', () => { })
    it('should return false for unsupported versions', () => { })
  })

  describe('compareVersions', () => {
    it('should compare versions correctly', () => { })
  })

  describe('isVersionCompatible', () => {
    it('should check backup/restore compatibility', () => { })
  })
})
```

**`tests/unit/{engine}-restore.test.ts`:**
```ts
import { describe, it, before, after } from 'node:test'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/yourengine/restore'
import { assert, assertEqual } from '../utils/assertions'

describe('YourEngine Restore', () => {
  describe('detectBackupFormat', () => {
    it('should detect binary format by magic bytes', async () => { })
    it('should detect format by extension as fallback', async () => { })
    it('should return unknown for unrecognized files', async () => { })
  })

  describe('parseConnectionString', () => {
    it('should parse connection URL', () => { })
    it('should handle password in URL', () => { })
    it('should throw for invalid URL', () => { })
  })
})
```

### Add Test Script to package.json

```json
{
  "scripts": {
    "test:yourengine": "node --import tsx --test --experimental-test-isolation=none tests/integration/yourengine.test.ts"
  }
}
```

Also add to `test:integration`:

```json
{
  "scripts": {
    "test:integration": "run-s test:pg test:mysql test:mariadb test:sqlite test:mongodb test:redis test:valkey test:yourengine"
  }
}
```

---

## GitHub Actions / CI

### Adding Integration Test Job

Add to `.github/workflows/ci.yml`:

```yaml
# ============================================
# YourEngine Integration Tests
# Uses SpinDB to download and manage YourEngine binaries from hostdb
# ============================================
test-yourengine:
  name: YourEngine (${{ matrix.os }})
  runs-on: ${{ matrix.os }}
  strategy:
    fail-fast: false
    matrix:
      os:
        - ubuntu-22.04
        - ubuntu-24.04
        - macos-15  # Intel
        - macos-14  # ARM64
        - windows-latest
  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Setup pnpm
      uses: pnpm/action-setup@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '22'
        cache: 'pnpm'

    - name: Install dependencies
      run: pnpm install --frozen-lockfile

    # Cache binaries - REQUIRED for hostdb-based engines
    - name: Cache YourEngine binaries
      uses: actions/cache@v4
      id: yourengine-cache
      with:
        path: ~/.spindb/bin
        key: spindb-yourengine-9-${{ runner.os }}-${{ runner.arch }}

    # Download binaries via SpinDB
    - name: Install YourEngine via SpinDB
      run: pnpm start engines download yourengine 9

    - name: Show installed engines
      run: pnpm start engines list

    - name: Run YourEngine integration tests
      run: pnpm test:engine yourengine
      timeout-minutes: 15
```

### Update CI Success Job

Add to `needs` and checks:

```yaml
ci-success:
  name: CI Success
  runs-on: ubuntu-latest
  needs:
    [
      unit-tests,
      test-postgresql,
      test-mariadb,
      test-mysql,
      test-sqlite,
      test-mongodb,
      test-redis,
      test-valkey,
      test-yourengine,  # Add this
      test-cli-e2e,
      # ... other jobs
    ]
  if: always()
  steps:
    - name: Check all jobs passed
      run: |
        # ... existing checks
        if [ "${{ needs.test-yourengine.result }}" != "success" ]; then
          echo "YourEngine tests failed"
          exit 1
        fi
```

### Linux ARM64 Tests (Commented Out)

There is a **commented-out** Linux ARM64 test section in `ci.yml` that will be enabled when GitHub adds free ARM64 runners. When adding a new engine, you must also add it to this section:

1. Add engine to the `matrix.test` array
2. Add a download step: `Download YourEngine`
3. Add a test step: `Run YourEngine tests`

Search for `test-linux-arm64` in `ci.yml` to find this section. Even though it's commented out, keeping it in sync ensures ARM64 testing will work when enabled.

---

## Docker Tests

**CRITICAL:** Update the Docker E2E test environment to include your engine. Run `pnpm test:docker` to verify.

The Docker E2E tests verify:
1. **Connectivity** - Basic query/command execution
2. **Data Lifecycle** - Full backup/restore verification with seed data

### File-Based vs Server-Based Engines

The Docker E2E tests handle two types of engines differently:

**Server-based engines** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse):
- Have a daemon process that runs in the background
- Require `spindb start` before running queries
- Require `spindb stop` before deletion
- Status is "running" when the process is active

**File-based engines** (SQLite, DuckDB):
- No daemon process - the database is just a file
- Do NOT call `spindb start` or `spindb stop`
- Status is "running" if the file exists (no actual process)
- The `run-e2e.sh` script has skip conditions for start/stop operations

If you're adding a file-based engine, you must update:
1. `run-e2e.sh` - Add to start/stop skip conditions
2. `cli/commands/run.ts` - Add to file-based engine check (so `spindb run` works without "not running" error)

**REST API engines** (Qdrant):
- Server-based but interact via HTTP REST API instead of CLI tools
- `spindb run` is not applicable (no CLI shell)
- Connectivity tests use `curl` to check health endpoint
- Seed data insertion uses `curl` to REST API endpoints
- Backup/restore uses snapshot endpoints via REST API

If you're adding a REST API engine, you must update:
1. `run-e2e.sh` - Add curl-based connectivity test case
2. `run-e2e.sh` - Add curl-based seed data insertion in `insert_seed_data()`
3. `run-e2e.sh` - Add curl-based data count in `get_data_count()`
4. `tests/fixtures/{engine}/seeds/README.md` - Document the REST API approach

**Example (Qdrant connectivity test in run-e2e.sh):**
```bash
qdrant)
  # Qdrant uses REST API - check health endpoint via curl
  local qdrant_port
  qdrant_port=$(spindb info "$container_name" --json 2>/dev/null | jq -r '.port' 2>/dev/null)
  if [ -n "$qdrant_port" ] && curl -sf "http://127.0.0.1:${qdrant_port}/healthz" &>/dev/null; then
    query_ok=true
  fi
  ;;
```

### Dockerfile (`tests/docker/Dockerfile`)

Add your engine to the comment listing downloaded engines:

```dockerfile
# NOT pre-installed (SpinDB downloads from hostdb automatically):
# - PostgreSQL: server + client tools (psql, pg_dump, pg_restore)
# - MySQL: server + client tools (mysql, mysqldump, mysqladmin)
# - MariaDB: server + client tools (mariadb, mariadb-dump, mariadb-admin)
# - MongoDB: server + client tools (mongod, mongosh, mongodump, mongorestore)
# - Redis: server + client tools (redis-server, redis-cli)
# - Valkey: server + client tools (valkey-server, valkey-cli)
# - ClickHouse: clickhouse (unified binary with subcommands)
# - SQLite: sqlite3, sqldiff, sqlite3_analyzer, sqlite3_rsync
# - DuckDB: duckdb
# - YourEngine: yourengine-server, yourengine-cli
```

### E2E Script (`tests/docker/run-e2e.sh`)

The E2E script tests connectivity AND a full data lifecycle (insert → backup → restore → verify). You must update several sections:

#### 1. Add Expected Count and Backup Formats

At the top of `run-e2e.sh`, add your engine to the configuration arrays:

```bash
# Expected data counts per engine (must match seed file)
declare -A EXPECTED_COUNTS
EXPECTED_COUNTS[yourengine]=5  # Number of records in your seed file

# Backup formats to test per engine (primary|secondary)
# IMPORTANT: Use engine-specific CLI format names (what --format accepts)
declare -A BACKUP_FORMATS
BACKUP_FORMATS[yourengine]="text|rdb"  # Formats separated by |
```

**Format naming rules:**

Use the engine-specific format names that `spindb backup --format` accepts:

| Engine | Format Names | Resulting Extensions |
|--------|--------------|---------------------|
| PostgreSQL | `sql`, `custom` | `.sql`, `.dump` |
| MySQL/MariaDB | `sql`, `compressed` | `.sql`, `.sql.gz` |
| MongoDB | `bson`, `archive` | (directory), `.archive` |
| Redis | `text`, `rdb` | `.redis`, `.rdb` |
| Valkey | `text`, `rdb` | `.valkey`, `.rdb` |
| ClickHouse | `sql` | `.sql` |
| SQLite | `sql`, `binary` | `.sql`, `.sqlite` |
| DuckDB | `sql`, `binary` | `.sql`, `.duckdb` |

**Important:** Use the exact format names from the table above. Generic names like `dump` are not supported - use engine-specific names like `custom` (PostgreSQL) or `compressed` (MySQL).

#### 1b. Update `get_backup_extension()` Function

The extension mapping is engine-specific. Add your engine's format-to-extension mapping:

```bash
get_backup_extension() {
  local engine=$1 format=$2
  case $engine in
    # ... existing engines ...
    yourengine)
      case $format in
        sql) echo ".sql" ;;
        dump) echo ".yourext" ;;  # Your engine's binary format extension
      esac
      ;;
  esac
}
```

#### 2. Update `insert_seed_data()` Function

Add a case for your engine to insert seed data:

```bash
# For SQL engines (need to create database first):
yourengine)
  echo "    Creating testdb database..."
  spindb run "$container_name" -c "CREATE DATABASE IF NOT EXISTS testdb;" -d postgres 2>/dev/null || true
  local seed_file="$FIXTURES_DIR/$engine/seeds/sample-db.sql"
  if [ ! -f "$seed_file" ]; then
    echo "    ERROR: Seed file not found: $seed_file"
    return 1
  fi
  if ! spindb run "$container_name" "$seed_file" -d testdb 2>&1; then
    echo "    ERROR: Failed to insert seed data"
    return 1
  fi
  ;;

# For file-based engines (no database creation needed):
yourengine)
  local seed_file="$FIXTURES_DIR/$engine/seeds/sample-db.sql"
  if [ ! -f "$seed_file" ]; then
    echo "    ERROR: Seed file not found: $seed_file"
    return 1
  fi
  if ! spindb run "$container_name" "$seed_file" 2>&1; then
    echo "    ERROR: Failed to insert seed data"
    return 1
  fi
  ;;
```

#### 3. Update `get_data_count()` Function

Add a case for your engine to count records:

```bash
# For SQL engines:
yourengine)
  spindb run "$container_name" -c "SELECT COUNT(*) FROM test_user;" -d "$database" 2>/dev/null | grep -E '^[0-9]+$' | head -1
  ;;

# For key-value engines:
yourengine)
  spindb run "$container_name" -c "DBSIZE" -d "$database" 2>/dev/null | grep -oE '[0-9]+' | head -1
  ;;
```

#### 4. Update `create_backup()` Function

Add a case for your engine's backup command:

```bash
yourengine)
  if ! spindb backup "$container_name" -d testdb -f "$format" -o "$output_file" 2>&1; then
    echo "    ERROR: Backup failed"
    return 1
  fi
  ;;
```

#### 5. Update `create_restore_target()` Function

Add a case for creating the restore target database/container:

```bash
# For SQL engines:
yourengine)
  if ! spindb run "$container_name" -c "CREATE DATABASE IF NOT EXISTS restored_db;" -d postgres 2>&1; then
    echo "    ERROR: Failed to create restore target database"
    return 1
  fi
  ;;

# For file-based engines:
yourengine)
  local restored_container="restored_${container_name}"
  local restored_path="$BACKUP_DIR/restored_${engine}.db"
  if ! spindb create "$restored_container" --engine "$engine" --path "$restored_path" --no-start 2>&1; then
    echo "    ERROR: Failed to create restore target container"
    return 1
  fi
  ;;
```

#### 6. Update `restore_backup()` Function

Add a case for your engine's restore command:

```bash
yourengine)
  if ! spindb restore "$container_name" "$backup_file" -d restored_db --force 2>&1; then
    echo "    ERROR: Restore failed"
    return 1
  fi
  ;;
```

#### 7. Update `verify_restored_data()` Function

Add a case to verify restored data:

```bash
# For SQL engines:
yourengine)
  actual_count=$(get_data_count "$engine" "$container_name" "restored_db")
  ;;

# For file-based engines:
yourengine)
  local restored_container="restored_${container_name}"
  actual_count=$(get_data_count "$engine" "$restored_container")
  ;;
```

#### 8. Update `cleanup_data_lifecycle()` Function (file-based only)

For file-based engines, add cleanup of the restored container:

```bash
yourengine)
  local restored_container="restored_${container_name}"
  spindb delete "$restored_container" --yes 2>/dev/null || true
  ;;
```

#### 9. Add Connectivity Test Case

In the `run_test()` function, add your engine to the connectivity test `case` statement:

```bash
yourengine)
  if ! spindb run "$container_name" -c "SELECT 1 as test;"; then
    echo "FAILED: Could not run YourEngine query"
    # For server-based engines, add: spindb stop "$container_name" 2>/dev/null || true
    spindb delete "$container_name" --yes 2>/dev/null || true
    record_result "$engine" "$version" "FAILED" "Query failed"
    FAILED=$((FAILED+1))
    return 1
  fi
  ;;
```

#### 10. Add Test Execution

At the bottom of the script with other engines:

```bash
# YourEngine
if should_run_test yourengine; then
  YOURENGINE_VERSION=$(get_default_version yourengine)
  [ -n "$YOURENGINE_VERSION" ] && run_test yourengine "$YOURENGINE_VERSION" || echo "Skipping YourEngine (no default version)"
fi
```

#### 11. Update Start/Stop Skip Conditions (file-based only)

For file-based engines, update the skip conditions:

```bash
# Start container (skip for sqlite/duckdb - they're file-based, no server process)
if [ "$engine" != "sqlite" ] && [ "$engine" != "duckdb" ] && [ "$engine" != "yourengine" ]; then

# Stop container (skip for sqlite/duckdb - they're embedded)
if [ "$engine" != "sqlite" ] && [ "$engine" != "duckdb" ] && [ "$engine" != "yourengine" ]; then
```

### Test Output

When you run `pnpm test:docker`, each engine should show:

```
=== Testing yourengine v9.0.1 ===
Downloading yourengine 9.0.1...
Download complete
Creating container: test_yourengine_12345
Starting container...
Waiting for container to start (timeout: 60s)...
Verifying container status...
Testing database connectivity...
Connectivity test passed ✓

--- Data Lifecycle Test ---
  Inserting seed data...
    Creating testdb database...
    ✓ Seed data inserted
  ✓ Initial data verified: 5 records

  [Testing primary format: sql]
  Creating backup (format: sql)...
    ✓ Backup created: /tmp/xxx/backup.sql (2.1K)
  Creating restore target...
    ✓ Restore target created
  Restoring backup (format: sql)...
    ✓ Backup restored
  Verifying restored data (expecting 5 records)...
    ✓ Verified: 5 records (expected 5)

  [Testing secondary format: dump]
  ...

--- Data Lifecycle Test PASSED ---
Stopping container...
Cleaning up...

✓ PASSED: yourengine v9.0.1 (connectivity + backup/restore)
```

---

## Binary Management

### Choosing a Binary Manager Base Class

SpinDB provides four base classes for binary managers. Choose the appropriate one based on your engine type:

| Base Class | Used By | When to Use |
|------------|---------|-------------|
| `BaseBinaryManager` | Redis, Valkey, Qdrant | Key-value/vector stores; handles both `bin/` and flat archive structures |
| `BaseServerBinaryManager` | PostgreSQL, MySQL, MariaDB, ClickHouse | SQL server engines with version verification (override `verify()` for custom formats) |
| `BaseDocumentBinaryManager` | MongoDB, FerretDB | Document-oriented DBs with macOS tar recovery and major.minor version matching |
| `BaseEmbeddedBinaryManager` | SQLite, DuckDB | Embedded/file-based engines with flat archives (executables at root) |

**Decision tree:**

1. **Is it a file-based/embedded database?** (no server process)
   - Yes → Use `BaseEmbeddedBinaryManager`
   - No → Continue to step 2

2. **Is it a SQL database with X.Y major versioning?** (like MySQL 8.0, MariaDB 11.8)
   - Yes → Use `BaseServerBinaryManager`
   - No → Continue to step 3

3. **Is it a document-oriented database?** (like MongoDB, FerretDB)
   - Yes → Use `BaseDocumentBinaryManager`
   - No → Continue to step 4

4. **Is it a key-value store with single-digit major versions?** (like Redis 7, Valkey 8)
   - Yes → Use `BaseBinaryManager`
   - No → Create a custom binary manager (rare)

**Customizing base classes:**

All engines use one of the four base classes. When an engine needs custom behavior:
- Override specific methods (e.g., `verify()` for custom version output parsing)
- PostgreSQL overrides `verify()` because its version output format differs from MySQL/MariaDB

**Handling platform limitations:**

If an engine doesn't support all platforms (e.g., no Windows binaries), override `extractWindowsBinaries()` to throw a clear error:

```ts
protected override async extractWindowsBinaries(): Promise<void> {
  throw new Error(
    'YourEngine binaries are not available for Windows. ' +
      'YourEngine is only supported on macOS and Linux.',
  )
}
```

See `engines/clickhouse/binary-manager.ts` for a complete example.

**Handling flat archives for server-based engines:**

Most server-based engines have archives with a `bin/` subdirectory structure (e.g., `redis/bin/redis-server`). However, some server-based engines (like Qdrant) have flat archives where executables are at the root level (e.g., `qdrant/qdrant`).

The base classes handle this automatically via `moveExtractedEntries()`:
- If the archive has a `bin/` subdirectory → preserves structure as-is
- If the archive is flat → creates a `bin/` subdirectory and moves executables there

If your server-based engine uses flat archives, `BaseBinaryManager` will work correctly. The method identifies executables by:
- Windows: Files ending in `.exe` or `.dll`
- Unix: Files without extensions that aren't config/metadata files

**Example (Qdrant uses flat archives with BaseBinaryManager):**
```ts
// Qdrant binary manager uses BaseBinaryManager despite being a server-based engine
// because its archives have a flat structure (qdrant binary at root)
class QdrantBinaryManager extends BaseBinaryManager {
  // ... flat archive is handled automatically by moveExtractedEntries()
}
```

**Example implementations:**

```ts
// For embedded databases (SQLite, DuckDB)
import { BaseEmbeddedBinaryManager } from '../../core/base-embedded-binary-manager'

class YourEmbeddedBinaryManager extends BaseEmbeddedBinaryManager {
  protected readonly config = {
    engine: Engine.YourEngine,
    engineName: 'yourengine',
    displayName: 'YourEngine',
    primaryBinary: 'yourengine',           // Main executable to check
    executableNames: ['yourengine'],        // All executables in flat archive
  }
  // Implement abstract methods...
}

// For SQL servers (MySQL, MariaDB, ClickHouse)
import { BaseServerBinaryManager } from '../../core/base-server-binary-manager'

class YourSQLServerBinaryManager extends BaseServerBinaryManager {
  protected readonly config = {
    engine: Engine.YourEngine,
    engineName: 'yourengine',
    displayName: 'YourEngine',
    serverBinaryNames: ['yourengined', 'yourengine-server'],  // Checked in order
  }
  // Implement abstract methods...
}

// For document databases (MongoDB, FerretDB)
import { BaseDocumentBinaryManager } from '../../core/base-document-binary-manager'

class YourDocumentBinaryManager extends BaseDocumentBinaryManager {
  protected readonly config = {
    engine: Engine.YourEngine,
    engineName: 'yourengine',
    displayName: 'YourEngine',
    serverBinary: 'yourengined',
  }

  protected parseVersionFromOutput(stdout: string): string | null {
    // Parse version from --version output, e.g., "db version v7.0.28"
    const match = stdout.match(/db version v(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  }
  // Implement other abstract methods...
}

// For key-value stores (Redis, Valkey)
import { BaseBinaryManager } from '../../core/base-binary-manager'

class YourKeyValueBinaryManager extends BaseBinaryManager {
  protected readonly config = {
    engine: Engine.YourEngine,
    engineName: 'yourengine',
    displayName: 'YourEngine',
    serverBinary: 'yourengine-server',
  }
  // Implement abstract methods...
}
```

### hostdb Binary Files

For engines using [hostdb](https://github.com/robertjbass/hostdb), create these files:

**`engines/{engine}/version-maps.ts`:**
```ts
/**
 * IMPORTANT: Keep this in sync with hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 */
export const YOURENGINE_VERSION_MAP: Record<string, string> = {
  '8': '8.0.6',
  '9': '9.0.1',
}

export const SUPPORTED_MAJOR_VERSIONS = Object.keys(YOURENGINE_VERSION_MAP)
export const FALLBACK_VERSION_MAP = YOURENGINE_VERSION_MAP
```

**`engines/{engine}/binary-urls.ts`:**
```ts
import { FALLBACK_VERSION_MAP } from './version-maps'
import { Platform, type Arch } from '../../types'

const HOSTDB_BASE_URL = 'https://github.com/robertjbass/hostdb/releases/download'

export function getBinaryUrl(version: string, platform: Platform, arch: Arch): string {
  const fullVersion = FALLBACK_VERSION_MAP[version] || version
  const platformKey = `${platform}-${arch}`
  const ext = platform === Platform.Win32 ? 'zip' : 'tar.gz'
  return `${HOSTDB_BASE_URL}/yourengine-${fullVersion}/yourengine-${fullVersion}-${platformKey}.${ext}`
}
```

**`engines/{engine}/hostdb-releases.ts`:**
```ts
import { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'

export async function fetchAvailableVersions(): Promise<Record<string, string[]>> {
  // Fetch from hostdb releases.json or use fallback
  // Filter by SUPPORTED_MAJOR_VERSIONS
}
```

**`engines/{engine}/binary-manager.ts`:**
```ts
// Handle download, extraction, verification
// Register binary paths with configManager after installation
```

---

## Restore Implementation

The `restore.ts` file handles backup format detection and restore operations. Follow these patterns for memory efficiency.

### Format Detection

**CRITICAL:** Format detection must only read the bytes needed for detection, never the entire file. Backup files can be gigabytes in size.

```ts
import { open } from 'fs/promises'

async function detectBackupFormat(filePath: string): Promise<BackupFormat> {
  // Read only the bytes needed for format detection
  // - Binary magic bytes: typically first 5-16 bytes
  // - Text/SQL detection: first 4-8KB is enough for several lines
  const HEADER_SIZE = 4096  // Adjust based on what you need to detect
  const buffer = Buffer.alloc(HEADER_SIZE)

  const fd = await open(filePath, 'r')
  let bytesRead: number
  try {
    const result = await fd.read(buffer, 0, HEADER_SIZE, 0)
    bytesRead = result.bytesRead
  } finally {
    await fd.close()
  }

  // For binary format detection (magic bytes)
  const header = buffer.toString('ascii', 0, 5)
  if (header === 'PGDMP') {
    return { format: 'custom', ... }
  }

  // For text format detection (checking first few lines)
  const content = buffer.toString('utf-8', 0, bytesRead)
  const lines = content.split(/\r?\n/)
  // Check lines for keywords...
}
```

**Buffer sizes by detection type:**
- Binary magic bytes only: 263 bytes (PostgreSQL uses this for PGDMP + tar magic)
- Text/command detection: 4KB (Redis, Valkey - checking first 10 lines)
- SQL statement detection: 8KB (ClickHouse - SQL statements can be longer)

### Streaming Restores

**CRITICAL:** When piping file content to CLI tools, use streams instead of `readFile()`. This prevents out-of-memory errors on large backups.

```ts
import { createReadStream } from 'fs'
import { spawn } from 'child_process'

async function restoreBackup(backupPath: string, ...): Promise<RestoreResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],  // stdin must be 'pipe' for streaming
    })

    let stdout = ''
    let stderr = ''
    let streamError: Error | null = null

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    proc.on('close', (code) => {
      if (streamError) {
        reject(streamError)
        return
      }
      if (code === 0) {
        resolve({ format: 'sql', stdout, stderr, code: 0 })
      } else {
        reject(new Error(`CLI exited with code ${code}: ${stderr}`))
      }
    })

    proc.on('error', reject)

    // Stream file to CLI stdin instead of readFile()
    const fileStream = createReadStream(backupPath, { encoding: 'utf-8' })

    fileStream.on('error', (error) => {
      streamError = new Error(`Failed to read backup file: ${error.message}`)
      fileStream.destroy()  // Clean up the stream
      proc.stdin.end()
    })

    fileStream.pipe(proc.stdin)
  })
}
```

**When streaming applies:**
- Engines that pipe SQL/commands to a CLI tool (SQLite, DuckDB, Redis, Valkey, ClickHouse)
- Engines where the CLI reads files directly (PostgreSQL `pg_restore`, MySQL `mysql`) don't need this pattern

---

## Remote Database Dump (dumpFromConnectionString)

**REQUIRED:** Every engine MUST implement `dumpFromConnectionString()` to support restoring from remote databases. This feature enables users to pull production data into local containers using `spindb restore --from-url`.

### Implementation Pattern

```ts
async dumpFromConnectionString(
  connectionString: string,
  outputPath?: string,
): Promise<string> {
  // 1. Parse the connection string to extract host, port, credentials
  const { host, port, password, database } = parseConnectionString(connectionString)

  // 2. Create a temporary file path if not provided
  const tempPath = outputPath ?? path.join(os.tmpdir(), `${engine}-${Date.now()}.${ext}`)

  // 3. Connect to remote database and dump data
  //    - For CLI-based engines: use native CLI tools with remote connection flags
  //    - For REST API engines: use fetch() to interact with the API

  // 4. Return the path to the dump file
  return tempPath
}
```

### Engine-Specific Approaches

| Engine | Approach | Connection String Format |
|--------|----------|--------------------------|
| PostgreSQL | `pg_dump` with remote host | `postgresql://user:pass@host:5432/db` |
| MySQL/MariaDB | `mysqldump` with `-h` flag | `mysql://root:pass@host:3306/db` |
| MongoDB | `mongodump` with `--uri` | `mongodb://user:pass@host:27017/db` |
| Redis/Valkey | CLI with `-h` flag + SCAN | `redis://:password@host:6379/0` |
| ClickHouse | HTTP API with remote host | `clickhouse://default:pass@host:8123/db` |
| Qdrant | REST API snapshots | `http://host:6333?api_key=KEY` |
| SQLite/DuckDB | N/A (file-based) | File path copy |

### Connection String Parsing

Create a helper function to parse the connection string:

```ts
function parseYourEngineConnectionString(connectionString: string): {
  host: string
  port: number
  password?: string
  database: string
} {
  // Handle multiple URL schemes (e.g., redis://, yourengine://)
  const url = new URL(connectionString)

  return {
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : DEFAULT_PORT,
    password: url.password || undefined,
    database: url.pathname.replace(/^\//, '') || '0',
  }
}
```

### Error Handling

- Throw descriptive errors for connection failures
- Include the remote host in error messages (but NOT the password)
- Handle authentication failures separately from connection failures

### Testing

Add unit tests for connection string parsing in `tests/unit/{engine}-restore.test.ts`:

```ts
describe('parseConnectionString', () => {
  it('should parse full connection URL', () => { })
  it('should handle missing password', () => { })
  it('should use default port when not specified', () => { })
  it('should handle URL-encoded passwords', () => { })
})
```

**Note:** Integration tests for `dumpFromConnectionString` require a remote database instance and are not run in CI. Add a TODO comment in your test file for future test coverage when a remote testing environment is available.

---

## OS Dependencies

See `config/os-dependencies.ts` for examples of how to define system package dependencies for your engine. This provides fallback installation instructions when hostdb binaries are not available.

---

## Windows Considerations

Windows has several platform-specific behaviors that must be handled correctly.

### Executable Extensions

**CRITICAL:** On Windows, executable files have the `.exe` extension. All code that constructs paths to binaries MUST use `platformService.getExecutableExtension()` to append the correct extension.

```ts
import { platformService } from '../../core/platform-service'

// CORRECT: Uses platform-specific extension
const ext = platformService.getExecutableExtension()
const serverPath = join(binPath, 'bin', `yourengine-server${ext}`)
const cliPath = join(binPath, 'bin', `yourengine-cli${ext}`)

// INCORRECT: Will fail on Windows because file doesn't exist without .exe
const serverPath = join(binPath, 'bin', 'yourengine-server')  // ❌ WRONG
```

**Where to apply this:**

1. **`verifyBinary()`** - When checking if a binary exists
2. **`getXxxServerPath()`** - When returning server binary path
3. **`getXxxCliPath()`** - When returning client binary path
4. **`ensureBinaries()`** - When registering binaries with configManager (usually already correct)
5. **`start()`** - When constructing server path from stored binaryPath (usually already correct)

**Reference:** See `engines/redis/index.ts` or `engines/valkey/index.ts` for correct implementation.

### Detached Process Spawning

Windows doesn't support Unix-style daemonize. Use detached spawn instead:

```ts
import { isWindows } from '../../core/platform-service'

const useDetachedSpawn = isWindows()

if (useDetachedSpawn) {
  const spawnOpts: SpawnOptions = {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,  // Hide console window
  }
  const proc = spawn(serverPath, [configPath], spawnOpts)
  proc.unref()  // Allow parent to exit independently
}
```

### Shell Execution

Windows uses different shell quoting. When using `execAsync()` with inline commands:

```ts
if (isWindows()) {
  const escaped = command.replace(/"/g, '\\"')
  cmd = `"${cliPath}" -h 127.0.0.1 -p ${port} ${escaped}`
} else {
  cmd = `"${cliPath}" -h 127.0.0.1 -p ${port} ${command}`
}
```

**Better approach:** Use `spawn()` with stdin piping to avoid shell quoting issues entirely:

```ts
const proc = spawn(cliPath, ['-h', '127.0.0.1', '-p', String(port)], {
  stdio: ['pipe', 'inherit', 'inherit'],
})
proc.stdin?.write(command + '\n')
proc.stdin?.end()
```

---

## Documentation Updates

### README.md

Add engine section with:
- Supported versions table
- Backup formats
- Enhanced CLI tools (if any)
- Usage examples

### CHANGELOG.md

Add to `[Unreleased]`:
```markdown
### Added
- YourEngine support (versions 8, 9)
  - Full container lifecycle (create, start, stop, delete)
  - Backup and restore (text and binary formats)
  - Clone containers via backup/restore
  - Cross-platform support (macOS, Linux, Windows)
```

### ENGINES.md

Add to:
- Supported engines table
- Engine Details section
- Backup Format Summary table
- Enhanced CLI Tools table
- Engine Emojis table

### CLAUDE.md

Update:
- Project Overview (list of supported engines)
- Engine descriptions section
- Project structure (engines directory)
- Backup & Restore Formats table
- File Structure diagram
- Test commands section
- CI Binary Caching list
- Port Management section
- Binary Sources by Engine section
- Engine Icons list

### TODO.md

Mark engine as completed in the roadmap.

---

## Pass/Fail Criteria

An engine implementation is **complete** when ALL of the following pass:

### Required Checks

1. **Lint**: `pnpm lint` passes with no errors
2. **Unit Tests**: `pnpm test:unit` passes (includes new engine tests)
3. **Integration Tests**: `pnpm test:engine {engine}` passes (14+ tests)
4. **All Integration Tests**: `pnpm test:integration` passes (no regressions)

### CI Verification

1. GitHub Actions runs on all platforms (ubuntu, macos, windows)
2. Binary caching is configured for hostdb downloads
3. CI success job includes your engine

### File Count Verification

Verify all files are created (use Valkey as reference):

```bash
# Engine files (9)
ls engines/yourengine/

# Configuration updates (check git diff)
git diff --name-only | grep -E "(types|config|cli)" | wc -l

# Test files
ls tests/integration/yourengine.test.ts
ls tests/unit/yourengine-*.test.ts
ls tests/fixtures/yourengine/seeds/

# Documentation
git diff README.md CHANGELOG.md TODO.md ENGINES.md CLAUDE.md
```

### Manual Verification

**Use the test-local.sh script** for comprehensive manual testing:

```bash
# Run all engine tests (recommended before PRs)
./scripts/test-local.sh

# Test specific engine only
./scripts/test-local.sh --engine yourengine

# Quick smoke test (PostgreSQL only)
./scripts/test-local.sh --quick

# Simulate fresh install (wipes ~/.spindb)
./scripts/test-local.sh --fresh
```

**Important:** When adding a new engine, update `scripts/test-local.sh`:

1. Add your engine version to the `ENGINE_VERSIONS` associative array at the top
2. Add your engine to `wait_for_ready()` case statement with appropriate readiness check
3. Add your engine to the query test case statement in `test_engine_lifecycle()`
4. Update the "Available engines" lists in usage messages

**Individual command testing** (alternative to test-local.sh):

```bash
# Full lifecycle test
pnpm start engines download yourengine 9
pnpm start create mytest --engine yourengine
pnpm start start mytest
pnpm start info mytest
pnpm start connect mytest
pnpm start backup mytest
pnpm start stop mytest
pnpm start clone mytest mytest-clone
pnpm start delete mytest --force
pnpm start delete mytest-clone --force

# Verify in interactive menu
pnpm start
# Check "Manage engines" shows your engine
```

---

## Reference Implementations

Use these implementations as references:

| Engine | Type | Binary Source | Key Features |
|--------|------|---------------|--------------|
| **Valkey** | Server | hostdb (all platforms) | Redis fork, newest implementation, full example |
| **Redis** | Server | hostdb (all platforms) | Key-value, numbered DBs, text + RDB backup |
| **MongoDB** | Server | hostdb (all platforms) | Document DB, JavaScript queries, BSON backup |
| **PostgreSQL** | Server | hostdb + EDB (Windows) | SQL, Windows fallback example |
| **MySQL** | Server | hostdb (all platforms) | SQL, root user, socket handling |
| **MariaDB** | Server | hostdb (all platforms) | MySQL-compatible, separate binaries |
| **ClickHouse** | Server | hostdb (macOS/Linux) | OLAP, XML configs, YY.MM versioning |
| **SQLite** | File-based | hostdb (all platforms) | Embedded, no server process |
| **DuckDB** | File-based | hostdb (all platforms) | Embedded OLAP, flat archive handling example |

**Recommended starting point:** Copy Valkey implementation and modify for your engine, as it's the most recent and complete example.
