# New Database Engine Implementation Guide

This document provides the complete specification for adding a new database engine to SpinDB. Follow this checklist to ensure all requirements are met before the engine is considered complete.

## Table of Contents

1. [Overview](#overview)
2. [Engine Types](#engine-types)
3. [Quick Start Checklist](#quick-start-checklist)
4. [Core Implementation](#core-implementation)
5. [Configuration Files](#configuration-files)
6. [Testing Requirements](#testing-requirements)
7. [GitHub Actions / CI](#github-actions--ci)
8. [Binary Management](#binary-management)
9. [OS Dependencies](#os-dependencies)
10. [Windows Considerations](#windows-considerations)
11. [Documentation Updates](#documentation-updates)
12. [Pass/Fail Criteria](#passfail-criteria)
13. [Reference Implementations](#reference-implementations)

---

## Overview

SpinDB supports multiple database engines through an abstract `BaseEngine` class. Each engine must implement all abstract methods and integrate with the existing CLI infrastructure.

**Key Principles:**

1. **CLI-First**: All functionality must be available via command-line arguments
2. **Wrapper Pattern**: Functions wrap CLI tools (psql, mysql, mongosh) rather than implementing database logic
3. **Cross-Platform**: Must work on macOS, Linux, and Windows
4. **Transactional**: Multi-step operations must be atomic with rollback support

---

## Engine Types

SpinDB supports two types of database engines:

### Server-Based Databases (PostgreSQL, MySQL, MongoDB)

- Data stored in `~/.spindb/containers/{engine}/{name}/`
- Require start/stop lifecycle management
- Use port allocation and process management
- Have log files and PID tracking

### File-Based Databases (SQLite)

- Data stored in user project directories (CWD)
- No start/stop required (embedded)
- No port management needed (`port: 0`)
- Connection string is the file path
- Use a registry to track file locations

---

## Quick Start Checklist

Use this checklist to track implementation progress:

### Core Implementation

- [ ] `engines/{engine}/index.ts` - Main engine class extending `BaseEngine`
- [ ] `engines/{engine}/backup.ts` - Backup creation wrapper
- [ ] `engines/{engine}/restore.ts` - Backup detection and restore logic
- [ ] `engines/{engine}/version-validator.ts` - Version parsing and compatibility
- [ ] `engines/{engine}/binary-manager.ts` OR `binary-detection.ts` - Binary management

### Configuration Files

- [ ] `engines/index.ts` - Register engine with aliases
- [ ] `types/index.ts` - Add to `Engine` enum and `BinaryTool` type
- [ ] `config/engine-defaults.ts` - Add engine defaults
- [ ] `config/os-dependencies.ts` - Add system dependencies
- [ ] `cli/constants.ts` - Add engine icon

### Menu/CLI Terminology

- [ ] `cli/commands/menu/container-handlers.ts` - Update "Run SQL file" label if not SQL-based
- [ ] `cli/commands/menu/container-handlers.ts` - Skip database name prompt if engine uses numbered DBs
- [ ] `cli/commands/menu/shell-handlers.ts` - Add engine-specific shell (e.g., redis-cli, iredis)
- [ ] `cli/commands/menu/shell-handlers.ts` - Hide usql option for non-SQL engines
- [ ] `cli/commands/menu/sql-handlers.ts` - Update script type terminology (SQL/Script/Command)

### Testing

- [ ] `tests/fixtures/{engine}/seeds/sample-db.sql` - Test seed file
- [ ] `tests/integration/{engine}.test.ts` - Integration tests (14+ tests)
- [ ] `tests/integration/helpers.ts` - Add engine to helper functions
- [ ] Unit tests for version validator
- [ ] Unit tests for binary detection/management
- [ ] CLI E2E tests include engine

### CI/CD

- [ ] `.github/workflows/ci.yml` - Add integration test job
- [ ] CI runs on all 3 OSes (or document exceptions)
- [ ] CI success job updated with new engine

### Documentation

- [ ] `README.md` - Add engine section
- [ ] `CHANGELOG.md` - Add to unreleased section
- [ ] `TODO.md` - Update engine status

---

## Core Implementation

### Engine Directory Structure

Create a new directory at `engines/{engine}/`:

```
engines/{engine}/
├── index.ts           # Main engine class (required)
├── backup.ts          # Backup wrapper (required)
├── restore.ts         # Restore logic (required)
├── version-validator.ts  # Version parsing (required)
└── binary-manager.ts  # For downloadable binaries
    OR
└── binary-detection.ts   # For system binaries
```

### BaseEngine Abstract Methods

Your engine class must extend `BaseEngine` and implement ALL of these methods:

```typescript
import { BaseEngine } from '../base-engine'
import type {
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  BackupOptions,
  BackupResult,
  RestoreResult,
  DumpResult,
  StatusResult,
} from '../../types'

export class YourEngine extends BaseEngine {
  // =====================
  // REQUIRED PROPERTIES
  // =====================

  name = 'yourengine' // Lowercase, used in CLI and paths
  displayName = 'YourEngine' // Human-readable name
  defaultPort = 27017 // Default port (0 for file-based)
  supportedVersions = ['6', '7', '8'] // Major versions supported

  // =====================
  // BINARY MANAGEMENT
  // =====================

  /**
   * Get download URL for binaries (server-based engines with downloadable binaries)
   * Throw error with install instructions if binaries must be system-installed
   */
  getBinaryUrl(version: string, platform: string, arch: string): string

  /**
   * Verify that binaries at the given path are functional
   */
  async verifyBinary(binPath: string): Promise<boolean>

  /**
   * Check if binaries for a version are installed
   */
  async isBinaryInstalled(version: string): Promise<boolean>

  /**
   * Ensure binaries are available, downloading or installing if necessary
   * Should register tool paths with configManager after installation
   */
  async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string>

  // =====================
  // LIFECYCLE
  // =====================

  /**
   * Initialize data directory for a new container
   * Server-based: Create data directory, init database cluster
   * File-based: Create database file, register in registry
   */
  async initDataDir(
    containerName: string,
    version: string,
    options?: Record<string, unknown>,
  ): Promise<string>

  /**
   * Start the database server
   * Server-based: Start daemon, return port and connection string
   * File-based: Verify file exists, return connection string
   */
  async start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }>

  /**
   * Stop the database server
   * Server-based: Send shutdown signal, wait for clean stop
   * File-based: No-op
   */
  async stop(container: ContainerConfig): Promise<void>

  /**
   * Get status of the database
   * Return running: true if database is ready to accept connections
   */
  async status(container: ContainerConfig): Promise<StatusResult>

  // =====================
  // CONNECTION
  // =====================

  /**
   * Build connection string for the container
   * Examples:
   *   postgresql://postgres@127.0.0.1:5432/mydb
   *   mysql://root@127.0.0.1:3306/mydb
   *   mongodb://127.0.0.1:27017/mydb
   *   sqlite:///path/to/file.sqlite
   */
  getConnectionString(container: ContainerConfig, database?: string): string

  /**
   * Open interactive shell connection
   * Spawn the database CLI (psql, mysql, mongosh) with inherited stdio
   */
  async connect(container: ContainerConfig, database?: string): Promise<void>

  // =====================
  // DATABASE OPERATIONS
  // =====================

  /**
   * Create a new database within the container
   * File-based: Often a no-op (file is the database)
   */
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void>

  /**
   * Drop a database within the container
   */
  async dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void>

  /**
   * Run a SQL/script file or inline statement
   */
  async runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void>

  /**
   * Get the size of the database in bytes
   * Return null if not running or cannot be determined
   */
  async getDatabaseSize(container: ContainerConfig): Promise<number | null>

  // =====================
  // BACKUP & RESTORE
  // =====================

  /**
   * Detect the format of a backup file
   * Return format, description, and restore command hint
   */
  async detectBackupFormat(filePath: string): Promise<BackupFormat>

  /**
   * Create a backup of the database
   * options.format: 'sql' (plain text) or 'dump' (binary/compressed)
   */
  async backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult>

  /**
   * Restore a backup to the container
   */
  async restore(
    container: ContainerConfig,
    backupPath: string,
    options?: Record<string, unknown>,
  ): Promise<RestoreResult>

  /**
   * Dump from a remote database using a connection string
   * Used for `spindb create --from <connection-string>`
   */
  async dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult>

  // =====================
  // OPTIONAL OVERRIDES
  // =====================

  /**
   * Fetch available versions from remote source (optional)
   * Default implementation returns supportedVersions as single-item arrays
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    const versions: Record<string, string[]> = {}
    for (const v of this.supportedVersions) {
      versions[v] = [v]
    }
    return versions
  }
}

export const yourEngine = new YourEngine()
```

### Engine Registration

Register your engine in `engines/index.ts`:

```typescript
import { yourEngine } from './yourengine'

export const engines: Record<string, BaseEngine> = {
  // ... existing engines

  // Your engine and aliases
  yourengine: yourEngine,
  alias1: yourEngine,  // e.g., 'mongo' for 'mongodb'
}
```

---

## Configuration Files

### 1. Types (`types/index.ts`)

Add to the `Engine` enum:

```typescript
export enum Engine {
  PostgreSQL = 'postgresql',
  MySQL = 'mysql',
  SQLite = 'sqlite',
  YourEngine = 'yourengine',  // Add this
}
```

Add any new binary tools to `BinaryTool`:

```typescript
export type BinaryTool =
  // PostgreSQL tools
  | 'psql'
  | 'pg_dump'
  // ... existing tools

  // Your engine tools
  | 'mongosh'      // Add these
  | 'mongodump'
  | 'mongorestore'
```

### 2. Engine Defaults (`config/engine-defaults.ts`)

Add your engine's defaults:

```typescript
export const engineDefaults: Record<string, EngineDefaults> = {
  // ... existing engines

  yourengine: {
    defaultVersion: '7',
    defaultPort: 27017,
    portRange: { start: 27017, end: 27100 },
    supportedVersions: ['6', '7', '8'],
    latestVersion: '7',
    superuser: 'admin',  // or '' if no auth
    connectionScheme: 'mongodb',
    logFileName: 'mongodb.log',
    pidFileName: 'mongodb.pid',
    dataSubdir: 'data',
    clientTools: ['mongosh', 'mongodump', 'mongorestore'],
    maxConnections: 0,  // 0 if not applicable
  },
}
```

### 3. OS Dependencies (`config/os-dependencies.ts`)

Add system dependencies for each package manager:

```typescript
const yourengineDependencies: EngineDependencies = {
  engine: 'yourengine',
  displayName: 'YourEngine',
  dependencies: [
    {
      name: 'mongosh',
      binary: 'mongosh',
      description: 'MongoDB Shell',
      packages: {
        brew: { package: 'mongosh' },
        apt: { package: 'mongodb-mongosh' },
        yum: { package: 'mongodb-mongosh' },
        dnf: { package: 'mongodb-mongosh' },
        pacman: { package: 'mongosh' },
        choco: { package: 'mongodb-shell' },
        winget: { package: 'MongoDB.Shell' },
        scoop: { package: 'mongosh' },
      },
      manualInstall: {
        darwin: [
          'Install with Homebrew: brew install mongosh',
          'Or download from: https://www.mongodb.com/try/download/shell',
        ],
        linux: [
          'Ubuntu/Debian: Follow MongoDB install guide at https://www.mongodb.com/docs/manual/administration/install-on-linux/',
        ],
        win32: [
          'Using Chocolatey: choco install mongodb-shell',
          'Or download from: https://www.mongodb.com/try/download/shell',
        ],
      },
    },
    // Add more dependencies as needed (mongodump, mongorestore, mongod)
  ],
}

// Add to registry
export const engineDependencies: EngineDependencies[] = [
  postgresqlDependencies,
  mysqlDependencies,
  sqliteDependencies,
  yourengineDependencies,  // Add this
]
```

### 4. Config Schema (`types/index.ts` - SpinDBConfig)

If your engine needs registry-based tracking (like SQLite for file-based databases), add to the config schema:

```typescript
export type SpinDBConfig = {
  binaries: {
    // ... existing tools

    // Your engine tools
    mongosh?: BinaryConfig
    mongodump?: BinaryConfig
    mongorestore?: BinaryConfig
  }
  // ...
}
```

### 5. Engine Icon (`cli/constants.ts`)

Add your engine's icon to the `ENGINE_ICONS` map. This icon appears in the interactive menu when selecting database engines.

```typescript
export const ENGINE_ICONS: Record<string, string> = {
  postgresql: '🐘',
  mysql: '🐬',
  sqlite: '🪶',
  mongodb: '🍃',
  yourengine: '🔴',  // Add your engine icon
}
```

**Icon conventions:**
- Use an emoji that represents the database (e.g., animal mascot, related symbol)
- Keep it simple and recognizable
- If no obvious icon exists, check the database's official branding

**Common engine icons:**
| Engine | Icon | Reason |
|--------|------|--------|
| PostgreSQL | 🐘 | Elephant mascot |
| MySQL | 🐬 | Dolphin mascot |
| SQLite | 🪶 | Feather (lightweight) |
| MongoDB | 🍃 | Leaf (from logo) |
| Redis | 🔴 | Red circle (from name/logo) |

If no icon is provided, the default `▣` will be used, which looks generic in the menu.

---

## Testing Requirements

### Test Fixtures

Create test fixtures for your engine:

```
tests/fixtures/{engine}/
├── seeds/
│   └── sample-db.sql    # Required: Basic seed file for testing
└── dumps/               # Optional: For restore format detection tests
    └── {engine}-{version}-plain.sql
```

**Sample seed file requirements:**
- Create a simple table (e.g., `test_user`)
- Insert exactly 5 rows (tests verify `EXPECTED_ROW_COUNT = 5`)
- Use engine-compatible SQL syntax

Example (`tests/fixtures/yourengine/seeds/sample-db.sql`):

```sql
-- Create test table
CREATE TABLE IF NOT EXISTS test_user (
    id INT PRIMARY KEY,
    name VARCHAR(100),
    email VARCHAR(100)
);

-- Insert test data (exactly 5 rows)
INSERT INTO test_user (id, name, email) VALUES
    (1, 'Alice', 'alice@example.com'),
    (2, 'Bob', 'bob@example.com'),
    (3, 'Charlie', 'charlie@example.com'),
    (4, 'Diana', 'diana@example.com'),
    (5, 'Eve', 'eve@example.com');
```

### Integration Test Helpers

Update `tests/integration/helpers.ts` to support your engine:

```typescript
// 1. Add to TEST_PORTS
export const TEST_PORTS = {
  postgresql: { base: 5454, clone: 5456, renamed: 5455 },
  mysql: { base: 3333, clone: 3335, renamed: 3334 },
  yourengine: { base: 27050, clone: 27052, renamed: 27051 },  // Add this
}

// 2. Update executeSQL function
export async function executeSQL(
  engine: Engine,
  port: number,
  database: string,
  sql: string,
): Promise<{ stdout: string; stderr: string }> {
  if (engine === Engine.YourEngine) {
    // Add engine-specific SQL execution
    const cmd = `mongosh --host 127.0.0.1 --port ${port} ${database} --eval "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  }
  // ... existing engines
}

// 3. Update waitForReady function
export async function waitForReady(
  engine: Engine,
  port: number,
  timeoutMs = 30000,
): Promise<boolean> {
  // Add engine-specific readiness check
  if (engine === Engine.YourEngine) {
    await execAsync(`mongosh --host 127.0.0.1 --port ${port} --eval "db.runCommand({ ping: 1 })"`)
    return true
  }
  // ... existing engines
}

// 4. Update getConnectionString function
export function getConnectionString(
  engine: Engine,
  port: number,
  database: string,
): string {
  if (engine === Engine.YourEngine) {
    return `mongodb://127.0.0.1:${port}/${database}`
  }
  // ... existing engines
}
```

### Integration Test File

Create `tests/integration/{engine}.test.ts` with **at least 14 tests**:

```typescript
import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
import {
  TEST_PORTS,
  generateTestName,
  findConsecutiveFreePorts,
  cleanupTestContainers,
  getRowCount,
  waitForReady,
  containerDataExists,
  getConnectionString,
  assert,
  assertEqual,
  runScriptFile,
  runScriptSQL,
} from './helpers'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const ENGINE = Engine.YourEngine
const DATABASE = 'testdb'
const SEED_FILE = join(__dirname, '../fixtures/yourengine/seeds/sample-db.sql')
const EXPECTED_ROW_COUNT = 5

describe('YourEngine Integration Tests', () => {
  let testPorts: number[]
  let containerName: string
  let clonedContainerName: string
  let renamedContainerName: string
  let portConflictContainerName: string

  before(async () => {
    // ... setup (see postgresql.test.ts for reference)
  })

  after(async () => {
    // ... cleanup
  })

  // Required tests (14 minimum):
  it('should create container without starting (--no-start)', async () => { /* ... */ })
  it('should start the container', async () => { /* ... */ })
  it('should seed the database with test data using runScript', async () => { /* ... */ })
  it('should create a new container from connection string (dump/restore)', async () => { /* ... */ })
  it('should verify restored data matches source', async () => { /* ... */ })
  it('should stop and delete the restored container', async () => { /* ... */ })
  it('should modify data using runScript inline SQL', async () => { /* ... */ })
  it('should stop, rename container, and change port', async () => { /* ... */ })
  it('should verify data persists after rename', async () => { /* ... */ })
  it('should handle port conflict gracefully', async () => { /* ... */ })
  it('should show warning when starting already running container', async () => { /* ... */ })
  it('should show warning when stopping already stopped container', async () => { /* ... */ })
  it('should delete container with --force', async () => { /* ... */ })
  it('should have no test containers remaining', async () => { /* ... */ })
})
```

### Unit Tests

Create unit tests for engine-specific logic:

```
tests/unit/
├── {engine}-version-validator.test.ts  # Version parsing/compatibility
├── {engine}-windows.test.ts            # Windows-specific command building
└── {engine}-binary-*.test.ts           # Binary management (if applicable)
```

### CLI E2E Tests

Ensure your engine works with CLI E2E tests in `tests/integration/cli-e2e.test.ts`. The existing tests should work if you've properly implemented the engine, but verify that:

1. `spindb engines list` shows your engine
2. `spindb create <name> --engine yourengine` works
3. All container lifecycle commands work

---

## GitHub Actions / CI

### Adding to ci.yml

Add a new job for your engine in `.github/workflows/ci.yml`:

```yaml
# ============================================
# YourEngine Integration Tests
# ============================================
test-yourengine:
  name: YourEngine (${{ matrix.os }})
  runs-on: ${{ matrix.os }}
  needs: unit-tests
  strategy:
    fail-fast: false
    matrix:
      # Include all OSes, or document why one is excluded
      os: [ubuntu-latest, macos-latest, windows-latest]
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

    # Install engine binaries via SpinDB or system package manager
    - name: Install YourEngine via SpinDB
      run: pnpm start engines download yourengine

    # Windows often needs PATH updates after package manager install
    - name: Add YourEngine to PATH (Windows)
      if: runner.os == 'Windows'
      shell: pwsh
      run: |
        $possiblePaths = @(
          "C:\Program Files\MongoDB\Server\7.0\bin",
          "C:\tools\mongodb\current\bin"
        )
        foreach ($path in $possiblePaths) {
          if (Test-Path $path) {
            echo "$path" | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
            echo "Found YourEngine at: $path"
            break
          }
        }

    - name: Show installed engines
      run: pnpm start engines list

    - name: Run YourEngine integration tests
      run: pnpm test:yourengine
      timeout-minutes: 15
```

### Update CI Success Job

Add your engine to the `ci-success` job:

```yaml
ci-success:
  name: CI Success
  runs-on: ubuntu-latest
  needs:
    [unit-tests, test-postgresql, test-mysql, test-sqlite, test-yourengine, test-cli-e2e, lint]
  if: always()
  steps:
    - name: Check all jobs passed
      run: |
        # ... existing checks
        if [ "${{ needs.test-yourengine.result }}" != "success" ]; then
          echo "YourEngine tests failed"
          exit 1
        fi
        echo "All CI checks passed!"
```

### Add Test Script to package.json

```json
{
  "scripts": {
    "test:yourengine": "node --import tsx --test tests/integration/yourengine.test.ts"
  }
}
```

---

## Binary Management

### Downloadable Binaries (like PostgreSQL)

If your engine has binaries that can be downloaded:

1. Create `engines/{engine}/binary-urls.ts`:

```typescript
export const SUPPORTED_MAJOR_VERSIONS = ['6', '7', '8']

// Fallback version map for offline use
export const FALLBACK_VERSION_MAP: Record<string, string> = {
  '6': '6.0.15',
  '7': '7.0.12',
  '8': '8.0.0',
}

/**
 * Get download URL for binaries
 * Must handle: darwin-arm64, darwin-x64, linux-x64, win32-x64
 */
export function getBinaryUrl(
  version: string,
  platform: string,
  arch: string,
): string {
  // Example: Construct URL based on platform/arch
  const platformMap: Record<string, string> = {
    'darwin-arm64': 'macos-arm64',
    'darwin-x64': 'macos-x86_64',
    'linux-x64': 'linux-x86_64',
    'win32-x64': 'windows-x86_64',
  }

  const platformKey = `${platform}-${arch}`
  const binaryPlatform = platformMap[platformKey]

  if (!binaryPlatform) {
    throw new Error(`Unsupported platform: ${platformKey}`)
  }

  return `https://example.com/releases/${version}/yourengine-${version}-${binaryPlatform}.tar.gz`
}

/**
 * Fetch available versions from remote source
 */
export async function fetchAvailableVersions(): Promise<Record<string, string[]>> {
  // Fetch from API or scrape releases page
  // Return map of major version -> array of full versions
}
```

2. Document binary sources in a comment at the top of the file:

```typescript
/**
 * Binary URLs for YourEngine
 *
 * Sources:
 * - macOS/Linux: https://example.com/releases
 * - Windows: https://example.com/windows/downloads
 *
 * Supported platforms:
 * - darwin-arm64: macOS Apple Silicon
 * - darwin-x64: macOS Intel
 * - linux-x64: Linux x86_64
 * - win32-x64: Windows x64
 */
```

### Windows Binary Considerations (PostgreSQL Example)

PostgreSQL uses different binary sources per platform:
- **macOS/Linux**: zonky.io provides Maven Central URLs with predictable version-based paths
- **Windows**: EnterpriseDB (EDB) uses opaque file IDs that must be manually discovered

When a Windows binary source uses opaque IDs (not version-based URLs):

1. Create a separate file for Windows URL handling (e.g., `edb-binary-urls.ts`)
2. Document the process for discovering new IDs in the file header
3. Include both full version and major version aliases:
   ```typescript
   export const EDB_FILE_IDS: Record<string, string> = {
     '18.1.0': '1259913',  // Full version
     '18': '1259913',      // Major version alias
   }
   ```
4. Add detailed instructions explaining:
   - Why manual updates are needed (opaque IDs vs predictable URLs)
   - Step-by-step process to find new IDs
   - Which files need updating when new versions are released

See `engines/postgresql/edb-binary-urls.ts` for a complete example with documentation.

### System Binaries (like MySQL)

If your engine uses system-installed binaries:

1. Create `engines/{engine}/binary-detection.ts`:

```typescript
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'

export async function findBinaryPath(binary: string): Promise<string | null> {
  // Check config cache first
  const cachedPath = await configManager.getBinaryPath(binary)
  if (cachedPath) return cachedPath

  // Search system PATH
  return platformService.findToolPath(binary)
}

export async function detectBinaryVersion(binaryPath: string): Promise<string | null> {
  // Run --version command and parse output
}
```

2. In your engine's `ensureBinaries()`, use dependency manager:

```typescript
async ensureBinaries(
  version: string,
  onProgress?: ProgressCallback,
): Promise<string> {
  const packageManager = await detectPackageManager()
  if (!packageManager) {
    throw new Error('No package manager found. Install manually.')
  }

  await installEngineDependencies('yourengine', packageManager, onProgress)

  // Verify installation and register paths
  const binaryPath = await findBinaryPath('mongosh')
  if (binaryPath) {
    await configManager.setBinaryPath('mongosh', binaryPath, 'system')
  }

  return binaryPath || ''
}
```

---

## OS Dependencies

### Finding Package Names

Research the correct package names for each package manager:

| Package Manager | Platform | Research Method |
|-----------------|----------|-----------------|
| brew | macOS | `brew search <name>`, check formulae.brew.sh |
| apt | Debian/Ubuntu | `apt search <name>`, check packages.ubuntu.com |
| yum/dnf | RHEL/Fedora | `dnf search <name>` |
| pacman | Arch | `pacman -Ss <name>`, check archlinux.org/packages |
| choco | Windows | `choco search <name>`, check community.chocolatey.org |
| winget | Windows | `winget search <name>` |
| scoop | Windows | `scoop search <name>`, check scoop.sh |

### Enhanced CLI Tools

If your engine has an enhanced CLI (like pgcli, mycli, litecli):

1. Add to `config/os-dependencies.ts`:

```typescript
export const yourcliDependency: Dependency = {
  name: 'yourcli',
  binary: 'yourcli',
  description: 'YourEngine CLI with auto-completion and syntax highlighting',
  packages: {
    brew: { package: 'yourcli' },
    // ... other package managers
  },
  manualInstall: {
    // ... install instructions
  },
}
```

2. Add to `BinaryTool` type in `types/index.ts`
3. Support `--yourcli` flag in connect command

---

## Windows Considerations

Windows requires special handling in several areas:

### Command Quoting

```typescript
import { isWindows } from '../../core/platform-service'

// Use double quotes on Windows, single quotes on Unix
const sql = `SELECT * FROM users`
const cmd = isWindows()
  ? `"${toolPath}" -c "${sql.replace(/"/g, '\\"')}"`
  : `"${toolPath}" -c '${sql}'`
```

### Spawn Options

```typescript
import { getWindowsSpawnOptions } from '../../core/platform-service'

const spawnOptions: SpawnOptions = {
  stdio: 'inherit',
  ...getWindowsSpawnOptions(),  // Adds shell: true on Windows
}
```

### Executable Extensions

```typescript
import { platformService } from '../../core/platform-service'

const ext = platformService.getExecutableExtension()  // '.exe' on Windows, '' otherwise
const toolPath = join(binPath, 'bin', `tool${ext}`)
```

### PATH Updates in CI

Windows package managers (choco, winget, scoop) often don't update PATH in the current session. Add explicit PATH updates in CI:

```yaml
- name: Add to PATH (Windows)
  if: runner.os == 'Windows'
  shell: pwsh
  run: |
    $path = "C:\Program Files\YourEngine\bin"
    if (Test-Path $path) {
      echo "$path" | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
    }
```

---

## Documentation Updates

### README.md

Add your engine to the "Supported Engines" section:

```markdown
### YourEngine

| Version | Port | Binary Source |
|---------|------|---------------|
| 6.x     | 27017 | Downloaded from mongodb.com |
| 7.x     | 27017 | Downloaded from mongodb.com |
| 8.x     | 27017 | Downloaded from mongodb.com |

**Requirements:**
- mongosh (installed automatically or via package manager)
```

Update the "Enhanced CLI Tools" table if applicable.

### CHANGELOG.md

Add to `[Unreleased]` section:

```markdown
### Added
- YourEngine support (versions 6.x, 7.x, 8.x)
  - Full container lifecycle (create, start, stop, delete)
  - Backup and restore
  - Clone containers
  - Enhanced CLI support (yourcli)
```

### TODO.md

Update engine status in the roadmap.

---

## Pass/Fail Criteria

An engine implementation is considered **complete** when ALL of the following pass:

### Required Checks

1. **Unit Tests**: `pnpm test:unit` passes on all 3 OSes
2. **Integration Tests**: `pnpm test:yourengine` passes (14+ tests)
3. **CLI E2E Tests**: `pnpm test:cli` includes and passes engine tests
4. **Linting**: `pnpm lint` passes with no errors
5. **Type Check**: `pnpm tsc --noEmit` passes

### CI Verification

1. GitHub Actions CI runs on all 3 OSes (ubuntu-latest, macos-latest, windows-latest)
2. If an OS is excluded, document the reason in ci.yml comments
3. CI success job includes your engine in its checks

### Manual Verification Checklist

Run these commands and verify they work:

```bash
# Create and start
pnpm start create mytest --engine yourengine --port 27050
pnpm start start mytest
pnpm start info mytest

# Connect and run SQL
pnpm start connect mytest
pnpm start run mytest --sql "db.test.insertOne({name: 'test'})"
pnpm start url mytest

# Backup and restore
pnpm start backup mytest --output ./backups/
pnpm start restore mytest ./backups/mytest-*.dump

# Clone
pnpm start stop mytest
pnpm start clone mytest mytest-clone
pnpm start start mytest-clone

# Edit
pnpm start stop mytest-clone
pnpm start edit mytest-clone --name mytest-renamed
pnpm start edit mytest-renamed --port 27051

# Cleanup
pnpm start delete mytest --force
pnpm start delete mytest-renamed --force

# List and engines
pnpm start list
pnpm start engines list
pnpm start deps check --engine yourengine
```

### Regression Check

Verify existing engines still work:

```bash
pnpm test:pg
pnpm test:mysql
pnpm test:sqlite
```

---

## Reference Implementations

Use these existing implementations as references:

### Server-Based Database with Downloadable Binaries

**PostgreSQL** (`engines/postgresql/`):
- Binary downloads from zonky.io (macOS/Linux) and EDB (Windows)
- Client tool installation via Homebrew on macOS
- Complex version resolution (major -> full version)
- Windows-specific command building

### Server-Based Database with System Binaries

**MySQL** (`engines/mysql/`):
- All binaries from system package managers
- Binary detection in PATH
- Works with both MySQL and MariaDB

### File-Based Database

**SQLite** (`engines/sqlite/`):
- No start/stop (file-based)
- Registry-based tracking
- File stored in project directories
- HTTP/HTTPS URL support for remote restore

---

## Troubleshooting

### Common Issues

**"Binary not found" errors:**
- Verify binary is in PATH
- Check config manager cache: `spindb config show`
- Refresh cache: `spindb config detect`

**Integration tests timing out:**
- Increase timeout in test file
- Check if database is slow to start
- Verify `waitForReady()` implementation

**Windows tests failing:**
- Check shell quoting
- Verify PATH includes binary location
- Use `getWindowsSpawnOptions()` for spawn calls

**CI failing on specific OS:**
- Check package manager availability
- Verify binary download URLs for that platform
- Check PATH updates in workflow
