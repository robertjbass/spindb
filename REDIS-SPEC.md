# Redis Engine Implementation Specification

This document provides the complete specification for adding Redis support to SpinDB. It is designed to be used by an LLM code agent to implement the feature without regressions.

## Table of Contents

1. [Overview](#overview)
2. [Redis vs Other Engines](#redis-vs-other-engines)
3. [Files to Create](#files-to-create)
4. [Files to Modify](#files-to-modify)
5. [Edge Cases and Special Handling](#edge-cases-and-special-handling)
6. [Test Requirements](#test-requirements)
7. [CI/CD Requirements](#cicd-requirements)
8. [Pass/Fail Criteria](#passfail-criteria)

---

## Overview

**Redis Type:** Server-based database with system binaries (like MySQL/MongoDB)
**Script Language:** Redis commands (not SQL, not JavaScript)
**Backup Mechanism:** RDB snapshots (primary) and AOF logs
**Enhanced CLI:** `iredis` (similar to pgcli/mycli)
**Port Range:** 6379-6400 (default: 6379)
**Connection Scheme:** `redis://`

### Key Differences from Existing Engines

| Aspect | PostgreSQL/MySQL | MongoDB | Redis |
|--------|-----------------|---------|-------|
| Script Language | SQL | JavaScript | Redis commands |
| Database Concept | Named databases | Named databases | Numbered (0-15) |
| Backup Format | pg_dump/mysqldump | mongodump | RDB/AOF |
| CLI Tool | psql/mysql | mongosh | redis-cli |
| Enhanced CLI | pgcli/mycli | - | iredis |

---

## Redis vs Other Engines

### 1. Database Model

Redis uses **numbered databases** (0-15 by default) instead of named databases:
- Default database is `0`
- Select database with `SELECT <n>` command
- No `CREATE DATABASE` equivalent
- For SpinDB, treat database `0` as the default and store the database number in container config

**Implementation Decision:** Store database number (0-15) in `container.database` as a string. Default to `"0"`.

### 2. Script Execution

Redis doesn't use SQL or JavaScript. It uses Redis commands:
- Inline: `redis-cli -h 127.0.0.1 -p 6379 SET foo bar`
- File: `redis-cli -h 127.0.0.1 -p 6379 < script.redis`

The `runScript` method will:
- For inline (`--sql`): Execute Redis command directly
- For file (`--file`): Pipe file contents to redis-cli

### 3. Backup and Restore

**RDB (Redis Database Backup):**
- Binary snapshot format
- Created with `BGSAVE` or `SAVE` commands
- File: `dump.rdb` in data directory
- Restore: Copy RDB file to data directory before starting

**AOF (Append Only File):**
- Change log format
- Larger but more durable
- Not used for SpinDB backups (RDB is preferred)

**Backup Implementation:**
```bash
# Trigger RDB save
redis-cli -h 127.0.0.1 -p <port> BGSAVE

# Wait for completion
redis-cli -h 127.0.0.1 -p <port> LASTSAVE

# Copy dump.rdb to output path
cp <data-dir>/dump.rdb <output-path>
```

### 4. Connection Testing

Use PING/PONG instead of SQL queries:
```bash
redis-cli -h 127.0.0.1 -p <port> PING
# Returns: PONG
```

### 5. Database Size

```bash
redis-cli -h 127.0.0.1 -p <port> INFO memory
# Parse "used_memory:" field
```

---

## Files to Create

### 1. `engines/redis/index.ts` (Main Engine Class)

```typescript
/**
 * Redis Engine implementation
 * Manages Redis database containers using system-installed Redis binaries
 */

import { spawn, exec, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir, writeFile, readFile, unlink, copyFile } from 'fs/promises'
import { join } from 'path'
import { BaseEngine } from '../base-engine'
import { paths } from '../../config/paths'
import { getEngineDefaults } from '../../config/defaults'
import { platformService, isWindows } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug, logWarning } from '../../core/error-handler'
import {
  getRedisServerPath,
  getRedisCliPath,
  detectInstalledVersions,
  getInstallInstructions,
} from './binary-detection'
import {
  detectBackupFormat as detectBackupFormatImpl,
  restoreBackup,
} from './restore'
import { createBackup } from './backup'
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

export * from './version-validator'
export * from './restore'

const execAsync = promisify(exec)
const ENGINE = 'redis'
const engineDef = getEngineDefaults(ENGINE)

/**
 * Build a redis-cli command for inline command execution
 */
export function buildRedisCliCommand(
  redisCliPath: string,
  port: number,
  command: string,
  options?: { database?: string },
): string {
  const db = options?.database || '0'
  if (isWindows()) {
    const escaped = command.replace(/"/g, '\\"')
    return `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${db} ${escaped}`
  } else {
    // For single commands, pass directly without quoting
    return `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${db} ${command}`
  }
}

export class RedisEngine extends BaseEngine {
  name = ENGINE
  displayName = 'Redis'
  defaultPort = engineDef.defaultPort
  supportedVersions = engineDef.supportedVersions

  // ... implement all BaseEngine abstract methods
  // See MongoDB implementation as reference pattern
}

export const redisEngine = new RedisEngine()
```

**Key Methods to Implement:**

- `fetchAvailableVersions()`: Detect installed Redis versions
- `getBinaryUrl()`: Throw error with install instructions (system binaries)
- `verifyBinary()`: Check if redis-server exists
- `isBinaryInstalled()`: Check if Redis is installed
- `ensureBinaries()`: Verify system installation
- `initDataDir()`: Create data directory (Redis auto-creates on start)
- `start()`: Start redis-server with config
- `stop()`: Graceful shutdown via redis-cli SHUTDOWN
- `status()`: PING/PONG check
- `getConnectionString()`: `redis://127.0.0.1:<port>/<db>`
- `connect()`: Spawn interactive redis-cli
- `createDatabase()`: No-op (Redis uses numbered DBs)
- `dropDatabase()`: FLUSHDB command
- `runScript()`: Execute Redis commands
- `getDatabaseSize()`: INFO memory parsing
- `detectBackupFormat()`: Detect RDB format
- `backup()`: BGSAVE + copy RDB file
- `restore()`: Copy RDB file + restart
- `dumpFromConnectionString()`: BGSAVE from remote + copy

### 2. `engines/redis/backup.ts`

```typescript
/**
 * Redis backup module
 * Uses BGSAVE to create RDB snapshots
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { copyFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { mkdir } from 'fs/promises'
import { getRedisCliPath } from './binary-detection'
import { buildRedisCliCommand } from './index'
import { logDebug } from '../../core/error-handler'
import { paths } from '../../config/paths'
import type { ContainerConfig, BackupOptions, BackupResult } from '../../types'

const execAsync = promisify(exec)

/**
 * Create a backup using BGSAVE
 *
 * For 'dump' format: Copy RDB file directly
 * For 'sql' format: Not applicable for Redis (RDB only)
 */
export async function createBackup(
  container: ContainerConfig,
  outputPath: string,
  options: BackupOptions,
): Promise<BackupResult> {
  const { port, name } = container

  const redisCli = await getRedisCliPath()
  if (!redisCli) {
    throw new Error(
      'redis-cli not found. Install Redis:\n' +
        '  macOS: brew install redis\n' +
        '  Ubuntu: sudo apt install redis-server\n'
    )
  }

  // Trigger background save
  const bgsaveCmd = buildRedisCliCommand(redisCli, port, 'BGSAVE')
  await execAsync(bgsaveCmd)

  // Wait for save to complete (poll LASTSAVE)
  let lastSave = 0
  const startTime = Date.now()
  const timeout = 60000 // 1 minute timeout

  while (Date.now() - startTime < timeout) {
    const lastsaveCmd = buildRedisCliCommand(redisCli, port, 'LASTSAVE')
    const { stdout } = await execAsync(lastsaveCmd)
    const currentSave = parseInt(stdout.trim(), 10)

    if (currentSave > lastSave && lastSave > 0) {
      break // Save completed
    }
    lastSave = currentSave
    await new Promise(r => setTimeout(r, 500))
  }

  // Copy RDB file
  const dataDir = paths.getContainerDataPath(name, { engine: 'redis' })
  const rdbPath = join(dataDir, 'dump.rdb')

  if (!existsSync(rdbPath)) {
    throw new Error('RDB file not found after BGSAVE')
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath)
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  await copyFile(rdbPath, outputPath)

  const stats = await stat(outputPath)

  return {
    path: outputPath,
    format: 'rdb',
    size: stats.size,
  }
}
```

### 3. `engines/redis/restore.ts`

```typescript
/**
 * Redis restore module
 * Restores from RDB backup files
 */

import { copyFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { logDebug } from '../../core/error-handler'
import type { BackupFormat, RestoreResult } from '../../types'

/**
 * Detect backup format from file
 * Redis backups are RDB files (binary format starting with "REDIS")
 */
export async function detectBackupFormat(filePath: string): Promise<BackupFormat> {
  const { readFile } = await import('fs/promises')

  try {
    const buffer = await readFile(filePath)
    const header = buffer.slice(0, 5).toString('ascii')

    if (header === 'REDIS') {
      return {
        format: 'rdb',
        description: 'Redis RDB snapshot',
        restoreCommand: 'Copy to data directory and restart Redis',
      }
    }
  } catch (error) {
    logDebug(`Error reading backup file: ${error}`)
  }

  // Check file extension as fallback
  if (filePath.endsWith('.rdb')) {
    return {
      format: 'rdb',
      description: 'Redis RDB snapshot (by extension)',
      restoreCommand: 'Copy to data directory and restart Redis',
    }
  }

  return {
    format: 'unknown',
    description: 'Unknown backup format',
    restoreCommand: 'Manual restore required',
  }
}

/**
 * Restore from RDB backup
 *
 * IMPORTANT: Redis must be stopped before restore
 * The RDB file is copied to the data directory, then Redis is restarted
 */
export async function restoreBackup(
  backupPath: string,
  options: {
    containerName: string
    dataDir?: string
  },
): Promise<RestoreResult> {
  const { containerName, dataDir } = options

  const targetDir = dataDir || paths.getContainerDataPath(containerName, { engine: 'redis' })
  const targetPath = join(targetDir, 'dump.rdb')

  // Copy backup to data directory
  await copyFile(backupPath, targetPath)

  return {
    format: 'rdb',
    stdout: `Restored RDB to ${targetPath}`,
    code: 0,
  }
}

/**
 * Parse Redis connection string
 * Format: redis://[user:password@]host:port[/database]
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  password?: string
} {
  const url = new URL(connectionString)

  return {
    host: url.hostname || '127.0.0.1',
    port: parseInt(url.port, 10) || 6379,
    database: url.pathname.slice(1) || '0',
    password: url.password || undefined,
  }
}
```

### 4. `engines/redis/binary-detection.ts`

```typescript
/**
 * Redis binary detection module
 * Finds Redis binaries installed on the system
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { platformService } from '../../core/platform-service'
import { configManager } from '../../core/config-manager'
import { logDebug } from '../../core/error-handler'

const execAsync = promisify(exec)

/**
 * Common Homebrew paths for Redis on macOS
 */
const HOMEBREW_REDIS_PATHS = [
  // ARM64 (Apple Silicon)
  '/opt/homebrew/opt/redis/bin',
  '/opt/homebrew/bin',
  // Intel
  '/usr/local/opt/redis/bin',
  '/usr/local/bin',
]

/**
 * Find redis-server binary
 */
export async function getRedisServerPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('redis-server')
  if (cached && existsSync(cached)) return cached

  // Check Homebrew paths
  for (const dir of HOMEBREW_REDIS_PATHS) {
    const path = `${dir}/redis-server`
    if (existsSync(path)) {
      logDebug(`Found redis-server at: ${path}`)
      return path
    }
  }

  // Check system PATH
  const systemPath = await platformService.findToolPath('redis-server')
  if (systemPath) {
    logDebug(`Found redis-server in PATH: ${systemPath}`)
    return systemPath
  }

  return null
}

/**
 * Find redis-cli binary
 */
export async function getRedisCliPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('redis-cli')
  if (cached && existsSync(cached)) return cached

  // Check Homebrew paths
  for (const dir of HOMEBREW_REDIS_PATHS) {
    const path = `${dir}/redis-cli`
    if (existsSync(path)) {
      logDebug(`Found redis-cli at: ${path}`)
      return path
    }
  }

  // Check system PATH
  const systemPath = await platformService.findToolPath('redis-cli')
  if (systemPath) {
    logDebug(`Found redis-cli in PATH: ${systemPath}`)
    return systemPath
  }

  return null
}

/**
 * Get Redis version from redis-server --version output
 * Example: "Redis server v=7.2.4 sha=00000000:0 malloc=libc bits=64..."
 */
export async function getRedisVersion(
  redisServerPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${redisServerPath}" --version`, {
      timeout: 5000,
    })
    // Parse version from "Redis server v=7.2.4" or "v=7.2.4"
    const match = stdout.match(/v=(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch (error) {
    logDebug(`Failed to get redis-server version: ${error}`)
    return null
  }
}

/**
 * Detect all installed Redis versions
 */
export async function detectInstalledVersions(): Promise<Record<string, string>> {
  const versions: Record<string, string> = {}

  const redisServer = await getRedisServerPath()
  if (redisServer) {
    const version = await getRedisVersion(redisServer)
    if (version) {
      const major = version.split('.')[0]
      versions[major] = version
    }
  }

  return versions
}

/**
 * Get installation instructions for Redis
 */
export function getInstallInstructions(): string {
  const { platform } = platformService.getPlatformInfo()

  switch (platform) {
    case 'darwin':
      return `Redis is not installed. Install with Homebrew:
  brew install redis

To start Redis as a service:
  brew services start redis`

    case 'linux':
      return `Redis is not installed. Install with your package manager:
  Ubuntu/Debian: sudo apt install redis-server
  CentOS/RHEL: sudo yum install redis
  Fedora: sudo dnf install redis
  Arch: sudo pacman -S redis`

    case 'win32':
      return `Redis is not installed. Install with Chocolatey:
  choco install redis-64

Or use Windows Subsystem for Linux (WSL) for better Redis support.
Redis on Windows is community-maintained and may have limitations.`

    default:
      return 'Redis is not installed. Visit https://redis.io/download'
  }
}
```

### 5. `engines/redis/version-validator.ts`

```typescript
/**
 * Redis version validation utilities
 */

/**
 * Parse Redis version string to components
 */
export function parseVersion(version: string): {
  major: number
  minor: number
  patch: number
} | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  }
}

/**
 * Check if version is compatible with SpinDB
 * Minimum supported version: 6.0.0
 */
export function isVersionSupported(version: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false

  return parsed.major >= 6
}

/**
 * Get major version from full version string
 */
export function getMajorVersion(version: string): string {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.major) : version
}
```

---

## Files to Modify

### 1. `types/index.ts`

**Add to Engine enum:**
```typescript
export enum Engine {
  PostgreSQL = 'postgresql',
  MySQL = 'mysql',
  SQLite = 'sqlite',
  MongoDB = 'mongodb',
  Redis = 'redis',  // ADD THIS
}
```

**Add to BinaryTool type:**
```typescript
export type BinaryTool =
  // ... existing tools
  // Redis tools
  | 'redis-server'
  | 'redis-cli'
  // Enhanced shells (add iredis)
  | 'iredis'
```

**Add to SpinDBConfig.binaries:**
```typescript
binaries: {
  // ... existing binaries
  // Redis tools
  'redis-server'?: BinaryConfig
  'redis-cli'?: BinaryConfig
  iredis?: BinaryConfig
}
```

### 2. `config/engine-defaults.ts`

**Add Redis defaults:**
```typescript
export const engineDefaults: Record<string, EngineDefaults> = {
  // ... existing engines

  redis: {
    defaultVersion: '7',
    defaultPort: 6379,
    portRange: { start: 6379, end: 6400 },
    supportedVersions: ['6', '7'],
    latestVersion: '7',
    superuser: '', // No auth by default
    connectionScheme: 'redis',
    logFileName: 'redis.log',
    pidFileName: 'redis.pid',
    dataSubdir: 'data',
    clientTools: ['redis-cli'],
    maxConnections: 0, // Not applicable
  },
}
```

### 3. `config/os-dependencies.ts`

**Add Redis dependencies:**
```typescript
const redisDependencies: EngineDependencies = {
  engine: 'redis',
  displayName: 'Redis',
  dependencies: [
    {
      name: 'redis-server',
      binary: 'redis-server',
      description: 'Redis server daemon',
      packages: {
        brew: { package: 'redis' },
        apt: { package: 'redis-server' },
        yum: { package: 'redis' },
        dnf: { package: 'redis' },
        pacman: { package: 'redis' },
        choco: { package: 'redis-64' },
        // winget: Redis not officially available
        scoop: { package: 'redis' },
      },
      manualInstall: {
        darwin: [
          'Install with Homebrew: brew install redis',
          'Start service: brew services start redis',
        ],
        linux: [
          'Ubuntu/Debian: sudo apt install redis-server',
          'CentOS/RHEL: sudo yum install redis',
          'Fedora: sudo dnf install redis',
          'Arch: sudo pacman -S redis',
        ],
        win32: [
          'Using Chocolatey: choco install redis-64',
          'Using Scoop: scoop install redis',
          'Note: Consider using WSL for better Redis support on Windows',
        ],
      },
    },
    {
      name: 'redis-cli',
      binary: 'redis-cli',
      description: 'Redis command-line interface',
      packages: {
        brew: { package: 'redis' },
        apt: { package: 'redis-tools' },
        yum: { package: 'redis' },
        dnf: { package: 'redis' },
        pacman: { package: 'redis' },
        choco: { package: 'redis-64' },
        scoop: { package: 'redis' },
      },
      manualInstall: {
        darwin: ['Install with Homebrew: brew install redis'],
        linux: [
          'Ubuntu/Debian: sudo apt install redis-tools',
          'CentOS/RHEL: sudo yum install redis',
        ],
        win32: ['Using Chocolatey: choco install redis-64'],
      },
    },
  ],
}

// ADD to registry
export const engineDependencies: EngineDependencies[] = [
  postgresqlDependencies,
  mysqlDependencies,
  sqliteDependencies,
  mongodbDependencies,
  redisDependencies,  // ADD THIS
]
```

**Add iredis enhanced CLI:**
```typescript
/**
 * iredis - Redis CLI with auto-completion and syntax highlighting
 * https://github.com/laixintao/iredis
 */
export const iredisDependency: Dependency = {
  name: 'iredis',
  binary: 'iredis',
  description: 'Redis CLI with auto-completion and syntax highlighting',
  packages: {
    brew: { package: 'iredis' },
    // Most platforms use pip install
  },
  manualInstall: {
    darwin: [
      'Install with Homebrew: brew install iredis',
      'Or with pip: pip install iredis',
    ],
    linux: ['Install with pip: pip install iredis'],
    win32: ['Install with pip: pip install iredis'],
  },
}
```

### 4. `engines/index.ts`

**Register Redis engine:**
```typescript
import { redisEngine } from './redis'

export const engines: Record<string, BaseEngine> = {
  // ... existing engines

  // Redis and aliases
  redis: redisEngine,
}
```

### 5. `cli/commands/menu/sql-handlers.ts`

**Update for Redis commands (not SQL):**
```typescript
// Around line 60, update the script type detection:
const isMongoDB = config.engine === 'mongodb'
const isRedis = config.engine === 'redis'  // ADD THIS
const scriptType = isRedis ? 'Command' : (isMongoDB ? 'Script' : 'SQL')
const scriptTypeLower = isRedis ? 'command' : (isMongoDB ? 'script' : 'SQL')
```

### 6. `cli/commands/create.ts`

**Add Redis connection string detection:**
```typescript
function detectLocationType(location: string): {
  type: 'connection' | 'file' | 'not_found'
  inferredEngine?: Engine
} {
  // ... existing checks

  if (location.startsWith('redis://')) {
    return { type: 'connection', inferredEngine: Engine.Redis }
  }

  // ... rest of function
}
```

### 7. `tests/integration/helpers.ts`

**Add Redis test ports:**
```typescript
export const TEST_PORTS = {
  postgresql: { base: 5454, clone: 5456, renamed: 5455 },
  mysql: { base: 3333, clone: 3335, renamed: 3334 },
  mongodb: { base: 27050, clone: 27052, renamed: 27051 },
  redis: { base: 6399, clone: 6401, renamed: 6400 },  // ADD THIS
}
```

**Update helper functions for Redis:**
```typescript
export async function executeSQL(
  engine: Engine,
  port: number,
  database: string,
  sql: string,
): Promise<{ stdout: string; stderr: string }> {
  // ... existing engines

  if (engine === Engine.Redis) {
    const engineImpl = getEngine(engine)
    const redisCliPath = await engineImpl.getRedisCliPath().catch(() => 'redis-cli')
    const cmd = `"${redisCliPath}" -h 127.0.0.1 -p ${port} -n ${database} ${sql}`
    return execAsync(cmd)
  }

  // ... rest
}

export async function waitForReady(
  engine: Engine,
  port: number,
  timeoutMs = 30000,
): Promise<boolean> {
  // ... existing code

  if (engine === Engine.Redis) {
    const engineImpl = getEngine(engine)
    const redisCliPath = await engineImpl.getRedisCliPath().catch(() => 'redis-cli')
    const cmd = `"${redisCliPath}" -h 127.0.0.1 -p ${port} PING`
    await execAsync(cmd, { timeout: 5000 })
    return true
  }

  // ... rest
}

export function getConnectionString(
  engine: Engine,
  port: number,
  database: string,
): string {
  // ... existing

  if (engine === Engine.Redis) {
    return `redis://127.0.0.1:${port}/${database}`
  }

  // ... rest
}
```

### 8. `package.json`

**Add test script:**
```json
{
  "scripts": {
    "test:redis": "node --import tsx --test --experimental-test-isolation=none tests/integration/redis.test.ts"
  }
}
```

---

## Edge Cases and Special Handling

### 1. Redis "Databases" Are Numbered (0-15)

Unlike other engines with named databases:
- Store database number as string in `container.database` (e.g., "0")
- `createDatabase()` is a no-op (databases always exist)
- `dropDatabase()` uses `FLUSHDB` to clear the database
- Validate database is 0-15

### 2. Menu Language Updates

The following files/strings need updating to say "Command" instead of "SQL" for Redis:

- `cli/commands/menu/sql-handlers.ts` - "Run SQL file" → "Run command file" for Redis
- `cli/commands/run.ts` - `--sql` option description should mention Redis commands
- Any prompts mentioning "SQL"

### 3. Backup Format Detection

Redis uses RDB files that start with "REDIS" magic bytes. The backup format detection should:
1. Check for "REDIS" header bytes
2. Fall back to `.rdb` extension check
3. Return appropriate format description

### 4. Redis Server Start/Stop

**Start:**
```bash
redis-server --port <port> --dir <data-dir> --daemonize yes --logfile <log-file> --pidfile <pid-file>
```

**Stop:**
```bash
redis-cli -h 127.0.0.1 -p <port> SHUTDOWN NOSAVE
```

Note: `SHUTDOWN NOSAVE` skips saving to disk. Use `SHUTDOWN SAVE` to save before shutdown.

### 5. Windows Considerations

Redis on Windows:
- Use `redis-64` from Chocolatey (community port)
- May have limitations compared to Linux/macOS
- Consider warning users about Windows limitations
- PATH handling for Chocolatey installations

### 6. No Remote Dump for Redis

`dumpFromConnectionString` for Redis should:
1. Connect to remote Redis
2. Trigger BGSAVE
3. Wait for completion
4. This requires network access to remote server's dump.rdb file, which isn't practical

**Alternative approach:** For `--from redis://...`, copy data using DUMP/RESTORE commands:
```bash
# For each key in remote
redis-cli -h remote DUMP key | redis-cli -h local RESTORE key 0 ...
```

Or document that `--from` with Redis connection strings isn't fully supported.

### 7. Enhanced CLI (iredis)

Add support for `--iredis` flag in connect command:
- Check if iredis is installed
- Offer to install if not
- Add to `os-dependencies.ts`

---

## Test Requirements

### Test Fixtures

Create `tests/fixtures/redis/seeds/sample-db.redis`:
```redis
# Redis seed script for integration tests
# Creates 5 test entries

SET user:1 '{"id":1,"name":"Alice","email":"alice@example.com"}'
SET user:2 '{"id":2,"name":"Bob","email":"bob@example.com"}'
SET user:3 '{"id":3,"name":"Charlie","email":"charlie@example.com"}'
SET user:4 '{"id":4,"name":"Diana","email":"diana@example.com"}'
SET user:5 '{"id":5,"name":"Eve","email":"eve@example.com"}'

# Set a counter for verification
SET user_count 5
```

### Integration Tests

Create `tests/integration/redis.test.ts` with **14+ tests**:

1. `should create container without starting (--no-start)`
2. `should start the container`
3. `should seed the database with test data using runScript`
4. `should create a new container from connection string (dump/restore)`
5. `should verify restored data matches source`
6. `should stop and delete the restored container`
7. `should modify data using runScript inline command`
8. `should stop, rename container, and change port`
9. `should verify data persists after rename`
10. `should handle port conflict gracefully`
11. `should show warning when starting already running container`
12. `should show warning when stopping already stopped container`
13. `should delete container with --force`
14. `should have no test containers remaining`

### Unit Tests

Create `tests/unit/redis-*.test.ts`:

1. **redis-version-validator.test.ts**
   - Test `parseVersion()` with valid/invalid versions
   - Test `isVersionSupported()` for 6.x, 7.x
   - Test `getMajorVersion()`

2. **redis-binary-detection.test.ts** (if mocking is possible)
   - Test path detection logic
   - Test version parsing from output

---

## CI/CD Requirements

### Add to `.github/workflows/ci.yml`

```yaml
# ============================================
# Redis Integration Tests
# ============================================
test-redis:
  name: Redis (${{ matrix.os }})
  runs-on: ${{ matrix.os }}
  strategy:
    fail-fast: false
    matrix:
      # Skip Windows initially - Redis Windows support is limited
      os: [ubuntu-latest, macos-latest]
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

    # Install Redis on macOS via Homebrew
    - name: Install Redis (macOS)
      if: runner.os == 'macOS'
      run: brew install redis

    # Install Redis on Ubuntu
    - name: Install Redis (Linux)
      if: runner.os == 'Linux'
      run: sudo apt-get update && sudo apt-get install -y redis-server redis-tools

    - name: Show installed engines
      run: pnpm start engines list

    - name: Run Redis integration tests
      run: pnpm test:redis
      timeout-minutes: 15
```

### Update CI Success Job

```yaml
ci-success:
  name: CI Success
  runs-on: ubuntu-latest
  needs:
    [
      unit-tests,
      test-postgresql,
      test-mysql,
      test-sqlite,
      test-mongodb,
      test-redis,      # ADD THIS
      test-cli-e2e,
      lint,
    ]
  if: always()
  steps:
    - name: Check all jobs passed
      run: |
        # ... existing checks
        if [ "${{ needs.test-redis.result }}" != "success" ]; then
          echo "Redis tests failed"
          exit 1
        fi
        echo "All CI checks passed!"
```

---

## Pass/Fail Criteria

### Required for Completion

#### 1. All Tests Pass
- [ ] `pnpm test:unit` passes on all 3 OSes
- [ ] `pnpm test:redis` passes (14+ tests) on macOS and Linux
- [ ] `pnpm test:pg` still passes (no regression)
- [ ] `pnpm test:mysql` still passes (no regression)
- [ ] `pnpm test:sqlite` still passes (no regression)
- [ ] `pnpm test:mongodb` still passes (no regression)
- [ ] `pnpm test:cli` still passes (no regression)

#### 2. Linting and Type Check
- [ ] `pnpm lint` passes with no errors
- [ ] `tsc --noEmit` passes

#### 3. Manual Verification
Run these commands and verify they work:

```bash
# Create and start
pnpm start create myredis --engine redis --port 6399
pnpm start start myredis
pnpm start info myredis

# Connect and run commands
pnpm start connect myredis
pnpm start run myredis --sql "SET foo bar"
pnpm start run myredis --sql "GET foo"
pnpm start url myredis

# Backup and restore
pnpm start backup myredis --output ./backups/
pnpm start restore myredis ./backups/myredis-*.rdb

# Clone
pnpm start stop myredis
pnpm start clone myredis myredis-clone
pnpm start start myredis-clone

# Edit
pnpm start stop myredis-clone
pnpm start edit myredis-clone --name myredis-renamed
pnpm start edit myredis-renamed --port 6400

# Cleanup
pnpm start delete myredis --force
pnpm start delete myredis-renamed --force

# Engine management
pnpm start engines list
pnpm start deps check --engine redis
```

#### 4. Documentation Updated
- [ ] README.md - Add Redis to supported engines table
- [ ] CHANGELOG.md - Add to unreleased section
- [ ] TODO.md - Mark Redis as completed
- [ ] ENGINES.md - Move Redis from "Planned" to "Supported"

---

## Summary Checklist

### Files to Create (5)
- [ ] `engines/redis/index.ts` - Main engine class
- [ ] `engines/redis/backup.ts` - RDB backup wrapper
- [ ] `engines/redis/restore.ts` - Restore logic
- [ ] `engines/redis/version-validator.ts` - Version parsing
- [ ] `engines/redis/binary-detection.ts` - System binary detection

### Files to Modify (12)
- [ ] `types/index.ts` - Add Engine.Redis, BinaryTool types
- [ ] `config/engine-defaults.ts` - Add Redis defaults
- [ ] `config/os-dependencies.ts` - Add Redis dependencies + iredis
- [ ] `engines/index.ts` - Register Redis engine
- [ ] `cli/commands/menu/sql-handlers.ts` - Update language for Redis
- [ ] `cli/commands/create.ts` - Add redis:// detection
- [ ] `cli/commands/connect.ts` - Add --iredis flag
- [ ] `tests/integration/helpers.ts` - Add Redis test helpers
- [ ] `package.json` - Add test:redis script
- [ ] `.github/workflows/ci.yml` - Add Redis test job
- [ ] `README.md` - Document Redis support
- [ ] `CHANGELOG.md` - Add to unreleased

### Test Files to Create (2+)
- [ ] `tests/fixtures/redis/seeds/sample-db.redis`
- [ ] `tests/integration/redis.test.ts`
- [ ] `tests/unit/redis-version-validator.test.ts`

### Key Implementation Notes

1. **Use MongoDB as reference** - Similar system-binary pattern
2. **Script language is Redis commands** - Not SQL or JavaScript
3. **Numbered databases (0-15)** - Store as string in config
4. **RDB for backups** - Binary format, starts with "REDIS"
5. **PING/PONG for status** - Connection testing
6. **Update menu language** - "Command" not "SQL" for Redis
7. **Windows limited support** - Consider skipping Windows in CI initially

---

## References

- MongoDB engine implementation: `engines/mongodb/index.ts`
- BaseEngine abstract class: `engines/base-engine.ts`
- FEATURE.md: Complete engine implementation guide
- Redis documentation: https://redis.io/docs/
