# FerretDB Implementation Guide

## What is FerretDB?

FerretDB is an open-source MongoDB alternative that uses PostgreSQL as its storage backend. It acts as a **stateless proxy** that:

- Accepts MongoDB wire protocol connections (default port 27017)
- Translates MongoDB queries to SQL
- Stores documents as JSONB in PostgreSQL tables
- Maps: databases → schemas, collections → tables, documents → JSONB rows

**Key insight:** FerretDB requires TWO separate binaries - they are NOT bundled together:
1. `ferretdb` - The proxy server (Go binary)
2. `postgres` - The storage backend (already in SpinDB)

## Architecture Decision: Embedded PostgreSQL

**Recommended approach:** Each FerretDB container manages its own embedded PostgreSQL data directory.

### Why This Approach

| Option | Pros | Cons |
|--------|------|------|
| **Embedded (recommended)** | Clean isolation, simple mental model, no cross-container dependencies | Slightly more disk usage |
| Shared PostgreSQL container | Less disk usage | Complex dependency management, harder cleanup |
| Hidden PostgreSQL container | Separation of concerns | User confusion, orphan cleanup issues |

### How It Works

```
~/.spindb/containers/ferretdb/myapp/
├── container.json          # FerretDB config (includes backendVersion)
├── data/                   # FerretDB state (if any)
├── pg_data/                # PostgreSQL data directory (embedded)
├── logs/
│   ├── ferretdb.log
│   └── postgres.log
└── ferretdb.pid
```

Binary reuse (no duplication):
```
~/.spindb/bin/ferretdb-2.0.0-darwin-arm64/bin/ferretdb     # FerretDB binary
~/.spindb/bin/postgresql-18.1.0-darwin-arm64/bin/postgres  # Shared with PostgreSQL engine
```

## Container Configuration

Extended `ContainerConfig` for composite engines:

```ts
type ContainerConfig = {
  name: string
  engine: 'ferretdb'
  version: string           // FerretDB version (e.g., "2.0")
  port: number              // MongoDB wire protocol port (27017)
  database: string          // Primary database name
  databases?: string[]
  created: string
  status: 'created' | 'running' | 'stopped'

  // FerretDB-specific fields
  backendVersion?: string   // PostgreSQL version (e.g., "18")
  backendPort?: number      // PostgreSQL port (auto-assigned, internal use)
}
```

## Lifecycle Management

### Create

```ts
async create(name: string, options: CreateOptions): Promise<ContainerConfig> {
  // 1. Create container directory structure
  // 2. Ensure PostgreSQL binaries are downloaded (reuse existing)
  // 3. Ensure FerretDB binary is downloaded
  // 4. Initialize PostgreSQL data directory in pg_data/
  // 5. Create container.json with backendVersion
}
```

### Start

```ts
async start(container: ContainerConfig): Promise<{ port, connectionString }> {
  // 1. Load saved backendPort from container.json, or allocate a new one
  //    - If saved backendPort exists, check if it's available
  //    - If not available, allocate a new port and update container.json
  // 2. Start PostgreSQL on backend port, pointing to pg_data/
  // 3. Wait for PostgreSQL to be ready with health check
  //    - On failure: stop PostgreSQL, reset status to 'stopped', clear backendPort, throw error
  // 4. Start FerretDB with --postgresql-url=postgres://localhost:{backendPort}/ferretdb
  //    - On failure: stop PostgreSQL, reset status to 'stopped', throw error
  // 5. Verify FerretDB can connect to PostgreSQL
  //    - On failure: stop FerretDB, stop PostgreSQL, reset status to 'stopped', throw error
  // 6. Update container status to 'running' and persist backendPort to container.json
  // 7. Return MongoDB connection string: mongodb://localhost:{port}

  let pgStarted = false
  let ferretStarted = false

  try {
    // Load or allocate backendPort
    let backendPort = container.backendPort
    if (!backendPort || !await portManager.isPortAvailable(backendPort)) {
      backendPort = await portManager.getAvailablePort(54320)
    }
    // Persist backendPort immediately
    container.backendPort = backendPort
    await this.saveContainerConfig(container)

    // Start PostgreSQL
    await this.startPostgreSQL(container, backendPort)
    pgStarted = true

    // Health check PostgreSQL
    if (!await this.waitForPostgreSQLReady(backendPort)) {
      throw new Error('PostgreSQL failed health check')
    }

    // Start FerretDB
    await this.startFerretDB(container, backendPort)
    ferretStarted = true

    // Verify FerretDB can connect
    if (!await this.verifyFerretDBConnection(container.port)) {
      throw new Error('FerretDB failed to connect to PostgreSQL backend')
    }

    container.status = 'running'
    await this.saveContainerConfig(container)
    return { port: container.port, connectionString: `mongodb://localhost:${container.port}` }
  } catch (error) {
    // Rollback: stop any started processes
    if (ferretStarted) {
      await this.stopFerretDB(container).catch(() => {})
    }
    if (pgStarted) {
      await this.stopPostgreSQL(container).catch(() => {})
    }
    container.status = 'stopped'
    await this.saveContainerConfig(container)
    throw error
  }
}
```

### Stop

```ts
async stop(container: ContainerConfig): Promise<void> {
  // 1. Stop FerretDB process (graceful SIGTERM)
  // 2. Stop PostgreSQL process (pg_ctl stop)
  // 3. Update container status
}
```

### Status

```ts
type ComponentStatus = {
  running: boolean
  pid?: number
  error?: string
}

type StatusResult = {
  status: 'running' | 'stopped'
  components: {
    ferretdb: ComponentStatus
    postgresql: ComponentStatus
  }
}

async status(container: ContainerConfig): Promise<StatusResult> {
  // Check FerretDB process (from PID file)
  const ferretdbStatus = await this.getFerretDBStatus(container)

  // Check PostgreSQL process (pg_ctl status on pg_data/)
  const postgresStatus = await this.getPostgreSQLStatus(container)

  // Overall status is 'running' only if BOTH components are running
  const overallStatus = ferretdbStatus.running && postgresStatus.running
    ? 'running'
    : 'stopped'

  return {
    status: overallStatus,
    components: {
      ferretdb: ferretdbStatus,
      postgresql: postgresStatus,
    },
  }
}

// Helper: Check FerretDB status from PID file
private async getFerretDBStatus(container: ContainerConfig): Promise<ComponentStatus> {
  const pidFile = paths.getContainerPath(container.name, { engine: 'ferretdb' }) + '/ferretdb.pid'
  try {
    const pid = parseInt(await readFile(pidFile, 'utf-8'), 10)
    const running = await this.isProcessRunning(pid)
    return { running, pid: running ? pid : undefined }
  } catch {
    return { running: false, error: 'PID file not found' }
  }
}

// Helper: Check PostgreSQL status via pg_ctl
private async getPostgreSQLStatus(container: ContainerConfig): Promise<ComponentStatus> {
  const pgDataDir = paths.getContainerPath(container.name, { engine: 'ferretdb' }) + '/pg_data'
  try {
    const { stdout } = await execAsync(`${await this.getPgCtlPath()} status -D "${pgDataDir}"`)
    const pidMatch = stdout.match(/PID: (\d+)/)
    return { running: true, pid: pidMatch ? parseInt(pidMatch[1], 10) : undefined }
  } catch (error) {
    return { running: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
```

## Port Management

Each FerretDB container uses TWO ports:
1. **External port** (user-facing): MongoDB wire protocol (default 27017)
2. **Internal port** (hidden): PostgreSQL backend (auto-assigned from high range, e.g., 54320+)

```ts
const ferretdbPort = await portManager.getAvailablePort(27017)  // User sees this
const backendPort = await portManager.getAvailablePort(54320)   // Internal only

// backendPort persistence and revalidation:
// - On create: allocate and save to container.json immediately
// - On start: read from container.json, verify availability, reallocate if needed
// - On stop/delete: call portManager.releasePort(backendPort) to free the port
// - Always read backendPort from ContainerConfig, never hardcode
```

## Backup & Restore

**Decision:** Use PostgreSQL native backup (pg_dump) on the embedded PostgreSQL. No MongoDB tools needed.

### Format Options

| Format | Extension | Use Case |
|--------|-----------|----------|
| PostgreSQL dump | `.sql` | Human-readable, portable |
| PostgreSQL binary | `.dump` | Faster for large datasets |

### Implementation

**Precondition:** Both backup and restore require the container to be running. The embedded PostgreSQL must be accepting connections on `backendPort`. If the container is stopped, the operation will fail with a clear error message instructing the user to start the container first.

```ts
// Backup: use pg_dump on embedded PostgreSQL
async backup(container, outputPath, options): Promise<BackupResult> {
  // Require container to be running
  const status = await this.status(container)
  if (status.status !== 'running') {
    throw new Error(
      `Cannot backup stopped container "${container.name}". ` +
      `Run "spindb start ${container.name}" first.`
    )
  }
  if (!status.components.postgresql.running) {
    throw new Error(
      `PostgreSQL backend is not running for container "${container.name}". ` +
      `FerretDB status: ${status.components.ferretdb.running ? 'running' : 'stopped'}. ` +
      `Try restarting the container.`
    )
  }

  const pgDumpPath = await this.getPgDumpPath()
  const database = container.backendDatabase || 'ferretdb'
  await execAsync(`${pgDumpPath} -h 127.0.0.1 -p ${container.backendPort} -U postgres -F c -f "${outputPath}" ${database}`)
}

// Restore: use pg_restore on embedded PostgreSQL
async restore(container, backupPath, options): Promise<RestoreResult> {
  // Require container to be running
  const status = await this.status(container)
  if (status.status !== 'running') {
    throw new Error(
      `Cannot restore to stopped container "${container.name}". ` +
      `Run "spindb start ${container.name}" first.`
    )
  }
  if (!status.components.postgresql.running) {
    throw new Error(
      `PostgreSQL backend is not running for container "${container.name}". ` +
      `Try restarting the container.`
    )
  }

  const pgRestorePath = await this.getPgRestorePath()
  const database = container.backendDatabase || 'ferretdb'
  await execAsync(`${pgRestorePath} -h 127.0.0.1 -p ${container.backendPort} -U postgres -d ${database} "${backupPath}"`)
}
```

**Why not MongoDB tools?** FerretDB stores data in PostgreSQL. Using pg_dump:
- No additional dependencies (reuses existing PostgreSQL binaries)
- Already battle-tested in SpinDB
- No licensing concerns (PostgreSQL is BSD-licensed)

## Version Compatibility

**Decision:** FerretDB 2.x only. Requires DocumentDB extension.

### FerretDB Versions to Support

| FerretDB | PostgreSQL+DocumentDB Required | Notes |
|----------|--------------------------------|-------|
| 2.0+ | postgresql-documentdb 17+ | DocumentDB extension required |

FerretDB 1.x is NOT supported (uses plain JSONB, lower performance, being phased out by FerretDB team).

### hostdb Binary Requirements

Before implementing FerretDB in SpinDB, hostdb needs a new `postgresql-documentdb` engine:

```json
// hostdb releases.json structure
{
  "postgresql-documentdb": {
    "17.x.x": {
      "darwin-arm64": "postgresql-documentdb-17.x.x-darwin-arm64.tar.gz",
      "darwin-x64": "postgresql-documentdb-17.x.x-darwin-x64.tar.gz",
      "linux-x64": "postgresql-documentdb-17.x.x-linux-x64.tar.gz"
    }
  },
  "ferretdb": {
    "2.x.x": {
      "darwin-arm64": "ferretdb-2.x.x-darwin-arm64.tar.gz",
      ...
    }
  }
}
```

The `postgresql-documentdb` build must include:
- PostgreSQL 17+ binaries
- DocumentDB extension compiled (`pg_documentdb.so`, `pg_documentdb_core.so`)
- pg_cron extension
- tsm_system_rows extension
- vector (pgvector) extension
- postgis extension
- rum extension
- Proper `postgresql.conf.sample` with `shared_preload_libraries` pre-configured

### Version Map

```ts
// engines/ferretdb/version-maps.ts
export const FERRETDB_VERSION_MAP: Record<string, string> = {
  '2': '2.7.0',  // Latest stable (from hostdb)
}

// Maps FerretDB version to required postgresql-documentdb version
export const FERRETDB_PG_DOCUMENTDB_COMPAT: Record<string, string> = {
  '2.7.0': '17-0.107.0',  // Current hostdb release
}
```

## Implementation Checklist

### Phase 1: hostdb - Build Binaries (COMPLETE)

**FerretDB binary:** ✅
- [x] Add FerretDB to hostdb releases.json
- [x] Build FerretDB 2.7.0 binaries for all platforms (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64)
- [x] Bundle mongosh and database-tools

**PostgreSQL+DocumentDB binary:** ✅
- [x] Create `postgresql-documentdb` engine in hostdb
- [x] Build PostgreSQL 17 with DocumentDB 0.107.0 extension
- [x] Include extensions: pg_cron 1.6.4, pgvector 0.8.0, PostGIS 3.5.1, rum 1.3.14
- [x] Pre-configure `shared_preload_libraries` in postgresql.conf.sample
- [x] Build for darwin-arm64, darwin-x64, linux-x64, linux-arm64
- [x] **Note:** Windows (win32-x64) not available - see [Windows Limitations](#windows-limitations)

**hostdb releases (use these):**
- [ferretdb-2.7.0](https://github.com/robertjbass/hostdb/releases/tag/ferretdb-2.7.0) - All platforms
- [postgresql-documentdb-17-0.107.0](https://github.com/robertjbass/hostdb/releases/tag/postgresql-documentdb-17-0.107.0) - No Windows

**Upstream references:**
- [FerretDB releases](https://github.com/FerretDB/FerretDB/releases)
- [DocumentDB releases](https://github.com/FerretDB/documentdb/releases)
- [FerretDB Docker images](https://github.com/orgs/FerretDB/packages/container/package/postgres-documentdb) (reference for build config)

### Phase 2: SpinDB Type System
- [ ] Add `FerretDB = 'ferretdb'` to `Engine` enum in `types/index.ts`
- [ ] Add `'ferretdb'` to `ALL_ENGINES` array
- [ ] Add `'ferretdb'` tool to `BinaryTool` type
- [ ] Add `'ferretdb'` to `KNOWN_BINARY_TOOLS` in `core/dependency-manager.ts`

### Phase 3: SpinDB Configuration
- [ ] Add ferretdb entry to `config/engines.json`
- [ ] Add defaults to `config/engine-defaults.ts` (port 27017, etc.)
- [ ] Create `engines/ferretdb/version-maps.ts`

### Phase 4: SpinDB Engine Implementation
- [ ] Create `engines/ferretdb/index.ts` (main engine class)
- [ ] Create `engines/ferretdb/binary-manager.ts` (manages both ferretdb + postgresql-documentdb binaries)
- [ ] Create `engines/ferretdb/backup.ts` (delegates to pg_dump)
- [ ] Create `engines/ferretdb/restore.ts` (delegates to pg_restore)
- [ ] Implement embedded PostgreSQL management:
  - [ ] Initialize pg_data directory with DocumentDB extensions
  - [ ] Configure `postgresql.conf` with `shared_preload_libraries`
  - [ ] Start/stop PostgreSQL backend on internal port
- [ ] Handle two-process lifecycle (start/stop both FerretDB + PostgreSQL)

### Phase 5: SpinDB Integration
- [ ] Register engine in `engines/index.ts`
- [ ] Update CLI commands to support ferretdb
- [ ] Add ferretdb to interactive menus
- [ ] Support `spindb connect` with mongosh (if user has it installed)

### Phase 6: Testing
- [ ] Unit tests for FerretDB engine
- [ ] Integration tests (create, start, stop, backup, restore)
- [ ] Test with mongosh client (optional, not required)
- [ ] Add CI cache step in `.github/workflows/ci.yml`

### Phase 7: Documentation
- [ ] Update README.md
- [ ] Update CLAUDE.md tables
- [ ] Update ENGINES.md
- [ ] Add CHANGELOG entry

## Decisions Made

1. **FerretDB version:** 2.x only (requires DocumentDB extension)
2. **Backup strategy:** PostgreSQL native (pg_dump), no MongoDB tools required
3. **Architecture:** Embedded PostgreSQL per container (isolated, simple mental model)
4. **Windows support:** PostgreSQL+DocumentDB will not be available on Windows initially due to extension build complexity (PostGIS, rum dependencies). FerretDB binary itself supports Windows but cannot function without the backend. See [Stretch Goals: Windows Support](#stretch-goals-windows-support) for future plans.

## Resolved Questions

### 1. Connection strings (`spindb url`)

**Decision:** Return MongoDB endpoint by default, with `--backend` flag for PostgreSQL access.

```ts
// Default: FerretDB endpoint
spindb url myferret
// → mongodb://localhost:27017

// With --backend flag: direct PostgreSQL access (for debugging)
spindb url myferret --backend
// → postgresql://localhost:54320/ferretdb
```

### 2. Interactive shell (`spindb connect`)

**Decision:** Detect mongosh in PATH; if not found, print a helpful message and exit. Do not bundle mongosh.

```ts
async function handleConnectCommand(containerName: string): Promise<void> {
  const container = await containerManager.getConfig(containerName)
  if (!container) throw new Error(`Container "${containerName}" not found`)

  const mongoshPath = await findMongoshInPath()
  if (!mongoshPath) {
    console.log('mongosh not found in PATH.')
    console.log('Install mongosh to use interactive shell:')
    console.log('  https://www.mongodb.com/docs/mongodb-shell/install/')
    return
  }

  const connectionString = `mongodb://localhost:${container.port}`
  await spawnInteractive(mongoshPath, [connectionString])
}

async function findMongoshInPath(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(process.platform === 'win32' ? 'where mongosh' : 'which mongosh')
    return stdout.trim() || null
  } catch {
    return null
  }
}
```

## Binary Dependency Management

### Preventing PostgreSQL Uninstall When FerretDB Depends On It

FerretDB containers share PostgreSQL binaries with standalone PostgreSQL containers. This creates a dependency that must be handled when users try to uninstall PostgreSQL.

**Scenario:** User has:
- FerretDB container "myferret" using PostgreSQL 17 binaries
- No standalone PostgreSQL containers
- User runs `spindb uninstall postgresql` or deletes PostgreSQL binaries

**Required behavior:**

```ts
// In uninstall/delete binary logic
async function canDeletePostgreSQLBinaries(version: string): Promise<{ allowed: boolean; blockers: string[] }> {
  const blockers: string[] = []

  // Check standalone PostgreSQL containers
  const pgContainers = await getContainersByEngine('postgresql')
  for (const c of pgContainers) {
    if (c.version === version) {
      blockers.push(`PostgreSQL container "${c.name}" uses version ${version}`)
    }
  }

  // Check FerretDB containers that depend on this PostgreSQL version
  const ferretContainers = await getContainersByEngine('ferretdb')
  for (const c of ferretContainers) {
    if (c.backendVersion === version) {
      blockers.push(`FerretDB container "${c.name}" requires PostgreSQL ${version} as backend`)
    }
  }

  return { allowed: blockers.length === 0, blockers }
}
```

**User-facing message:**

```
Cannot uninstall PostgreSQL 17 - the following containers depend on it:

  • FerretDB container "myferret" requires PostgreSQL 17 as backend
  • FerretDB container "analytics" requires PostgreSQL 17 as backend

To uninstall PostgreSQL 17, first delete these containers:
  spindb delete myferret
  spindb delete analytics
```

**Implementation notes:**
- This check should happen in the binary manager, not the engine
- The `backendVersion` field in FerretDB's container.json makes this query straightforward
- Same pattern applies if we add other composite engines in the future

---

## hostdb Build Guide for FerretDB

This section provides detailed guidance for building FerretDB binaries in hostdb.

### FerretDB Binary (Simple)

FerretDB is a single Go binary with no runtime dependencies.

**Build approach:**
```bash
# Clone and build
git clone https://github.com/FerretDB/FerretDB.git
cd FerretDB
git checkout v2.7.0

# Build for target platform
GOOS=darwin GOARCH=arm64 go build -o ferretdb ./cmd/ferretdb
```

**Package structure:**
```
ferretdb-2.7.0-darwin-arm64/
└── bin/
    └── ferretdb          # Single binary (~30MB)
```

**Verification:**
```bash
./ferretdb --version
# FerretDB v2.7.0
```

### PostgreSQL+DocumentDB Binary (Complex)

This is the challenging part. DocumentDB is a PostgreSQL extension that must be compiled against the exact PostgreSQL version.

**Option A: Build from source (recommended for hostdb)**

```bash
# 1. Build PostgreSQL 17 first (or use existing hostdb PostgreSQL build)
# 2. Clone DocumentDB
git clone https://github.com/FerretDB/documentdb.git
cd documentdb
git checkout v0.107.0

# 3. Build extension against PostgreSQL
export PATH=/path/to/postgresql-17/bin:$PATH
export PG_CONFIG=/path/to/postgresql-17/bin/pg_config
make
make install DESTDIR=/path/to/output
```

**Option B: Extract from official Docker image**

FerretDB publishes `ghcr.io/ferretdb/postgres-documentdb` images that contain pre-built PostgreSQL+DocumentDB. These could potentially be extracted, but licensing and compatibility should be verified.

```bash
# Reference only - extraction approach
docker create --name temp ghcr.io/ferretdb/postgres-documentdb:17-0.107.0
docker cp temp:/usr/lib/postgresql/17 ./extracted-pg
docker rm temp
```

**Package structure:**
```
postgresql-documentdb-17-0.107.0-darwin-arm64/
├── bin/
│   ├── postgres
│   ├── pg_ctl
│   ├── pg_dump
│   ├── pg_restore
│   ├── psql
│   └── initdb
├── lib/
│   ├── postgresql/
│   │   ├── pg_documentdb.so
│   │   ├── pg_documentdb_core.so
│   │   └── pg_cron.so
│   └── libpq.so.5
└── share/
    └── postgresql/
        ├── extension/
        │   ├── documentdb.control
        │   ├── documentdb--0.107.0.sql
        │   ├── pg_cron.control
        │   └── pg_cron--1.6.sql
        └── postgresql.conf.sample
```

**Critical: postgresql.conf.sample must include:**
```
shared_preload_libraries = 'pg_cron,pg_documentdb_core,pg_documentdb'
```

This ensures `initdb` creates a `postgresql.conf` with the extensions pre-loaded.

### Version Naming Convention

Recommended naming for hostdb releases.json:

```json
{
  "ferretdb": {
    "2.7.0": { ... }
  },
  "postgresql-documentdb": {
    "17-0.107.0": { ... }
  }
}
```

The `postgresql-documentdb` version format is `{pg_major}-{documentdb_version}` to clearly indicate both components.

### Build Matrix

| FerretDB | DocumentDB | PostgreSQL | Tested Combination |
|----------|------------|------------|-------------------|
| 2.7.0 | 0.107.0 | 17.x | ✅ Official support |
| 2.7.0 | 0.107.0 | 18.x | ❓ May work, untested |

**Recommendation:** Start with PostgreSQL 17 since that's what FerretDB officially tests against. Add PostgreSQL 18 support later if needed.

### Platform Support

| Platform | FerretDB | PostgreSQL+DocumentDB | Notes |
|----------|----------|----------------------|-------|
| darwin-arm64 | ✅ Easy (Go) | ⚠️ Build from source | Apple Silicon |
| darwin-x64 | ✅ Easy (Go) | ⚠️ Build from source | Intel Mac |
| linux-x64 | ✅ Easy (Go) | ✅ Official .deb/.rpm | Standard Linux |
| linux-arm64 | ✅ Easy (Go) | ✅ Official .deb/.rpm | ARM Linux (Raspberry Pi, etc.) |
| win32-x64 | ✅ Easy (Go) | ❌ Not feasible | See below |

**Why Windows is not feasible for PostgreSQL+DocumentDB:**

DocumentDB requires these PostgreSQL extensions, all of which would need Windows builds:
- `pg_cron` - Likely buildable
- `tsm_system_rows` - Part of PostgreSQL contrib, should work
- `vector` (pgvector) - Has Windows support
- `PostGIS` - **Notoriously difficult** to build on Windows
- `rum` - Unknown Windows support

PostGIS alone has complex dependencies (GEOS, PROJ, GDAL) that make Windows builds a significant undertaking. This is tracked as a [stretch goal](#stretch-goals-windows-support).

**Recommendation:** FerretDB binary supports Windows, but Windows users cannot run FerretDB without Docker/WSL due to PostgreSQL+DocumentDB limitations.

### Testing the Build

After building, verify the package works:

```bash
# 1. Initialize a data directory
./bin/initdb -D /tmp/test-ferret-pg

# 2. Check extension is available
grep shared_preload_libraries /tmp/test-ferret-pg/postgresql.conf
# Should show: shared_preload_libraries = 'pg_documentdb_core,pg_cron'

# 3. Start PostgreSQL
./bin/pg_ctl -D /tmp/test-ferret-pg -l /tmp/pg.log start

# 4. Verify extensions load
./bin/psql -d postgres -c "SELECT * FROM pg_extension;"
# Should list pg_documentdb_core

# 5. Test FerretDB connection
./ferretdb --postgresql-url=postgres://localhost:5432/postgres

# 6. Connect with mongosh (if available)
mongosh mongodb://localhost:27017
```

### References for hostdb Build Scripts

- [FerretDB Dockerfile](https://github.com/FerretDB/FerretDB/blob/main/build/docker/all-in-one.Dockerfile) - Shows how they build the all-in-one image
- [DocumentDB build instructions](https://github.com/FerretDB/documentdb#building-from-source)
- [postgres-documentdb image](https://github.com/FerretDB/FerretDB/pkgs/container/postgres-documentdb) - Pre-built reference

---

## Stretch Goals: Windows Support

These are long-term goals that would expand Windows platform support but are not required for initial release.

### Engines Currently Missing Windows Support

| Engine | Blocker | Effort | Notes |
|--------|---------|--------|-------|
| **PostgreSQL+DocumentDB** | PostGIS, rum extensions | High | PostGIS has GEOS/PROJ/GDAL dependencies |
| **ClickHouse** | No hostdb binaries | Medium | ClickHouse official releases include Windows |

### PostgreSQL+DocumentDB on Windows

**Required work:**
1. Build PostGIS for Windows (complex dependency chain: GEOS, PROJ, GDAL, libtiff, etc.)
2. Build rum extension for Windows (unknown complexity)
3. Integrate all extensions into a cohesive Windows package
4. Test DocumentDB functionality on Windows PostgreSQL

**Potential shortcuts:**
- Check if [OSGeo4W](https://trac.osgeo.org/osgeo4w/) provides usable PostGIS binaries
- Check if [PostgreSQL Windows installers](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads) include PostGIS via Stack Builder

### ClickHouse on Windows

**Current status:** ClickHouse is not in hostdb for Windows, but [official ClickHouse releases](https://clickhouse.com/docs/en/install#available-installation-options) include Windows binaries.

**Required work:**
1. Add ClickHouse Windows binaries to hostdb
2. Test SpinDB ClickHouse engine on Windows
3. Handle any Windows-specific path or process management differences

**Effort:** Medium - binaries exist, just need integration and testing.

### Tracking

These stretch goals should be tracked in:
- [ ] `TODO.md` under a "Windows Platform Expansion" section
- [ ] GitHub issues for visibility and community contribution

---

## Sources

- [FerretDB Official Site](https://www.ferretdb.com/)
- [FerretDB GitHub](https://github.com/FerretDB/FerretDB)
- [FerretDB 2.0 Announcement](https://thenewstack.io/ferretdb-2-0-open-source-mongodb-alternative-with-postgresql-power/)
- [FerretDB Documentation](https://docs.ferretdb.io/)
- [DocumentDB GitHub](https://github.com/FerretDB/documentdb)
- [DocumentDB Releases](https://github.com/FerretDB/documentdb/releases)

---

## Extension Loading Fix (January 2026)

This section documents the fix for the DocumentDB extension loading issue.

### The Problem

FerretDB containers were failing to load the documentdb extension with errors like:
```
ERROR: could not open extension control file "/opt/homebrew/share/postgresql@17/extension/documentdb.control": No such file or directory
```

This happened because PostgreSQL was looking for extension files at `/opt/homebrew/...` (the Homebrew-compiled paths) instead of the bundled location (`~/.spindb/bin/postgresql-documentdb-17-0.107.0-<platform>/`).

### Root Cause

**PostgreSQL IS designed to be relocatable** - it computes `sharedir` and `pkglibdir` relative to the binary location when the directory structure follows the standard layout. The problem was Homebrew's non-standard layout:

**Homebrew layout (non-standard):**
```text
/opt/homebrew/opt/postgresql@17/bin/postgres    ← Binary
/opt/homebrew/share/postgresql@17/extension/    ← Extension files (DIFFERENT prefix tree!)
/opt/homebrew/lib/postgresql@17/                ← Libraries (DIFFERENT prefix tree!)
```

**Standard PostgreSQL layout (what we need):**
```text
$PREFIX/bin/postgres                            ← Binary
$PREFIX/share/postgresql/extension/             ← Extension files (SAME prefix tree)
$PREFIX/lib/postgresql/                         ← Libraries (SAME prefix tree)
```

PostgreSQL's internal `make_relative_path()` function computes paths relative to where the binary is located. With the standard layout, PostgreSQL automatically finds files in the bundled directory. With Homebrew's layout, the relative path computation breaks.

### The Fix

**Build PostgreSQL from source** with a standard `--prefix` layout instead of using Homebrew's pre-built binaries:

```bash
# Build PostgreSQL with standard prefix
./configure --prefix=/usr/local/pgsql --with-openssl --with-libxml
make && make install DESTDIR="${BUILD_DIR}"

# The resulting structure is relocatable:
postgresql-documentdb/
├── bin/postgres           ← Computes paths relative to THIS location
├── share/postgresql/      ← Found via relative path from bin/
│   └── extension/
└── lib/postgresql/        ← Found via relative path from bin/
```

When installed to `~/.spindb/bin/postgresql-documentdb-17-0.107.0-darwin-arm64/`, PostgreSQL automatically computes:
- `sharedir` = `~/.spindb/bin/.../share/postgresql/`
- `pkglibdir` = `~/.spindb/bin/.../lib/postgresql/`

**No symlinks, no hardcoded paths, no sudo required** - just correct binary compilation.

### Implementation Details

**hostdb changes:**
1. **`build-macos.sh`**: Rewrote to build PostgreSQL from source instead of using Homebrew
2. **`legacy/`**: Contains the old Homebrew-based build script for reference

**SpinDB changes:**
1. **`engines/ferretdb/index.ts`**: Copy bundled `postgresql.conf.sample` after `initdb` to ensure `shared_preload_libraries` is pre-configured

### Verification

After rebuilding binaries:
```bash
# Verify PostgreSQL computes relative paths correctly
cd ~/.spindb/bin/postgresql-documentdb-17-0.107.0-darwin-arm64
./bin/pg_config --sharedir
# Should output: /Users/bob/.spindb/bin/.../share/postgresql (NOT /opt/homebrew/...)

# Test FerretDB container
spindb create test-fdb --engine ferretdb
spindb start test-fdb
# Should not show "could not open extension control file" errors
```

---

## Notes from hostdb

This section contains implementation details from the hostdb project about how the binaries are structured and how they can be used together.

### Binary Download Links

All binaries are available from the [hostdb releases page](https://github.com/robertjbass/hostdb/releases).

**postgresql-documentdb** (PostgreSQL 17 with DocumentDB extension):

| Platform | Download |
|----------|----------|
| linux-x64 | [postgresql-documentdb-17-0.107.0-linux-x64.tar.gz](https://github.com/robertjbass/hostdb/releases/download/postgresql-documentdb-17-0.107.0/postgresql-documentdb-17-0.107.0-linux-x64.tar.gz) |
| linux-arm64 | [postgresql-documentdb-17-0.107.0-linux-arm64.tar.gz](https://github.com/robertjbass/hostdb/releases/download/postgresql-documentdb-17-0.107.0/postgresql-documentdb-17-0.107.0-linux-arm64.tar.gz) |
| darwin-x64 | [postgresql-documentdb-17-0.107.0-darwin-x64.tar.gz](https://github.com/robertjbass/hostdb/releases/download/postgresql-documentdb-17-0.107.0/postgresql-documentdb-17-0.107.0-darwin-x64.tar.gz) |
| darwin-arm64 | [postgresql-documentdb-17-0.107.0-darwin-arm64.tar.gz](https://github.com/robertjbass/hostdb/releases/download/postgresql-documentdb-17-0.107.0/postgresql-documentdb-17-0.107.0-darwin-arm64.tar.gz) |
| win32-x64 | Not available (see [Windows Limitations](#windows-limitations)) |

**ferretdb** (MongoDB-compatible proxy):

| Platform | Download |
|----------|----------|
| linux-x64 | [ferretdb-2.7.0-linux-x64.tar.gz](https://github.com/robertjbass/hostdb/releases/download/ferretdb-2.7.0/ferretdb-2.7.0-linux-x64.tar.gz) |
| linux-arm64 | [ferretdb-2.7.0-linux-arm64.tar.gz](https://github.com/robertjbass/hostdb/releases/download/ferretdb-2.7.0/ferretdb-2.7.0-linux-arm64.tar.gz) |
| darwin-x64 | [ferretdb-2.7.0-darwin-x64.tar.gz](https://github.com/robertjbass/hostdb/releases/download/ferretdb-2.7.0/ferretdb-2.7.0-darwin-x64.tar.gz) |
| darwin-arm64 | [ferretdb-2.7.0-darwin-arm64.tar.gz](https://github.com/robertjbass/hostdb/releases/download/ferretdb-2.7.0/ferretdb-2.7.0-darwin-arm64.tar.gz) |
| win32-x64 | [ferretdb-2.7.0-win32-x64.zip](https://github.com/robertjbass/hostdb/releases/download/ferretdb-2.7.0/ferretdb-2.7.0-win32-x64.zip) (requires WSL for backend) |

**SHA256 Checksums (postgresql-documentdb-17-0.107.0):**

| Platform | SHA256 |
|----------|--------|
| darwin-arm64 | `2a3892c1fb5fc91ba6cfcaf883b8deff89d11be3c7fa9e8ab3820290f6cc26a6` |
| darwin-x64 | `e8de62aac7a93352a89d9a501b8966accb69412ef6dbf829f3009c5c6752f6b6` |
| linux-arm64 | `3ef93791c96d04ec5c5e018a8fa821a6b1b4fd1fa3656d6781e3961f8c032015` |
| linux-x64 | `b86be77dc8a809c627fdbc83768734eb537b5b708bba1e4cd2e63967d86d14ba` |

### How FerretDB Proxies to PostgreSQL

FerretDB is a **stateless proxy** that translates MongoDB wire protocol to PostgreSQL SQL:

```text
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────────────┐
│  MongoDB Client │   TCP   │    FerretDB     │   TCP   │  PostgreSQL+DocumentDB  │
│   (mongosh,     │ ──────► │     Proxy       │ ──────► │      Backend            │
│    app, etc.)   │  :27017 │                 │ :54320  │                         │
└─────────────────┘         └─────────────────┘         └─────────────────────────┘
                            Translates MongoDB          Stores data as JSONB
                            queries to SQL              in PostgreSQL tables
```

**Port assignment:**
- **FerretDB (external)**: Listens on port `27017` (or next available) for MongoDB wire protocol connections. This is the port users connect to.
- **PostgreSQL (internal)**: Runs on a dynamically allocated port from a high range (e.g., `54320`, `54321`, `54322`, etc.). This port is internal and not exposed to users.

**Why dynamic backend ports?** Each FerretDB container has its own embedded PostgreSQL instance. If you run multiple FerretDB containers (e.g., "myapp-dev" and "myapp-test"), each needs a unique PostgreSQL port:

| Container | FerretDB Port | PostgreSQL Backend Port |
|-----------|---------------|------------------------|
| myapp-dev | 27017 | 54320 |
| myapp-test | 27018 | 54321 |
| analytics | 27019 | 54322 |

The backend port is stored in `container.json` as `backendPort` and is allocated by SpinDB's port manager. Users never need to know or use this port directly - they only interact with the FerretDB port using MongoDB connection strings like `mongodb://localhost:27017`.

### Binary Availability Status

| Platform | postgresql-documentdb | ferretdb | Status |
|----------|----------------------|----------|--------|
| linux-x64 | Extracted from Docker | Official binary | Ready |
| linux-arm64 | Extracted from Docker | Official binary | Ready |
| darwin-x64 | Built from source | Cross-compiled (Go) | Ready |
| darwin-arm64 | Built from source | Cross-compiled (Go) | Ready |
| win32-x64 | Not available | Cross-compiled (Go) | FerretDB only (no backend) |

### postgresql-documentdb Binary Structure

The `postgresql-documentdb` tarball extracts to a self-contained PostgreSQL installation with all required extensions pre-built:

```text
postgresql-documentdb-17-0.107.0-darwin-arm64/
├── postgresql-documentdb/
│   ├── bin/
│   │   ├── postgres
│   │   ├── pg_ctl
│   │   ├── pg_dump
│   │   ├── pg_restore
│   │   ├── psql
│   │   ├── initdb
│   │   └── ... (other PostgreSQL tools)
│   ├── lib/
│   │   ├── pg_documentdb.dylib        # DocumentDB main extension
│   │   ├── pg_documentdb_core.dylib   # DocumentDB core
│   │   ├── pg_cron.dylib              # Job scheduler
│   │   ├── vector.dylib               # pgvector
│   │   ├── rum.dylib                  # RUM index
│   │   ├── postgis-3.dylib            # PostGIS (macOS via Homebrew)
│   │   └── ... (PostgreSQL libraries)
│   ├── share/
│   │   ├── extension/
│   │   │   ├── documentdb.control
│   │   │   ├── pg_cron.control
│   │   │   ├── vector.control
│   │   │   ├── rum.control
│   │   │   ├── postgis.control
│   │   │   └── ... (SQL files)
│   │   └── postgresql.conf.sample     # Pre-configured with shared_preload_libraries
│   └── .hostdb-metadata.json          # Build metadata
```

**Linux note:** On Linux, extensions use `.so` suffix instead of `.dylib`.

### ferretdb Binary Structure

The `ferretdb` tarball is simpler - a single Go binary with optional bundled tools:

```text
ferretdb-2.7.0-darwin-arm64/
├── bin/
│   └── ferretdb                       # Main FerretDB binary (~30MB)
├── mongosh/                           # Optional: bundled MongoDB shell
│   └── bin/
│       └── mongosh
├── database-tools/                    # Optional: bundled MongoDB tools
│   └── bin/
│       ├── mongodump
│       ├── mongorestore
│       └── ...
└── .hostdb-metadata.json
```

### Pre-configured postgresql.conf.sample

The `postgresql-documentdb` binary includes a pre-configured `postgresql.conf.sample` that `initdb` will use. Key settings:

```ini
# Extensions - required for DocumentDB functionality
shared_preload_libraries = 'pg_cron,pg_documentdb_core,pg_documentdb'

# pg_cron configuration
cron.database_name = 'postgres'

# Connection settings
listen_addresses = 'localhost'
port = 5432
```

**SpinDB integration:** When initializing `pg_data/`, the `initdb` command will automatically copy this sample to `postgresql.conf`. SpinDB only needs to:
1. Change the `port` to the allocated `backendPort`
2. Optionally adjust `listen_addresses` if needed

### Component Versions (17-0.107.0)

| Component | Version | Notes |
|-----------|---------|-------|
| PostgreSQL | 17 | Base database |
| DocumentDB | 0.107.0 | MongoDB wire protocol support |
| pg_cron | 1.6.4 | Job scheduler (required by DocumentDB) |
| pgvector | 0.8.0 | Vector similarity search |
| PostGIS | 3.5.1 | Geospatial (macOS: Homebrew, Linux: Docker) |
| rum | 1.3.14 | RUM index access method |

### Source Types by Platform

| Platform | postgresql-documentdb Source | Notes |
|----------|------------------------------|-------|
| linux-x64 | `docker-extract` | Extracted from `ghcr.io/ferretdb/postgres-documentdb:17-0.107.0` |
| linux-arm64 | `docker-extract` | Same image, `linux/arm64` platform |
| darwin-x64 | `build-required` | Built from source on `macos-15-intel` runner |
| darwin-arm64 | `build-required` | Built from source on `macos-14` runner |
| win32-x64 | `build-required` | Stretch goal - PostGIS/rum blockers |

### SpinDB Binary Path Conventions

Based on hostdb structure, SpinDB should expect:

```ts
// Binary paths
const pgBinDir = `~/.spindb/bin/postgresql-documentdb-17-0.107.0-${platform}/postgresql-documentdb/bin`
const ferretBinDir = `~/.spindb/bin/ferretdb-2.7.0-${platform}/bin`

// Key executables
const postgres = `${pgBinDir}/postgres`
const pgCtl = `${pgBinDir}/pg_ctl`
const initdb = `${pgBinDir}/initdb`
const psql = `${pgBinDir}/psql`
const pgDump = `${pgBinDir}/pg_dump`
const pgRestore = `${pgBinDir}/pg_restore`
const ferretdb = `${ferretBinDir}/ferretdb`
```

### Initialization Sequence

1. **Download binaries** (if not cached):
   - Download `postgresql-documentdb-17-0.107.0-{platform}.tar.gz`
   - Download `ferretdb-2.7.0-{platform}.tar.gz`
   - Extract to `~/.spindb/bin/`

2. **Initialize PostgreSQL data directory**:
   ```bash
   ./postgresql-documentdb/bin/initdb -D /path/to/pg_data
   ```
   This automatically uses the pre-configured `postgresql.conf.sample`.

3. **Modify postgresql.conf** (minimal changes needed):
   ```bash
   # Only need to change port - extensions already configured
   sed -i 's/port = 5432/port = 54321/' /path/to/pg_data/postgresql.conf
   ```

   **Why change the port?** Each FerretDB container runs its own embedded PostgreSQL on a unique "backend port" (see [Port Management](#port-management)). This prevents conflicts when running multiple FerretDB containers or when port 5432 is already in use. SpinDB allocates ports from a high range (e.g., 54320+) for these internal backends.

4. **Start PostgreSQL**:
   ```bash
   ./postgresql-documentdb/bin/pg_ctl -D /path/to/pg_data -l pg.log start
   ```

5. **Create FerretDB database** (first run only):
   ```bash
   ./postgresql-documentdb/bin/psql -p 54321 -c "CREATE DATABASE ferretdb;"
   ./postgresql-documentdb/bin/psql -p 54321 -d ferretdb -c "CREATE EXTENSION documentdb CASCADE;"
   ```

6. **Start FerretDB**:
   ```bash
   ./ferretdb --postgresql-url="postgres://localhost:54321/ferretdb" --listen-addr=":27017"
   ```

### Metadata Files

Both binaries include `.hostdb-metadata.json` for version tracking:

```json
// postgresql-documentdb metadata
{
  "name": "postgresql-documentdb",
  "version": "17-0.107.0",
  "platform": "darwin-arm64",
  "source": "source-build",  // or "docker-extract" for Linux
  "components": {
    "postgresql": "17",
    "documentdb": "0.107.0",
    "pg_cron": "1.6.4",
    "pgvector": "0.8.0",
    "rum": "1.3.14"
  },
  "rehosted_by": "hostdb",
  "rehosted_at": "2025-01-23T..."
}
```

SpinDB can read this metadata to verify binary compatibility and display version info.

### Windows Limitations

Windows support is blocked by `postgresql-documentdb`, not FerretDB:

- **FerretDB binary**: Works on Windows (Go cross-compiles easily)
- **postgresql-documentdb**: Blocked by PostGIS and rum extension build complexity

If Windows support is ever needed, options include:
1. WSL2 (recommend to users)
2. Build a minimal `postgresql-documentdb` without PostGIS/rum (reduced functionality)
3. Significant investment in Windows build infrastructure for GEOS/PROJ/GDAL
