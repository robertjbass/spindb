# New Database Engine Implementation Guide & Checklist

This comprehensive document provides both the specification for adding a new database engine to SpinDB and a step-by-step checklist to track implementation progress.

**Reference Implementation:** Use [engines/cockroachdb/](engines/cockroachdb/) as a modern example.

---

## Table of Contents

1. [Overview](#overview)
2. [Engine Types](#engine-types)
3. [Pre-Implementation Research](#pre-implementation-research)
4. [Core Engine Files](#core-engine-files)
5. [Type System Updates](#type-system-updates)
6. [Configuration Files](#configuration-files)
7. [Core Manager Updates](#core-manager-updates)
8. [CLI Updates](#cli-updates)
9. [Menu Handler Updates](#menu-handler-updates)
10. [Binary Management](#binary-management)
11. [Restore Implementation](#restore-implementation)
12. [Remote Database Dump](#remote-database-dump)
13. [Testing Requirements](#testing-requirements)
14. [CI/CD Configuration](#cicd-configuration)
15. [Docker E2E Tests](#docker-e2e-tests)
16. [Docker Export Compatibility](#docker-export-compatibility)
17. [User Management](#user-management)
18. [Documentation Updates](#documentation-updates)
19. [Common Gotchas & Edge Cases](#common-gotchas--edge-cases)
20. [Windows Considerations](#windows-considerations)
21. [Pass/Fail Criteria](#passfail-criteria)
22. [Reference Implementations](#reference-implementations)
23. [Appendix: Full Implementation Checklist](#appendix-full-implementation-checklist)

---

## Quick Reference: Files to Modify

| File | Action |
|------|--------|
| `engines/{engine}/README.md` | Create (binary structure, quirks, implementation notes) |
| `engines/{engine}/*.ts` | Create (8 files) |
| `engines/index.ts` | Add import and registration |
| `engines/base-engine.ts` | Add client path getter |
| `types/index.ts` | Add Engine enum, ALL_ENGINES, BinaryTool |
| `config/engine-defaults.ts` | Add defaults |
| `config/engines.json` | Add metadata |
| `config/backup-formats.ts` | Add formats |
| `core/dependency-manager.ts` | Add to KNOWN_BINARY_TOOLS |
| `core/config-manager.ts` | Add tools constant and mappings |
| `core/docker-exporter.ts` | Add display name, connection string, user creation |
| `cli/constants.ts` | Add icons (ASCII, Nerd, emoji) and brand colors |
| `cli/helpers.ts` | Add type, detection, ENGINE_PREFIXES |
| `cli/commands/create.ts` | Add engine case for creation options |
| `cli/commands/engines.ts` | Add download and list cases |
| `cli/commands/menu/*.ts` | Update handlers (5 files) |
| `scripts/generate/db/{engine}.ts` | Create generate script for demo data |
| `scripts/generate/db/index.ts` | Add engine to `ENGINE_DEFS` |
| `scripts/generate/missing-databases.ts` | Add engine to `SUPPORTED_ENGINES` |
| `scripts/test-engine.ts` | Add engine support |
| `tests/integration/helpers.ts` | Add helper functions |
| `tests/integration/{engine}.test.ts` | Create test file |
| `tests/integration/hostdb-sync.test.ts` | Add version map to ENGINES array |
| `tests/unit/{engine}-version-validator.test.ts` | Create version validator tests |
| `tests/unit/{engine}-restore.test.ts` | Create restore tests |
| `tests/unit/config-manager.test.ts` | Update with engine tools |
| `tests/fixtures/{engine}/seeds/*` | Create seed file |
| `tests/docker/run-e2e.sh` | Add E2E tests |
| `tests/docker/Dockerfile` | Add engine binaries and dependencies |
| `.github/workflows/ci.yml` | Add CI job |
| `core/credential-manager.ts` | Update `getDefaultUsername()` (if API key engine) |
| `cli/commands/menu/container-handlers.ts` | Add/update "Create user" visibility |
| `README.md` | Update documentation |
| `ARCHITECTURE.md` | Update architecture |
| `CLAUDE.md` | Update project docs |
| `CHANGELOG.md` | Add entry |
| `package.json` | Add keyword, bump version |

**Total: ~37 files modified or created**

---

## Overview

SpinDB supports multiple database engines through an abstract `BaseEngine` class. Each engine must implement all abstract methods and integrate with the existing CLI infrastructure.

**Key Principles:**

1. **CLI-First**: All functionality must be available via command-line arguments
2. **Wrapper Pattern**: Functions wrap CLI tools (psql, mysql, mongosh, redis-cli) rather than implementing database logic
3. **Cross-Platform**: Must work on macOS, Linux, and Windows
4. **Transactional**: Multi-step operations must be atomic with rollback support
5. **CI-Verified**: All engines MUST have CI integration tests that pass on all supported platforms before merge

---

## Engine Types

SpinDB supports three types of database engines:

### Server-Based Databases (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB)

- Data stored in `~/.spindb/containers/{engine}/{name}/`
- Require start/stop lifecycle management
- Use port allocation and process management
- Have log files and PID tracking

**Sub-types:**
- **CLI-based servers** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse): Interact via CLI tools (psql, mysql, redis-cli, etc.)
- **REST API servers** (Qdrant, Meilisearch, CouchDB): Interact via HTTP REST API instead of CLI tools. These require special handling in tests and CLI commands since `spindb run` doesn't apply.

### File-Based Databases (SQLite, DuckDB)

- Data stored in user project directories (CWD)
- No start/stop required (embedded)
- No port management needed (`port: 0`)
- Connection string is the file path
- Use a registry to track file locations
- Status is `running` when file exists, `stopped` when missing

**Edge cases for file-based engines:**

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

### Composite Engines (FerretDB)

Composite engines require **multiple binaries** working together:

- **FerretDB** requires `ferretdb` (proxy) + `postgresql-documentdb` (backend)
- Each container manages two processes (FerretDB + embedded PostgreSQL)
- Three ports: external MongoDB (27017), internal PostgreSQL (54320+), debug HTTP (37017+)
- Backup uses PostgreSQL native tools (pg_dump) on embedded backend

**Platform support:** FerretDB v2 with DocumentDB extension is available on all platforms (macOS, Linux, Windows).

**hostdb postgresql-documentdb bundle:**

The `postgresql-documentdb` binary from hostdb is a self-contained PostgreSQL 17 installation that includes:
- PostgreSQL server and all client tools (psql, pg_dump, pg_restore, etc.)
- DocumentDB extension (provides MongoDB-compatible storage layer)
- PostGIS extension (built from source for relocatability)
- pgvector extension
- All required shared libraries bundled (OpenSSL, ICU, GEOS, PROJ, etc.)

**Why a custom build?** Standard Homebrew PostgreSQL has hardcoded absolute paths that break when copied to another machine. The hostdb build:
1. Compiles PostgreSQL from source with relative library paths
2. Builds PostGIS from source (Homebrew PostGIS also has hardcoded paths)
3. Bundles all Homebrew dependencies recursively
4. Rewrites dylib paths using `install_name_tool` with `@loader_path`
5. Re-signs all binaries with ad-hoc signatures (macOS requires this after modification)

See [plans/FERRETDB.md](plans/FERRETDB.md) for complete implementation guide.

---

## Pre-Implementation Research

Before writing code, gather this information:

- [ ] **Engine type**: Server-based, file-based, REST API, or composite?
- [ ] **Default port**: What port does it use? (e.g., PostgreSQL: 5432, CockroachDB: 26257)
- [ ] **Secondary ports**: Does it use additional ports? (e.g., HTTP admin UI, gRPC)
- [ ] **Connection scheme**: What URL scheme? (e.g., `postgresql://`, `redis://`, `http://`)
- [ ] **Default user/database**: What are the defaults? (e.g., CockroachDB: `root`/`defaultdb`)
- [ ] **CLI tools**: What binaries does it provide? (e.g., `cockroach`, `psql`, `redis-cli`)
- [ ] **Version format**: Standard semver or custom? (e.g., ClickHouse uses YY.MM)
- [ ] **Backup methods**: What backup formats are supported?
- [ ] **hostdb availability**: Check [hostdb releases](https://github.com/robertjbass/hostdb/releases) for binary availability
- [ ] **Platform support**: Which platforms have binaries? (macOS ARM/Intel, Linux x64/ARM, Windows)

---

## Core Engine Files

Create directory `engines/{engine}/` with these files:

### Required Files (9)

- [ ] `README.md` - Engine documentation (binary structure, quirks, gotchas)
  - [ ] Document platform support table
  - [ ] Document binary packaging (archive format, directory structure)
  - [ ] Document implementation details (version format, configuration)
  - [ ] Document known issues & gotchas
  - [ ] Document CI/CD considerations
  - See existing READMEs in `engines/*/README.md` for structure template

- [ ] `index.ts` - Main engine class extending `BaseEngine`
  - [ ] Set `name`, `displayName`, `defaultPort`, `supportedVersions` properties
  - [ ] Implement all abstract methods from `BaseEngine`
  - [ ] Export singleton instance: `export const {engine}Engine = new {Engine}Engine()`

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

  // User management (optional - override if engine supports users)
  async createUser(container: ContainerConfig, options: CreateUserOptions): Promise<UserCredentials>

  // Engine-specific client path (add to base-engine.ts too)
  async getYourEngineClientPath(): Promise<string>
}

export const yourEngine = new YourEngine()
```

- [ ] `backup.ts` - Backup creation wrapper
  - [ ] Implement backup function using engine's CLI tools
  - [ ] Support all backup formats defined in `config/backup-formats.ts`

- [ ] `restore.ts` - Backup detection and restore logic
  - [ ] Implement `detectBackupFormat()` - read only minimal bytes (not entire file!)
  - [ ] Implement restore function with streaming (not `readFile()`)
  - [ ] Implement `parseConnectionString()` for remote dump support

- [ ] `version-validator.ts` - Version parsing and compatibility
  - [ ] `parseVersion()` - parse version strings
  - [ ] `isVersionSupported()` - check against supported versions
  - [ ] `getMajorVersion()` - extract major version
  - [ ] `compareVersions()` - compare two versions

- [ ] `version-maps.ts` - Major version to full version mapping
  - [ ] Must match [hostdb releases.json](https://github.com/robertjbass/hostdb/blob/main/releases.json) exactly
  - [ ] Export `{ENGINE}_VERSION_MAP`, `SUPPORTED_MAJOR_VERSIONS`, `FALLBACK_VERSION_MAP`

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

- [ ] `binary-urls.ts` - hostdb download URL construction
  - [ ] `getBinaryUrl(version, platform, arch)` function

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

- [ ] `binary-manager.ts` - Download, extraction, verification
  - [ ] Choose correct base class (see [Binary Management](#binary-management) section)
  - [ ] Implement `verify()` if engine has custom version output format
  - [ ] Handle platform-specific extraction (Windows .zip vs .tar.gz)

- [ ] `hostdb-releases.ts` - Fetch versions from releases.json
  - [ ] `fetchAvailableVersions()` with fallback to version-maps.ts

```ts
import { SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './version-maps'

export async function fetchAvailableVersions(): Promise<Record<string, string[]>> {
  // Fetch from hostdb releases.json or use fallback
  // Filter by SUPPORTED_MAJOR_VERSIONS
}
```

### Optional Files

- [ ] `cli-utils.ts` - Shared CLI utilities (if needed)

---

## Type System Updates

### types/index.ts

- [ ] Add to `Engine` enum:
  ```ts
  {Engine} = '{engine}',
  ```

- [ ] Add to `ALL_ENGINES` array:
  ```ts
  Engine.{Engine},
  ```

- [ ] Add binary tools to `BinaryTool` type:
  ```ts
  | '{engine}'  // or '{engine}-server', '{engine}-cli', etc.
  ```

- [ ] Add backup format type if engine has unique formats:
  ```ts
  export type {Engine}Format = 'sql' | 'custom'  // adjust as needed
  ```

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

---

## Configuration Files

### config/engine-defaults.ts

- [ ] Add engine defaults (see `EngineDefaults` type for required fields):

```ts
{engine}: {
  defaultVersion: '25',
  defaultPort: 26257,
  portRange: { start: 26257, end: 26357 },
  latestVersion: '25',
  superuser: 'root',
  connectionScheme: 'postgresql',  // or engine-specific scheme
  logFileName: '{engine}.log',
  pidFileName: '{engine}.pid',
  dataSubdir: 'data',
  clientTools: ['{engine}'],
  maxConnections: 0,  // 0 if not applicable
},
```

Note: `supportedVersions` belongs in `config/engines.json`, not here.

### config/engines.json

- [ ] Add engine entry with all required fields:
  - `displayName`, `icon`, `status`, `binarySource`
  - `supportedVersions`, `defaultVersion`, `defaultPort`
  - `runtime`, `queryLanguage`, `connectionScheme`
  - `superuser`, `clientTools`, `licensing`, `notes`

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

### config/backup-formats.ts

- [ ] Add backup format configuration:

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
| Qdrant | `snapshot` | _(none)_ | `snapshot` |
| Meilisearch | `snapshot` | _(none)_ | `snapshot` |
| CouchDB | `json` | _(none)_ | `json` |

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

### config/os-dependencies.ts (if applicable)

- [ ] Add system package fallback dependencies

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

---

## Core Manager Updates

### core/dependency-manager.ts

- [ ] Add binary tools to `KNOWN_BINARY_TOOLS` array:

```ts
'{engine}',  // or individual tools like '{engine}-server', '{engine}-cli'
```

**Critical:** Without this, `findBinary()` cannot find your tools!

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

### core/config-manager.ts

- [ ] Add tools constant:
  ```ts
  const {ENGINE}_TOOLS: BinaryTool[] = ['{engine}-server', '{engine}-cli']
  ```

- [ ] Add to `ALL_TOOLS` array:
  ```ts
  ...{ENGINE}_TOOLS,
  ```

- [ ] Add to `ENGINE_BINARY_MAP`:
  ```ts
  [Engine.{Engine}]: {ENGINE}_TOOLS,
  ```

- [ ] Add to `initialize()` return type and implementation

- [ ] Export the tools constant

**Full example:**

```ts
const YOURENGINE_TOOLS: BinaryTool[] = ['yourengine-server', 'yourengine-cli']

const ALL_TOOLS: BinaryTool[] = [
  // ... existing tools
  ...REDIS_TOOLS,
  ...VALKEY_TOOLS,
  ...YOURENGINE_TOOLS,  // Add your engine
  ...SQLITE_TOOLS,
  ...ENHANCED_SHELLS,
]

const ENGINE_BINARY_MAP: Partial<Record<Engine, BinaryTool[]>> = {
  // ... existing engines
  [Engine.Redis]: REDIS_TOOLS,
  [Engine.Valkey]: VALKEY_TOOLS,
  [Engine.YourEngine]: YOURENGINE_TOOLS,  // Add your engine
}

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

export {
  // ... existing exports
  VALKEY_TOOLS,
  YOURENGINE_TOOLS,  // Add your engine
  // ...
}
```

### engines/index.ts

- [ ] Import engine:
  ```ts
  import { {engine}Engine } from './{engine}'
  ```

- [ ] Add to engines record:
  ```ts
  {engine}: {engine}Engine,
  ```

- [ ] Add aliases if applicable:
  ```ts
  alias: {engine}Engine,  // e.g., 'crdb' for 'cockroachdb'
  ```

```ts
import { yourEngine } from './yourengine'

export const engines: Record<string, BaseEngine> = {
  // ... existing engines
  yourengine: yourEngine,
  alias: yourEngine,  // Optional alias (e.g., 'mongo' for 'mongodb')
}
```

### engines/base-engine.ts

- [ ] Add client path getter if engine has CLI tool:

```ts
async get{Engine}Path(_version?: string): Promise<string> {
  throw new Error('{engine} not found')
}
```

**Note:** `createUser()` already has a default implementation in `BaseEngine` that throws `UnsupportedOperationError`. You do NOT need to modify `base-engine.ts` for user management — just override `createUser()` in your engine's `index.ts` if the engine supports users. See [User Management](#user-management) for details.

---

## CLI Updates

### cli/constants.ts

Add entries to all four icon-related records:

- [ ] Add ASCII icon (default mode):
  ```ts
  [Engine.{Engine}]: '[XX]',  // 2-4 uppercase letters
  ```

- [ ] Add Nerd Font icon:
  ```ts
  [Engine.{Engine}]: '\uf000',  // Find glyph at nerdfonts.com/cheat-sheet
  ```

- [ ] Add emoji icon:
  ```ts
  [Engine.{Engine}]: '🔶',  // Choose appropriate emoji
  ```

- [ ] Add brand colors for ASCII mode:
  ```ts
  [Engine.{Engine}]: { foreground: '#FFFFFF', background: '#000000' },  // Use official brand colors
  ```

- [ ] If emoji renders narrow in certain terminals, add to `NARROW_EMOJIS` map

**Full examples:**

```ts
// ASCII Icons (default mode) - Short text badges that work in any terminal
const ASCII_ICONS: Record<Engine, string> = {
  // ... existing icons
  [Engine.YourEngine]: '[YE]',  // 2-4 uppercase letters
}

// Nerd Font Icons - Glyphs from Nerd Fonts for users with patched fonts
const NERD_ICONS: Record<Engine, string> = {
  // ... existing icons
  [Engine.YourEngine]: '\uf000',  // Find appropriate glyph at nerdfonts.com/cheat-sheet
}

// Emoji Icons - Original emoji icons (inconsistent width across terminals)
const EMOJI_ICONS: Record<Engine, string> = {
  // ... existing icons
  [Engine.YourEngine]: '🔶',  // Choose appropriate emoji
}

// Brand Colors for ASCII mode badges
export const ENGINE_BRAND_COLORS: Record<Engine, BrandColor> = {
  // ... existing colors
  [Engine.YourEngine]: { foreground: '#FFFFFF', background: '#FF6600' },  // Use official brand colors
}

// Narrow emojis - add if your emoji renders narrow (1 cell instead of 2)
const NARROW_EMOJIS: Partial<Record<Terminal, Set<string>>> = {
  [Terminal.VSCode]: new Set(['🪶', '🦭', '🪳', '🛋', '⏱']),  // Add yours if narrow
  [Terminal.Ghostty]: new Set(['🛋', '⏱']),
}
```

**Tips:**
- Avoid emojis with variation selectors (e.g., `🛋️` → use `🛋` instead) - they cause inconsistent rendering
- Find official brand colors from the database's website or brand guidelines
- **Always use `getEngineIcon(engine)`** to get properly formatted icons - never use raw icons directly

**Verification:**
After adding icons, test in multiple terminals:
1. Run `spindb` and check "Create new container" menu alignment
2. Test with `SPINDB_ICONS=emoji pnpm start` to verify emoji mode
3. Test with `SPINDB_ICONS=nerd pnpm start` if you have Nerd Fonts installed

### cli/helpers.ts

- [ ] Add `Installed{Engine}Engine` type

- [ ] Add `getInstalled{Engine}Engines()` detection function

- [ ] Add engine prefix to `ENGINE_PREFIXES` array:
  ```ts
  '{engine}-',
  ```
  **Critical:** Without this, `hasAnyInstalledEngines()` won't detect your engine!

- [ ] Update `InstalledEngine` union type to include your type

- [ ] Update `getInstalledEngines()` to call your detection function

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

const ENGINE_PREFIXES = [
  'postgresql-',
  'mysql-',
  'mariadb-',
  // ... existing prefixes
  'yourengine-',  // Add your engine prefix
] as const
```

### cli/commands/create.ts

- [ ] Update `--engine` option help text to include new engine

- [ ] Add to `detectLocationType()` for connection string inference (if applicable)

```ts
.option(
  '-e, --engine <engine>',
  'Database engine (postgresql, mysql, mariadb, sqlite, mongodb, redis, valkey, yourengine)',
)

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

### cli/commands/engines.ts

- [ ] Import binary manager

- [ ] Add download case in the download subcommand

- [ ] Update error message to include engine

- [ ] Add to `listEngines()` display

```ts
import { yourengineBinaryManager } from '../../engines/yourengine/binary-manager'
import {
  // ... existing imports
  type InstalledYourEngineEngine,
} from '../helpers'

// Add case in download subcommand (after Redis case):
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

// Update error message:
console.error(
  uiError(
    `Unknown engine "${engineName}". Supported: postgresql, mysql, sqlite, mongodb, redis, valkey, yourengine`,
  ),
)

// Add to listEngines():
const yourengineEngines = engines.filter(
  (e): e is InstalledYourEngineEngine => e.engine === 'yourengine',
)

for (const engine of yourengineEngines) {
  const platformInfo = `${engine.platform}-${engine.arch}`
  const engineDisplay = `${getEngineIcon('yourengine')}yourengine`

  console.log(
    chalk.gray('  ') +
      chalk.cyan(engineDisplay.padEnd(14)) +
      chalk.yellow(engine.version.padEnd(12)) +
      chalk.gray(platformInfo.padEnd(18)) +
      chalk.white(formatBytes(engine.sizeBytes)),
  )
}

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

## Menu Handler Updates

### cli/commands/menu/container-handlers.ts

- [ ] Skip database name prompt if engine uses numbered DBs (like Redis 0-15)
- [ ] "Run file" menu label comes from `scriptFileLabel` in `engines.json` (set to `null` for REST API engines to hide the option). No code changes needed in `container-handlers.ts`
- [ ] "Create user" menu item visibility (see below)

```ts
// Skip database name prompt for engines with numbered DBs
if (engine === 'redis' || engine === 'valkey' || engine === 'yourengine') {
  database = '0'
} else {
  // Prompt for database name
}

// "Run file" menu label comes directly from engines.json scriptFileLabel field:
//   "Run SQL file", "Run script file", "Run command file", "Run TypeQL file", etc.
//   null → hidden (REST API engines with no CLI shell)
// No code changes needed - just set scriptFileLabel in engines.json
```

**"Create user" menu item:**

The "Create user" option is shown in the Data Operations section of the container submenu. It is hidden for engines that don't support user creation (file-based engines and QuestDB). If your engine supports `createUser()`, ensure it is NOT in the exclusion list:

```ts
// Engines that don't support createUser - hide the menu item
const ENGINES_WITHOUT_USERS = [
  Engine.SQLite,
  Engine.DuckDB,
  Engine.QuestDB,
]

if (!ENGINES_WITHOUT_USERS.includes(config.engine)) {
  // Show "Create user" option (disabled when container is not running)
}
```

If your engine does NOT support users (throws `UnsupportedOperationError`), add it to this exclusion list.

**Important:** Always use the `Engine` enum (e.g., `Engine.Qdrant`) instead of string literals (e.g., `'qdrant'`) for type safety.

### cli/commands/menu/shell-handlers.ts

- [ ] Add shell option selection for your engine
- [ ] Add to `isNonSqlEngine` check if applicable
- [ ] Add `launchShell()` case for your engine
- [ ] For REST API engines: open web dashboard instead of CLI shell

```ts
// Add to shell option selection (around line 110):
} else if (config.engine === 'yourengine') {
  defaultShellName = 'yourengine-cli'
  engineSpecificCli = 'enhanced-cli'  // Or null if no enhanced CLI
  engineSpecificInstalled = enhancedCliInstalled
  engineSpecificValue = 'enhanced-cli'
  engineSpecificInstallValue = 'install-enhanced-cli'
}

// Update usql eligibility for non-SQL engines:
const isNonSqlEngine = config.engine === 'redis' || config.engine === 'valkey' ||
                        config.engine === 'mongodb' || config.engine === 'yourengine'

// Add to launchShell function:
} else if (config.engine === 'yourengine') {
  const clientPath = await configManager.getBinaryPath('yourengine-cli')
  shellCmd = clientPath || 'yourengine-cli'
  shellArgs = ['-h', '127.0.0.1', '-p', String(config.port)]
  installHint = 'spindb engines download yourengine'
}

// For engines with built-in web UIs (like Qdrant, ClickHouse):
} else if (config.engine === 'yourengine') {
  // YourEngine has a built-in web UI - open in browser
  const dashboardUrl = `http://127.0.0.1:${config.port}/dashboard`
  console.log()
  console.log(uiInfo(`Opening YourEngine Dashboard in browser...`))
  console.log(chalk.gray(`  ${dashboardUrl}`))
  console.log()
  console.log(chalk.cyan('YourEngine REST API:'))
  console.log(chalk.white(`  HTTP: http://127.0.0.1:${config.port}`))
  console.log()

  openInBrowser(dashboardUrl)
  await pressEnterToContinue()
  return
}
```

**Engines with built-in web UIs:**
- **Qdrant**: Dashboard at `/dashboard`
- **ClickHouse**: Play UI at `/play` (on HTTP port 8123)
- **Meilisearch**: Dashboard at `/`
- **CouchDB**: Fauxton at `/_utils`

The `openInBrowser()` helper uses platform-specific commands (`open` on macOS, `xdg-open` on Linux, `cmd /c start` on Windows).

### cli/commands/menu/sql-handlers.ts

- [ ] Add engine to `getScriptType()` function:
  - SQL engines → `'SQL'`
  - Document/search engines → `'Script'`
  - Key-value engines → `'Command'`

**Script type categories:**

| Category | Engines | Terminology | File Types |
|----------|---------|-------------|------------|
| **SQL** | PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, ClickHouse | "SQL file" | `.sql` |
| **Script** | MongoDB, FerretDB (JavaScript), Qdrant, Meilisearch, CouchDB (REST/JSON) | "Script file" | `.js`, `.json` |
| **Command** | Redis, Valkey | "Command file" | `.redis`, `.valkey` |

```ts
const getScriptType = (
  engine: Engine | string,
): { type: string; lower: string } => {
  switch (engine) {
    // Redis-like engines use "Command" terminology
    case Engine.Redis:
    case Engine.Valkey:
      return { type: 'Command', lower: 'command' }

    // Document/search engines use "Script" terminology
    case Engine.MongoDB:
    case Engine.FerretDB:
    case Engine.Qdrant:
    case Engine.Meilisearch:
      return { type: 'Script', lower: 'script' }

    // SQL engines use "SQL" terminology
    case Engine.PostgreSQL:
    case Engine.MySQL:
    case Engine.MariaDB:
    case Engine.SQLite:
    case Engine.DuckDB:
    case Engine.ClickHouse:
      return { type: 'SQL', lower: 'sql' }

    default:
      return { type: 'SQL', lower: 'sql' }
  }
}
```

### cli/commands/menu/backup-handlers.ts

- [ ] Add connection string validation in `handleRestore()`
- [ ] Add connection string validation in `handleRestoreForContainer()`

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

### cli/commands/menu/engine-handlers.ts

- [ ] Add type import for your installed engine type
- [ ] Add to `allEnginesSorted` array for "Manage engines" menu

```ts
import {
  getInstalledEngines,
  type InstalledPostgresEngine,
  // ... other existing types ...
  type InstalledYourEngineEngine,  // Add your engine type
} from '../../helpers'

const allEnginesSorted = [
  ...engines.filter((e): e is InstalledPostgresEngine => e.engine === 'postgresql'),
  ...engines.filter((e): e is InstalledMariadbEngine => e.engine === 'mariadb'),
  // ... other existing engines ...
  ...engines.filter((e): e is InstalledYourEngineEngine => e.engine === 'yourengine'),
]
```

**Important:** If you skip this step, your engine will not appear in the interactive "Manage engines" menu even though it shows up in `spindb engines list`.

---

## Binary Management

### Choosing a Binary Manager Base Class

SpinDB provides four base classes for binary managers. Choose the appropriate one based on your engine type:

| Base Class | Location | Used By | Use Case |
|------------|----------|---------|----------|
| `BaseBinaryManager` | `core/base-binary-manager.ts` | Redis, Valkey, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB | Key-value/vector/search/document/time-series stores with `bin/` layout |
| `BaseServerBinaryManager` | `core/base-server-binary-manager.ts` | PostgreSQL, MySQL, MariaDB, ClickHouse | SQL servers needing version verification |
| `BaseDocumentBinaryManager` | `core/base-document-binary-manager.ts` | MongoDB, FerretDB | Document DBs with macOS tar recovery |
| `BaseEmbeddedBinaryManager` | `core/base-embedded-binary-manager.ts` | SQLite, DuckDB | File-based DBs with flat archive layout |

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

### Example Implementations

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

### JRE / Shell Script Engines (QuestDB Pattern)

Some engines (like QuestDB) are Java-based and use shell scripts to launch the JVM. These require special PID handling because the shell script forks and exits immediately.

**The Problem:**
1. You spawn `questdb.sh start` with `detached: true`
2. The shell script starts Java and exits
3. `proc.pid` contains the shell's PID, which is now invalid
4. The engine may not create its own PID file
5. `processManager.isRunning()` checks the (invalid) PID and returns `false`
6. But the Java process IS running - queries work fine

**The Solution:**

Don't write the PID immediately after spawn. Instead:

```typescript
async start(container: ContainerConfig): Promise<StartResult> {
  // ... spawn the process ...
  const proc = spawn(shellScript, args, spawnOptions)

  // DON'T write proc.pid - it's the shell's PID which will be invalid
  proc.unref()

  // Wait for the server to be ready
  const ready = await this.waitForReady(port, timeout)
  if (!ready) {
    throw new Error('Failed to start within timeout')
  }

  // AFTER server is ready, find the actual process by port
  try {
    const pids = await platformService.findProcessByPort(port)
    if (pids.length > 0) {
      await writeFile(pidFile, pids[0].toString(), 'utf-8')
    }
  } catch {
    // Log but don't fail - server is running, we just can't track PID
  }

  return { port, connectionString: this.getConnectionString(container) }
}
```

**Multi-Port Configuration:**

JRE engines often use multiple ports. Each must be uniquely configured:

```typescript
// QuestDB uses 4 ports - all must be unique per container
const env = {
  ...process.env,
  QDB_PG_NET_BIND_TO: `0.0.0.0:${port}`,           // PostgreSQL wire (main)
  QDB_HTTP_BIND_TO: `0.0.0.0:${port + 188}`,       // Web Console
  QDB_HTTP_MIN_NET_BIND_TO: `0.0.0.0:${port + 191}`, // Health/Metrics
  QDB_LINE_TCP_NET_BIND_TO: `0.0.0.0:${port + 197}`, // ILP (InfluxDB)
}
```

**Stop Method:**

Also use port-based lookup for stop:

```typescript
async stop(container: ContainerConfig): Promise<void> {
  // Find by port first (most reliable for JRE engines)
  let pid: number | null = null
  try {
    const pids = await platformService.findProcessByPort(port)
    if (pids.length > 0) pid = pids[0]
  } catch {
    // Fall back to PID file
    const pidStr = await readFile(pidFile, 'utf-8').catch(() => null)
    if (pidStr) pid = parseInt(pidStr.trim(), 10)
  }

  if (pid && platformService.isProcessRunning(pid)) {
    await platformService.terminateProcess(pid, false)
    // ... graceful shutdown logic ...
  }
}
```

**Cross-Engine Dependencies:**

QuestDB uses PostgreSQL wire protocol for backup/restore and shell access. It requires the PostgreSQL engine's `psql` binary:
- Backup: Uses `psql` to query table schemas and export data
- Restore: Uses `psql` to execute SQL dump files
- Shell: Uses `psql` (or `pgcli`) for interactive access

SpinDB warns users when deleting PostgreSQL if QuestDB containers exist.

See `engines/questdb/index.ts` for the complete reference implementation.

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

## Remote Database Dump

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

---

## Testing Requirements

### Test Fixtures

**CRITICAL:** Every engine MUST have a fixtures directory. This is a required part of adding any new engine.

- [ ] Create `tests/fixtures/{engine}/seeds/` directory
- [ ] Create seed file:
  - SQL engines: `sample-db.sql` with 5 test_user records
  - Key-value engines: `sample-db.{ext}` with 6 keys
  - REST API engines: `README.md` documenting the API approach

**Important:** The seed file must create exactly the number of records specified in `EXPECTED_COUNTS` in `run-e2e.sh`. The standard is **5 records** for SQL databases (in `test_user` table) and **6 keys** for key-value stores (5 user keys + 1 count key).

**For REST API engines** (like Qdrant), create a `README.md` instead of a seed file. The README should document:
1. Why no traditional seed file exists
2. How seed data is inserted via REST API (curl commands)
3. Sample data structure (JSON format)
4. Expected data count for verification

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

### tests/integration/helpers.ts

- [ ] Add to `TEST_PORTS`:
  ```ts
  {engine}: { base: XXXXX, clone: XXXXX, renamed: XXXXX },
  ```
  Use ports that won't conflict with other engines!

- [ ] Add to `executeSQL()` function

- [ ] Add to `waitForReady()` function

- [ ] Add to `getConnectionString()` function

- [ ] Add engine-specific helper functions (e.g., `getRowCount()`)

- [ ] Add to `runScriptFile()` function

- [ ] Add to `runScriptSQL()` function

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

### tests/integration/{engine}.test.ts

- [ ] Create integration test file with minimum 15 tests:
  - [ ] should create container without starting (--no-start)
  - [ ] should start the container
  - [ ] should seed the database with test data using runScript
  - [ ] should clone via backup and restore to new container
  - [ ] should verify cloned data matches source
  - [ ] should stop and delete the cloned container
  - [ ] should modify data using runScript inline command
  - [ ] should create a user and update password on re-create (if engine supports users)
  - [ ] should stop, rename container, and change port
  - [ ] should verify data persists after rename
  - [ ] should handle port conflict gracefully
  - [ ] should show warning when starting already running container
  - [ ] should handle stopping already stopped container gracefully
  - [ ] should delete container with --force
  - [ ] should have no test containers remaining

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

  // Required tests (minimum 15):
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
  it('should create a user and update password on re-create', async () => { })
  it('should stop, rename container, and change port', async () => { })
  it('should verify data persists after rename', async () => { })
  it('should delete container with --force', async () => { })
})
```

### tests/integration/hostdb-sync.test.ts

- [ ] Import the engine's version map (e.g., `YOURENGINE_VERSION_MAP`)
- [ ] Add entry to the `ENGINES` array with the hostdb engine name and version map

The `ENGINES` array maps hostdb engine names to SpinDB version maps. The test verifies that every version in the version map exists in hostdb's `releases.json`, and warns if hostdb has engines not covered by SpinDB.

```ts
// Add import
import { YOURENGINE_VERSION_MAP } from '../../engines/yourengine/version-maps'

// Add to ENGINES array
const ENGINES = [
  // ... existing engines ...
  { name: 'yourengine', map: YOURENGINE_VERSION_MAP },
] as const
```

> **Note:** For composite engines like FerretDB, add entries for each hostdb binary. FerretDB adds both `ferretdb` (with `FERRETDB_VERSION_MAP`) and `postgresql-documentdb` (with `DOCUMENTDB_VERSION_MAP`).

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

- [ ] Create `tests/unit/{engine}-version-validator.test.ts`
- [ ] Create `tests/unit/{engine}-restore.test.ts`
- [ ] Update `tests/unit/config-manager.test.ts` with engine tools

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

### scripts/generate/db/{engine}.ts

Create a generate script that creates a demo container and seeds it with sample data.

- [ ] Create `scripts/generate/db/{engine}.ts` following the pattern of existing engines (e.g., `postgresql.ts`, `redis.ts`)
  - Import shared helpers from `_shared.ts`
  - Create/start container, seed with sample data, verify data was inserted
  - Support `--port` flag for custom port assignment

- [ ] Add engine to `ENGINE_DEFS` in `scripts/generate/db/index.ts`:
  ```ts
  { engine: '{engine}', aliases: ['alias1', 'alias2'] },
  ```

- [ ] Add engine to `SUPPORTED_ENGINES` in `scripts/generate/missing-databases.ts`:
  ```ts
  const SUPPORTED_ENGINES = [
    // ...existing engines...
    '{engine}',
  ] as const
  ```

### scripts/test-engine.ts

- [ ] Add to `ENGINE_TEST_FILES`:
  ```ts
  {engine}: '{engine}.test.ts',
  ```

- [ ] Add to `ENGINE_ALIASES`:
  ```ts
  alias: '{engine}',  // e.g., 'crdb': 'cockroachdb'
  ```

- [ ] Add to `TEST_ORDER` array

- [ ] Update help text to include engine and aliases

---

## CI/CD Configuration

### .github/workflows/ci.yml

- [ ] Add binary cache step:
  ```yaml
  - name: Cache {Engine} binaries
    uses: actions/cache@v4
    with:
      path: ~/.spindb/bin
      key: spindb-{engine}-{version}-${{ runner.os }}-${{ runner.arch }}
  ```

- [ ] Add integration test job `test-{engine}` with platform matrix (see TESTING_STRATEGY.md for tier):
  - ubuntu-22.04 (linux-x64, older glibc — Tier A only)
  - ubuntu-24.04 (linux-x64)
  - macos-15-intel (darwin-x64 — Tier A only)
  - macos-14 (darwin-arm64)
  - windows-latest (win32-x64, if supported)

- [ ] Add download step: `pnpm start engines download {engine} {version}`

- [ ] Add test step: `pnpm test:engine {engine}`

- [ ] Add failure debug step to show logs

- [ ] Add `test-{engine}` to `ci-success` job `needs` array

- [ ] Add result check in `ci-success` job script:
  ```bash
  if [ "${{ needs.test-{engine}.result }}" != "success" ]; then
    echo "{Engine} tests failed"
    exit 1
  fi
  ```

**Full CI job example:**

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
        - macos-15-intel  # darwin-x64
        - macos-14        # darwin-arm64
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

**Update CI Success Job:**

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

## Docker E2E Tests

**CRITICAL:** Update the Docker E2E test environment to include your engine. Run `pnpm test:docker` to verify.

```bash
pnpm test:docker              # Run all engine tests
pnpm test:docker -- {engine}  # Run single engine test (faster for debugging)
```

Valid engines: `postgresql`, `mysql`, `mariadb`, `sqlite`, `mongodb`, `ferretdb`, `redis`, `valkey`, `clickhouse`, `duckdb`, `qdrant`, `meilisearch`, `couchdb`, `cockroachdb`, `surrealdb`

The Docker E2E tests verify:
1. **Connectivity** - Basic query/command execution
2. **Data Lifecycle** - Full backup/restore verification with seed data

### File-Based vs Server-Based Engines

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

**REST API engines** (Qdrant, Meilisearch, CouchDB):
- Server-based but interact via HTTP REST API instead of CLI tools
- `spindb run` is not applicable (no CLI shell)
- Connectivity tests use `curl` to check health endpoint
- Seed data insertion uses `curl` to REST API endpoints

### tests/docker/Dockerfile

- [ ] Add engine to comments listing downloaded engines

- [ ] Add any required library dependencies

```dockerfile
# NOT pre-installed (SpinDB downloads from hostdb automatically):
# - PostgreSQL: server + client tools (psql, pg_dump, pg_restore)
# - MySQL: server + client tools (mysql, mysqldump, mysqladmin)
# - YourEngine: yourengine-server, yourengine-cli
```

### tests/docker/run-e2e.sh

- [ ] Add to `VALID_ENGINES` array

- [ ] Add to `EXPECTED_COUNTS` array (number of records in seed file)

- [ ] Add to `BACKUP_FORMATS` array (primary|secondary formats)

- [ ] Add case in `get_backup_extension()` function

- [ ] Add case in `insert_seed_data()` function

- [ ] Add case in `get_data_count()` function

- [ ] Add case in `create_backup()` function

- [ ] Add case in `create_restore_target()` function

- [ ] Add case in `restore_backup()` function

- [ ] Add case in `verify_restored_data()` function

- [ ] Add connectivity test case in main engine loop

- [ ] Add engine test execution at bottom of file

- [ ] For file-based engines: Update start/stop skip conditions

- [ ] For REST API engines: Add curl-based tests

**Configuration Arrays:**

```bash
# Expected data counts per engine (must match seed file)
declare -A EXPECTED_COUNTS
EXPECTED_COUNTS[yourengine]=5  # Number of records in your seed file

# Backup formats to test per engine (primary|secondary)
# IMPORTANT: Use engine-specific CLI format names (what --format accepts)
declare -A BACKUP_FORMATS
BACKUP_FORMATS[yourengine]="text|rdb"  # Formats separated by |
```

**get_backup_extension():**

```bash
get_backup_extension() {
  local engine=$1 format=$2
  case $engine in
    # ... existing engines ...
    yourengine)
      case $format in
        text) echo ".yourengine" ;;
        rdb) echo ".rdb" ;;
      esac
      ;;
  esac
}
```

**insert_seed_data():**

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
```

**Connectivity Test:**

```bash
yourengine)
  if ! spindb run "$container_name" -c "SELECT 1 as test;"; then
    echo "FAILED: Could not run YourEngine query"
    spindb stop "$container_name" 2>/dev/null || true
    spindb delete "$container_name" --yes 2>/dev/null || true
    record_result "$engine" "$version" "FAILED" "Query failed"
    FAILED=$((FAILED+1))
    return 1
  fi
  ;;
```

**REST API Engine Example (Qdrant):**

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

**Test Execution:**

```bash
# YourEngine
if should_run_test yourengine; then
  YOURENGINE_VERSION=$(get_default_version yourengine)
  [ -n "$YOURENGINE_VERSION" ] && run_test yourengine "$YOURENGINE_VERSION" || echo "Skipping YourEngine (no default version)"
fi
```

---

## Docker Export Compatibility

The `spindb export docker` command generates Docker-ready packages for deploying containers. Each engine must be properly integrated for this feature to work correctly.

### core/docker-exporter.ts Updates

- [ ] Add engine display name to `getEngineDisplayName()` function
- [ ] Add connection string template to `getConnectionStringTemplate()` function
- [ ] Add user creation commands in `generateEntrypoint()` switch statement

**Display Name:**

```ts
function getEngineDisplayName(engine: Engine): string {
  const displayNames: Record<Engine, string> = {
    // ... existing engines
    [Engine.YourEngine]: 'YourEngine',
  }
  return displayNames[engine] || engine
}
```

**Connection String Template:**

Return a template with `${SPINDB_USER}`, `${SPINDB_PASSWORD}`, and `<host>` placeholders:

```ts
function getConnectionStringTemplate(
  engine: Engine,
  port: number,
  database: string,
): string {
  switch (engine) {
    // ... existing engines

    case Engine.YourEngine:
      return `yourengine://${SPINDB_USER}:${SPINDB_PASSWORD}@<host>:${port}/${database}?tls=true`

    // For REST API engines (no user in URL):
    case Engine.YourApiEngine:
      return `https://<host>:${port}`
  }
}
```

**User Creation Commands:**

Add engine-specific SQL/commands to create the `spindb` user:

```ts
function generateEntrypoint(...): string {
  let userCreationCommands = ''

  switch (engine) {
    // ... existing engines

    // For SQL engines:
    case Engine.YourEngine:
      userCreationCommands = `
# Create user with password
echo "Creating database user..."
spindb run "$CONTAINER_NAME" --database system <<EOF
CREATE USER IF NOT EXISTS $SPINDB_USER IDENTIFIED BY '$SPINDB_PASSWORD';
GRANT ALL ON $DATABASE.* TO $SPINDB_USER;
EOF
`
      break

    // For key-value engines (password only):
    case Engine.YourKVEngine:
      userCreationCommands = `
# Authentication configured via server settings
echo "Authentication configured via server settings"
`
      break

    // For REST API engines (API key):
    case Engine.YourApiEngine:
      userCreationCommands = `
# API key is configured at server start
echo "API key configured via server settings"
`
      break
  }
}
```

### TLS Configuration

Document how your engine handles TLS:

| Engine | TLS Config Method | Connection String Param |
|--------|-------------------|-------------------------|
| PostgreSQL | `ssl = on` + certs in postgresql.conf | `?sslmode=require` |
| MySQL | `require_secure_transport = ON` | `?ssl=true` |
| Redis/Valkey | `tls-port` + cert flags | `rediss://` scheme |
| REST APIs | Usually behind reverse proxy | `https://` |

For engines with native TLS support, document:
- Configuration file or command-line flags for enabling TLS
- Certificate file paths
- Whether client verification is optional or required

### Authentication Methods

Each engine has a different authentication mechanism:

| Type | Engines | How It Works |
|------|---------|--------------|
| **User + Password** | PostgreSQL, MySQL, MariaDB, MongoDB, ClickHouse, CockroachDB | Create user via SQL/shell after startup |
| **Password Only** | Redis, Valkey | Configure via `--requirepass` at startup |
| **API Key** | Qdrant, Meilisearch | Configure via `--api-key` or `--master-key` at startup |
| **Admin Account** | CouchDB, SurrealDB | Create via API or configure at startup |
| **Wire Protocol Auth** | QuestDB | Uses PostgreSQL-compatible auth |

### File-Based Engines

SQLite and DuckDB require special handling:

```ts
// In generateEntrypoint(), use file copy instead of spindb restore:
const restoreSection = isFileBased
  ? `
# File-based database - copy data file
if ls /root/.spindb/init/*.${engine === Engine.SQLite ? 'sqlite' : 'duckdb'} 1> /dev/null 2>&1; then
    echo "Copying database file..."
    cp /root/.spindb/init/*.${extension} ~/.spindb/containers/$ENGINE/$CONTAINER_NAME/
fi
`
  : `
# Server-based - use spindb restore
...
`
```

### REST API Engines

Engines like Qdrant, Meilisearch, and CouchDB:
- Don't have CLI shells (`spindb run` not applicable)
- Use API keys or master keys for authentication
- Connection strings use `https://` scheme
- No user creation needed (just API key configuration)

### Testing Docker Export

After implementing Docker export support for your engine:

1. Create a local container with test data
2. Export to Docker: `spindb export docker mycontainer`
3. Build and run from the output directory (shown in export output):
   ```bash
   cd ~/.spindb/containers/{engine}/mycontainer/docker
   docker-compose up -d
   ```
4. Verify:
   - Container starts successfully
   - Database is accessible on configured port
   - Credentials work for authentication
   - Data from backup is restored correctly

**Note:** Use `-o ./mycontainer-docker` to export to the current directory instead of the default location. Use `--force` to overwrite an existing export.

---

## User Management

SpinDB supports creating database users via `spindb users create` and the interactive menu's "Create user" option. When adding a new engine, you must decide whether it supports user creation and implement accordingly.

### Engine Support Categories

| Category | Engines | Implementation |
|----------|---------|----------------|
| **SQL user/password** | PostgreSQL, MySQL, MariaDB, CockroachDB, ClickHouse | SQL `CREATE USER` + `GRANT` via CLI tool |
| **Document DB user/password** | MongoDB, FerretDB | `createUser()` / `updateUser()` via mongosh |
| **KV ACL** | Redis, Valkey | `ACL SETUSER` via CLI tool |
| **Multi-model** | SurrealDB | `DEFINE USER` via surreal sql |
| **REST API user/password** | CouchDB | PUT to `/_users/` endpoint |
| **REST API key** | Meilisearch | POST to `/keys` endpoint |
| **Config-based API key** | Qdrant | Write `api_key` to config.yaml, restart server |
| **Unsupported** | SQLite, DuckDB, QuestDB | Throw `UnsupportedOperationError` (default behavior) |

### Implementing `createUser()` in Your Engine

Override `createUser()` in your engine's `index.ts`. The base class already throws `UnsupportedOperationError` by default, so you only need to override if your engine supports users.

```ts
import type { ContainerConfig, CreateUserOptions, UserCredentials } from '../../types'

async createUser(
  container: ContainerConfig,
  options: CreateUserOptions,
): Promise<UserCredentials> {
  const { username, password, database } = options
  const port = container.port
  const db = database || container.database

  // 1. Create the user (engine-specific)
  // 2. Grant permissions on the database
  // 3. Return credentials with connection string

  return {
    username,
    password,
    connectionString: this.getConnectionString(container, db)
      .replace('127.0.0.1', `${username}:${password}@127.0.0.1`),
    engine: container.engine,
    container: container.name,
    database: db,
  }
}
```

### Idempotency Requirement (Critical)

`createUser()` **MUST be idempotent** — calling it twice with the same username but a different password must update the password rather than error. This is required because:

1. Users may run `spindb users create` with `--force` to reset a password
2. The credential file on disk is overwritten, so the database password must match

**Patterns by engine type:**

**SQL engines (PostgreSQL):** Catch "already exists" error, run `ALTER ROLE`:

```ts
try {
  await execAsync(createUserCmd)  // CREATE ROLE "user" WITH LOGIN PASSWORD 'pass'
} catch (error) {
  const err = error as Error
  if (err.message.includes('already exists')) {
    await execAsync(alterRoleCmd)  // ALTER ROLE "user" WITH PASSWORD 'newpass'
  } else {
    throw error
  }
}
```

**SQL engines (MySQL, MariaDB, ClickHouse, CockroachDB):** Use `CREATE USER IF NOT EXISTS` followed by `ALTER USER`:

```ts
const sql = [
  `CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${pass}';`,
  `ALTER USER '${user}'@'%' IDENTIFIED BY '${pass}';`,
  `GRANT ALL ON \`${db}\`.* TO '${user}'@'%';`,
  `FLUSH PRIVILEGES;`,
].join(' ')
```

> **MySQL/MariaDB gotcha:** `CREATE USER ... '@'%'` does NOT match `localhost` connections. You must create the user for BOTH `'%'` and `'localhost'` hosts, with GRANT statements for both.

**MongoDB/FerretDB:** Catch duplicate user error (code 51003), use `updateUser`:

```ts
try {
  await execAsync(createUserCmd)  // db.createUser({...})
} catch (error) {
  if (err.message.includes('51003') || err.message.includes('already exists')) {
    await execAsync(updateUserCmd)  // db.updateUser('user', {pwd: 'newpass'})
  } else {
    throw error
  }
}
```

**Redis/Valkey:** `ACL SETUSER` is inherently idempotent — it updates the user if they exist:

```ts
const cmd = `ACL SETUSER ${username} on >${password} ~* &* +@all`
```

**SurrealDB:** `DEFINE USER ... ON NAMESPACE` is idempotent — it replaces the user definition:

```ts
const sql = `DEFINE USER ${username} ON NAMESPACE PASSWORD '${password}' ROLES EDITOR`
```

**CouchDB (REST API):** Handle 409 Conflict by fetching `_rev` and updating:

```ts
const response = await couchdbApiRequest(port, 'PUT', `/_users/org.couchdb.user:${username}`, userDoc)
if (response.status === 409) {
  const existing = await couchdbApiRequest(port, 'GET', `/_users/org.couchdb.user:${username}`)
  const rev = existing.data._rev
  await couchdbApiRequest(port, 'PUT', `/_users/org.couchdb.user:${username}`, { ...userDoc, _rev: rev })
}
```

**Meilisearch (API key):** POST to `/keys` creates a new key. For idempotency, search existing keys first:

```ts
// Search for existing key by name, delete if found, then create new
```

**Qdrant (config file):** Replace existing `api_key:` line in config.yaml, or append if not present:

```ts
if (currentConfig.includes('api_key:')) {
  updatedConfig = currentConfig.replace(/api_key:\s*.+/, `api_key: ${password}`)
} else {
  updatedConfig = currentConfig + `\nservice:\n  api_key: ${password}\n`
}
// Restart server after config change
```

### API Key Engines vs User/Password Engines

Most engines create user/password credentials. API key engines (Meilisearch, Qdrant) differ:

- **Username** is a key name (e.g., `search_key`, `api_key`), not a login
- **Password** is the generated API key value
- **Connection string** includes the API key as a header or query parameter, not in the URL
- **Credential file** uses `API_KEY_NAME`, `API_KEY`, `API_URL` instead of `DB_USER`, `DB_PASSWORD`, `DB_URL`

Update `getDefaultUsername()` in `core/credential-manager.ts` if your engine uses API keys:

```ts
export function getDefaultUsername(engine: Engine): string {
  switch (engine) {
    case Engine.Meilisearch:
      return 'search_key'
    case Engine.Qdrant:
      return 'api_key'
    // Add your API key engine here:
    case Engine.YourApiEngine:
      return 'your_key_name'
    default:
      return 'spindb'
  }
}
```

### Credential Storage

Credentials are saved to `~/.spindb/containers/{engine}/{name}/credentials/.env.{username}` by the credential manager. The engine's `createUser()` method does NOT handle file storage — that's done by `core/credential-manager.ts`.

**Standard `.env.{username}` format:**
```
DB_USER=spindb
DB_PASSWORD=xA9bK2mQ7nR4wE1s
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=mydb
DB_URL=postgresql://spindb:xA9bK2mQ7nR4wE1s@127.0.0.1:5432/mydb
```

**API key `.env.{keyname}` format:**
```
API_KEY_NAME=search-key
API_KEY=actual_generated_key_value
API_URL=http://127.0.0.1:7700
```

### Integration Test for createUser

Every engine that supports users must have a createUser integration test. Add this test after the data insertion/query tests and before the rename test:

```ts
it('should create a user and update password on re-create', async () => {
  console.log(`\n Testing createUser...`)

  const config = await containerManager.getConfig(containerName)
  assert(config !== null, 'Container config should exist')

  const engine = getEngine(ENGINE)

  // First creation
  const creds1 = await engine.createUser(config!, {
    username: 'testuser',
    password: 'firstpass123',
    database: DATABASE,
  })
  assertEqual(creds1.username, 'testuser', 'Username should match')
  assertEqual(creds1.password, 'firstpass123', 'Password should match')
  console.log('   Created user with initial password')

  // Re-create with different password (must update, not error)
  const creds2 = await engine.createUser(config!, {
    username: 'testuser',
    password: 'secondpass456',
    database: DATABASE,
  })
  assertEqual(creds2.password, 'secondpass456', 'Password should be updated')
  console.log('   Re-created user with new password (idempotent)')
})
```

For engines that don't support users (SQLite, DuckDB, QuestDB), skip this test entirely.

### Password and Username Validation

- **Usernames** are validated by `assertValidUsername()` in `core/error-handler.ts`: must match `^[a-zA-Z][a-zA-Z0-9_]{0,62}$`
- **Passwords** are generated by `generatePassword({ length: 20, alphanumericOnly: true })` from `core/credential-generator.ts` — alphanumeric only to avoid URL-encoding issues in connection strings
- **SQL injection prevention**: Escape single quotes in passwords (`'` → `''` for SQL, `'` → `\\'` for shell). Use quoted identifiers for usernames in SQL.

### Checklist for New Engines

- [ ] Decide: does the engine support user creation?
  - **Yes**: Override `createUser()` in `engines/{engine}/index.ts`
  - **No**: Add engine to `ENGINES_WITHOUT_USERS` in `container-handlers.ts`
- [ ] Implement `createUser()` with idempotency (create or update)
- [ ] Handle MySQL/MariaDB localhost host issue (if applicable)
- [ ] Update `getDefaultUsername()` in `core/credential-manager.ts` (if API key engine)
- [ ] Add createUser integration test with idempotency verification
- [ ] Verify "Create user" menu item visibility (shown/hidden as appropriate)

---

## Documentation Updates

### Engine-Specific README (`engines/{engine}/README.md`)

Every engine must have a comprehensive README.md documenting implementation details. Use existing engine READMEs as templates (e.g., `engines/clickhouse/README.md`, `engines/questdb/README.md`).

**Required sections:**

- [ ] **Overview** - Brief description of the database and its use case
- [ ] **Platform Support** - Table showing supported platforms (darwin/linux/win32 x x64/arm64)
- [ ] **Binary Packaging**
  - [ ] Archive format (tar.gz, zip)
  - [ ] Archive structure (directory layout after extraction)
  - [ ] Any platform-specific differences in structure
  - [ ] Version map sync notes (especially for non-semver formats like ClickHouse's YY.MM)
- [ ] **Implementation Details**
  - [ ] Binary manager customizations
  - [ ] Version parsing/format
  - [ ] Configuration file format (XML, YAML, conf, etc.)
  - [ ] Port configuration (single port, dual ports, multi-port)
  - [ ] PID file handling quirks
  - [ ] Startup command details
  - [ ] Connection string format
- [ ] **Backup & Restore** - Formats, tools used, any cross-engine dependencies
- [ ] **Integration Test Notes** - Special considerations for testing
- [ ] **Docker E2E Test Notes** - What the E2E tests verify
- [ ] **Known Issues & Gotchas** - Document ALL quirks, edge cases, and lessons learned
- [ ] **CI/CD Notes** - GitHub Actions cache step, platform-specific CI considerations

**Why this matters:** This documentation captures tribal knowledge that would otherwise be lost. When future contributors need to debug or modify an engine, this README is their primary reference.

### README.md (project root)

- [ ] Update engine count (e.g., "13 different database engines" → "14 different database engines")
- [ ] Add engine to `--engine` option list in examples
- [ ] Add row to Platform Coverage table
- [ ] Update "X combinations" count
- [ ] Add row to Supported Databases table
- [ ] Add to Engine Categories list
- [ ] Update comparison matrix engine count
- [ ] Add row to Durability table
- [ ] Add Engine-Specific Details section
- [ ] Add row to Enhanced CLI Tools table
- [ ] Add Backup & Restore section for engine
- [ ] Add to Connection String Formats table
- [ ] Remove from Roadmap if it was listed as planned

### ARCHITECTURE.md

- [ ] Update description to include engine
- [ ] Update architecture diagram
- [ ] Add to Engine Types list
- [ ] Add to Engine Registry section
- [ ] Add alias to aliases section
- [ ] Add to Platform Support table
- [ ] Update Type System section
- [ ] Update ContainerConfig type

### CLAUDE.md

- [ ] Add engine alias to Engine Aliases section
- [ ] Add row to Supported Versions & Query Languages table
- [ ] Add to Port Management section (format: `EngineName: port`)

### CHANGELOG.md

- [ ] Add entry to `[Unreleased]` or current version section

```markdown
### Added
- YourEngine support (versions 8, 9)
  - Full container lifecycle (create, start, stop, delete)
  - Backup and restore (text and binary formats)
  - Clone containers via backup/restore
  - Cross-platform support (macOS, Linux, Windows)
```

### TODO.md

- [ ] Update engine count in any hardcoded references (e.g., "All 17 engine implementations")

### USE_CASES.md

- [ ] Update engine count in Core Features table
- [ ] Add engine name to Multi-Engine feature list
- [ ] Update "all N database engines" references
- [ ] Update comparison table engine counts (DBngin, Postgres.app rows)

### TEST_COVERAGE.md

- [ ] Update engine count in coverage table (e.g., "All 17 engines")
- [ ] Update user management exclusion list if engine lacks user management
- [ ] Update "well-covered" section engine count

### package.json

- [ ] Add engine name to `keywords` array
- [ ] Bump version (if this is a feature release)

### Hostdb Acknowledgment (README.md)

- [ ] Update engine count in Acknowledgments section (e.g., "Pre-compiled database binaries for 17 engines")

---

## Common Gotchas & Edge Cases

### Emoji Width Issues (emoji mode only)

Some emojis render narrower in certain terminals. If your engine icon appears too close to the engine name in emoji mode:
- Add the emoji to `NARROW_EMOJIS` map for the affected terminal(s)
- Example: `[Terminal.VSCode]: new Set(['🪶', '🦭', '🪳', '🛋', '⏱', '🆕'])`
- Known narrow emojis: 🦭 (seal), 🪶 (feather), 🛋 (couch), 🪳 (cockroach), ⏱ (timer)
- ASCII mode (default) doesn't have this issue

### Process Spawning with --background Flag

If your engine uses a `--background` flag that forks a daemon:
- Use `stdio: ['ignore', 'ignore', 'ignore']` to prevent hanging
- The parent process exits but file descriptors are inherited by the daemon
- See `engines/cockroachdb/index.ts` for correct pattern

### Windows Executable Extensions

Always use `platformService.getExecutableExtension()`:
```ts
const ext = platformService.getExecutableExtension()  // '.exe' on Windows, '' elsewhere
const binaryPath = join(binDir, `{engine}${ext}`)
```

### Port Allocation for Multi-Port Engines

If your engine uses multiple ports (e.g., SQL + HTTP):
- Allocate consecutive ports: SQL on N, HTTP on N+1
- Document this in CLAUDE.md and ENGINE_CHECKLIST.md
- Update `findConsecutiveFreePorts()` call in tests

### Connection String Compatibility

If your engine is protocol-compatible with another (e.g., CockroachDB with PostgreSQL):
- Use the compatible scheme: `postgresql://` for CockroachDB
- Document this clearly in connection string examples

### Version Detection Without --version Flag

Some engines don't support `--version` (e.g., CouchDB is an Erlang app that starts when run):
- Override `verifyBinary()` to check file existence only
- See `engines/couchdb/binary-manager.ts` for example

### REST API Engines

For engines without CLI tools (Qdrant, Meilisearch, CouchDB):
- `spindb run` is not applicable - throw clear error
- `spindb connect` opens web dashboard in browser
- Tests use `curl` instead of CLI commands
- Create `README.md` in fixtures instead of seed file

### JRE / Shell Script Engines (QuestDB Pattern)

For Java-based engines that use shell scripts to launch (like QuestDB):

1. **Shell script PID is useless**: The shell forks Java and exits immediately. `proc.pid` is invalid within milliseconds.

2. **Engine may not create PID file**: Don't assume the database creates `{dataDir}/engine.pid`.

3. **Find PID by port after startup**: Wait for the server to be ready, then use `platformService.findProcessByPort(port)` to find the actual Java process. Write that PID to your PID file.

4. **Multi-port conflicts**: JRE engines often use multiple ports (main, HTTP, metrics, etc.). ALL ports must be configured uniquely via environment variables. Example: QuestDB uses 4 ports that default to fixed values - without configuration, running multiple containers causes "could not bind socket" errors.

5. **Stop uses port lookup too**: The stop method should find the process by port first, then fall back to PID file.

6. **Cross-engine dependencies**: Some engines depend on binaries from other engines. For example, QuestDB uses PostgreSQL wire protocol and requires `psql` from the PostgreSQL engine for backup/restore/shell. SpinDB warns users when deleting PostgreSQL if QuestDB containers exist.

See `engines/questdb/index.ts` for details.

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

## Pass/Fail Criteria

An engine implementation is **complete** when ALL of the following pass:

### Required Checks

1. **Lint**: `pnpm lint` passes with no errors
2. **Unit Tests**: `pnpm test:unit` passes (includes new engine tests)
3. **Integration Tests**: `pnpm test:engine {engine}` passes (14+ tests)
4. **All Integration Tests**: `pnpm test:integration` passes (no regressions)

### CI Verification - BLOCKING REQUIREMENT

**An engine cannot be merged to main without passing CI tests on all supported platforms.**

1. **GitHub Actions workflow must include your engine** with a dedicated `test-{engine}` job
2. **All 5 OS variants must pass**: Ubuntu 22.04, Ubuntu 24.04, macOS 15 (Intel), macOS 14 (ARM), Windows
3. Binary caching is configured for hostdb downloads (speeds up CI runs)
4. `ci-success` job must include your engine in its `needs` array and verification checks
5. **No exceptions**: If your engine doesn't support a platform (e.g., ClickHouse on Windows), exclude that platform from the matrix but test all others

### File Count Verification

Verify all files are created:

```bash
# Engine files (should be 8)
ls -1 engines/{engine}/ | wc -l

# Fixture files
ls -la tests/fixtures/{engine}/seeds/

# Test files
ls -la tests/integration/{engine}.test.ts
ls -la tests/unit/{engine}-*.test.ts

# Check documentation changes
git diff --stat README.md ARCHITECTURE.md CLAUDE.md CHANGELOG.md TODO.md USE_CASES.md TEST_COVERAGE.md
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

- [ ] Run `spindb` and verify engine appears in "Create new container" menu
- [ ] Verify engine icon alignment (proper spacing after emoji)
- [ ] Create a container: `pnpm start create test-{engine} --engine {engine}`
- [ ] Start container: `pnpm start start test-{engine}`
- [ ] Connect to container: `pnpm start connect test-{engine}`
- [ ] Run a query: `pnpm start run test-{engine} -c "SELECT 1;"`
- [ ] Create backup: `pnpm start backup test-{engine}`
- [ ] Stop container: `pnpm start stop test-{engine}`
- [ ] Delete container: `pnpm start delete test-{engine} --yes`
- [ ] Verify engine appears in "Manage engines" menu
- [ ] Verify `pnpm start engines list` shows the engine

---

## Reference Implementations

Use these implementations as references:

| Engine | Type | Binary Source | Key Features |
|--------|------|---------------|--------------|
| **CockroachDB** | Server | hostdb (all platforms) | Newest implementation, PostgreSQL-compatible |
| **Valkey** | Server | hostdb (all platforms) | Redis fork, full example |
| **Redis** | Server | hostdb (all platforms) | Key-value, numbered DBs, text + RDB backup |
| **MongoDB** | Server | hostdb (all platforms) | Document DB, JavaScript queries, BSON backup |
| **PostgreSQL** | Server | hostdb + EDB (Windows) | SQL, Windows fallback example |
| **MySQL** | Server | hostdb (all platforms) | SQL, root user, socket handling |
| **MariaDB** | Server | hostdb (all platforms) | MySQL-compatible, separate binaries |
| **ClickHouse** | Server | hostdb (macOS/Linux) | OLAP, XML configs, YY.MM versioning |
| **SQLite** | File-based | hostdb (all platforms) | Embedded, no server process |
| **DuckDB** | File-based | hostdb (all platforms) | Embedded OLAP, flat archive handling example |
| **FerretDB** | Composite | hostdb (all platforms) | Two binaries (ferretdb + postgresql-documentdb), dual ports |

**Recommended starting point:** Copy CockroachDB or Valkey implementation and modify for your engine, as they're the most recent and complete examples. For composite engines, see [plans/FERRETDB.md](plans/FERRETDB.md).

---

## Appendix: Full Implementation Checklist

Use this consolidated checklist to track your progress. Check items off as you complete them.

### Pre-Implementation Research
- [ ] Engine type identified (server-based, file-based, REST API, or composite)
- [ ] Default port documented
- [ ] Secondary ports documented (if any)
- [ ] Connection scheme documented
- [ ] Default user/database documented
- [ ] CLI tools identified
- [ ] Version format understood
- [ ] Backup methods identified
- [ ] hostdb availability confirmed
- [ ] Platform support documented

### Core Engine Files (9 required)
- [ ] `engines/{engine}/README.md` created (binary structure, quirks, gotchas)
- [ ] `engines/{engine}/index.ts` created
- [ ] `engines/{engine}/backup.ts` created
- [ ] `engines/{engine}/restore.ts` created
- [ ] `engines/{engine}/version-validator.ts` created
- [ ] `engines/{engine}/version-maps.ts` created
- [ ] `engines/{engine}/binary-urls.ts` created
- [ ] `engines/{engine}/binary-manager.ts` created
- [ ] `engines/{engine}/hostdb-releases.ts` created

### Type System Updates
- [ ] Added to `Engine` enum in `types/index.ts`
- [ ] Added to `ALL_ENGINES` array
- [ ] Added binary tools to `BinaryTool` type
- [ ] Added backup format type (if needed)

### Configuration Files
- [ ] Added to `config/engine-defaults.ts`
- [ ] Added to `config/engines.json`
- [ ] Added to `config/backup-formats.ts`
- [ ] Added to `config/os-dependencies.ts` (if applicable)

### Core Manager Updates
- [ ] Added tools to `KNOWN_BINARY_TOOLS` in `core/dependency-manager.ts`
- [ ] Added tools constant to `core/config-manager.ts`
- [ ] Added to `ALL_TOOLS` array
- [ ] Added to `ENGINE_BINARY_MAP`
- [ ] Updated `initialize()` return type and implementation
- [ ] Exported tools constant
- [ ] Registered engine in `engines/index.ts`
- [ ] Added aliases (if applicable)
- [ ] Added client path getter to `engines/base-engine.ts`

### CLI Updates
- [ ] Added ASCII icon to `cli/constants.ts`
- [ ] Added Nerd Font icon
- [ ] Added emoji icon
- [ ] Added brand colors
- [ ] Added to `NARROW_EMOJIS` (if applicable)
- [ ] Added `InstalledXxxEngine` type to `cli/helpers.ts`
- [ ] Added `getInstalledXxxEngines()` function
- [ ] Added to `ENGINE_PREFIXES` array
- [ ] Updated `InstalledEngine` union type
- [ ] Updated `getInstalledEngines()`
- [ ] Updated `--engine` help text in `cli/commands/create.ts`
- [ ] Added to `detectLocationType()` (if applicable)
- [ ] Added import to `cli/commands/engines.ts`
- [ ] Added download case
- [ ] Updated error message
- [ ] Added to `listEngines()`

### Menu Handler Updates
- [ ] Updated `cli/commands/menu/container-handlers.ts`
- [ ] Updated `cli/commands/menu/shell-handlers.ts`
- [ ] Updated `cli/commands/menu/sql-handlers.ts`
- [ ] Updated `cli/commands/menu/backup-handlers.ts`
- [ ] Updated `cli/commands/menu/engine-handlers.ts`

### Test Infrastructure
- [ ] Created `tests/fixtures/{engine}/seeds/` directory
- [ ] Created seed file (or README.md for REST API engines)
- [ ] Added to `TEST_PORTS` in `tests/integration/helpers.ts`
- [ ] Added to `executeSQL()`
- [ ] Added to `waitForReady()`
- [ ] Added to `getConnectionString()`
- [ ] Added engine-specific helper functions
- [ ] Added to `runScriptFile()` and `runScriptSQL()`
- [ ] Created `tests/integration/{engine}.test.ts` (15+ tests, including createUser idempotency)
- [ ] Added version map import and entry to `ENGINES` array in `tests/integration/hostdb-sync.test.ts`
- [ ] Created `tests/unit/{engine}-version-validator.test.ts`
- [ ] Created `tests/unit/{engine}-restore.test.ts`
- [ ] Updated `tests/unit/config-manager.test.ts`
- [ ] Added to `ENGINE_TEST_FILES` in `scripts/test-engine.ts`
- [ ] Added to `ENGINE_ALIASES`
- [ ] Added to `TEST_ORDER`
- [ ] Updated help text

### Generate Scripts
- [ ] Created `scripts/generate/db/{engine}.ts`
- [ ] Added engine to `ENGINE_DEFS` in `scripts/generate/db/index.ts`
- [ ] Added engine to `SUPPORTED_ENGINES` in `scripts/generate/missing-databases.ts`

### CI/CD Configuration
- [ ] Added binary cache step to `.github/workflows/ci.yml`
- [ ] Added `test-{engine}` job with 5-platform matrix
- [ ] Added download step
- [ ] Added test step
- [ ] Added failure debug step
- [ ] Added to `ci-success` job `needs` array
- [ ] Added result check in `ci-success` job

### Docker E2E Tests
- [ ] Updated `tests/docker/Dockerfile` comments
- [ ] Added library dependencies (if any)
- [ ] Added to `VALID_ENGINES` in `run-e2e.sh`
- [ ] Added to `EXPECTED_COUNTS`
- [ ] Added to `BACKUP_FORMATS`
- [ ] Added case in `get_backup_extension()`
- [ ] Added case in `insert_seed_data()`
- [ ] Added case in `get_data_count()`
- [ ] Added case in `create_backup()`
- [ ] Added case in `create_restore_target()`
- [ ] Added case in `restore_backup()`
- [ ] Added case in `verify_restored_data()`
- [ ] Added connectivity test case
- [ ] Added engine test execution
- [ ] Updated start/stop skip conditions (file-based only)
- [ ] Added curl-based tests (REST API only)

### Docker Export Compatibility
- [ ] Added engine display name to `getEngineDisplayName()` in `core/docker-exporter.ts`
- [ ] Added connection string template to `getConnectionStringTemplate()`
- [ ] Added user creation commands to `generateEntrypoint()` switch statement
- [ ] Documented TLS configuration method for engine
- [ ] Documented authentication mechanism (user/pass, API key, etc.)
- [ ] Tested `spindb export docker` → `docker-compose up` workflow
- [ ] Verified credentials work for authentication
- [ ] Verified data restore works correctly

### User Management
- [ ] Decided: engine supports users? (Yes → override `createUser()`, No → add to exclusion list)
- [ ] Overrode `createUser()` in `engines/{engine}/index.ts` (if supported)
- [ ] `createUser()` is idempotent (re-create updates password, does not error)
- [ ] Added engine to `ENGINES_WITHOUT_USERS` in `container-handlers.ts` (if unsupported)
- [ ] Updated `getDefaultUsername()` in `core/credential-manager.ts` (if API key engine)
- [ ] Added createUser integration test with idempotency check
- [ ] Verified "Create user" menu item visibility

### Documentation Updates
- [ ] Created `engines/{engine}/README.md` with all required sections
- [ ] Documented platform support table
- [ ] Documented binary packaging (archive format, directory structure)
- [ ] Documented implementation details (version format, configuration, ports)
- [ ] Documented known issues & gotchas
- [ ] Documented CI/CD considerations
- [ ] Updated `README.md` engine count
- [ ] Added to `--engine` option list
- [ ] Added to Platform Coverage table
- [ ] Updated combinations count
- [ ] Added to Supported Databases table
- [ ] Added to Engine Categories
- [ ] Updated comparison matrix
- [ ] Added to Durability table
- [ ] Added Engine-Specific Details section
- [ ] Added to Enhanced CLI Tools table
- [ ] Added Backup & Restore section
- [ ] Added to Connection String Formats
- [ ] Removed from Roadmap (if applicable)
- [ ] Updated `ARCHITECTURE.md` description
- [ ] Updated architecture diagram
- [ ] Added to Engine Types list
- [ ] Added to Engine Registry section
- [ ] Added aliases
- [ ] Added to Platform Support table
- [ ] Updated Type System section
- [ ] Updated ContainerConfig type
- [ ] Added alias to Engine Aliases in `CLAUDE.md`
- [ ] Added to Supported Versions & Query Languages table
- [ ] Added to Port Management section
- [ ] Added entry to `CHANGELOG.md`
- [ ] Added engine to `keywords` in `package.json`

### Final Verification
- [ ] `pnpm lint` passes
- [ ] `pnpm test:unit` passes
- [ ] `pnpm test:engine {engine}` passes
- [ ] `pnpm test:integration` passes
- [ ] `pnpm test:docker -- {engine}` passes (if applicable)
- [ ] CI tests pass on all 5 OS variants
- [ ] Engine appears in "Create new container" menu
- [ ] Icon alignment verified
- [ ] Full lifecycle test passed manually
- [ ] Engine appears in "Manage engines" menu
- [ ] `spindb engines list` shows the engine
- [ ] `spindb export docker` works for engine
- [ ] Docker container starts and database is accessible
