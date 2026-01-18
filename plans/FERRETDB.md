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
  // 1. Find available port for PostgreSQL backend (internal)
  // 2. Start PostgreSQL on backend port, pointing to pg_data/
  // 3. Wait for PostgreSQL to be ready
  // 4. Start FerretDB with --postgresql-url=postgres://localhost:{backendPort}/ferretdb
  // 5. Update container status and backendPort
  // 6. Return MongoDB connection string: mongodb://localhost:{port}
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
async status(container: ContainerConfig): Promise<StatusResult> {
  // Check both processes:
  // - FerretDB running? (check PID file)
  // - PostgreSQL running? (pg_ctl status on pg_data/)
  // Return 'running' only if BOTH are running
}
```

## Port Management

Each FerretDB container uses TWO ports:
1. **External port** (user-facing): MongoDB wire protocol (default 27017)
2. **Internal port** (hidden): PostgreSQL backend (auto-assigned from high range, e.g., 54320+)

```ts
const ferretdbPort = await portManager.getAvailablePort(27017)  // User sees this
const backendPort = await portManager.getAvailablePort(54320)   // Internal only
```

## Backup & Restore

**Decision:** Use PostgreSQL native backup (pg_dump) on the embedded PostgreSQL. No MongoDB tools needed.

### Format Options

| Format | Extension | Use Case |
|--------|-----------|----------|
| PostgreSQL dump | `.sql` | Human-readable, portable |
| PostgreSQL binary | `.dump` | Faster for large datasets |

### Implementation

```ts
// Backup: use pg_dump on embedded PostgreSQL
async backup(container, outputPath, options): Promise<BackupResult> {
  const pgDumpPath = await this.getPgDumpPath()
  const pgDataDir = paths.getContainerPath(container.name, { engine: 'ferretdb' }) + '/pg_data'
  // Connect to embedded PostgreSQL on backendPort
  await execAsync(`${pgDumpPath} -h 127.0.0.1 -p ${container.backendPort} -U postgres -F c -f "${outputPath}" ferretdb`)
}

// Restore: use pg_restore on embedded PostgreSQL
async restore(container, backupPath, options): Promise<RestoreResult> {
  const pgRestorePath = await this.getPgRestorePath()
  await execAsync(`${pgRestorePath} -h 127.0.0.1 -p ${container.backendPort} -U postgres -d ferretdb "${backupPath}"`)
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
- Proper `postgresql.conf.sample` with `shared_preload_libraries` pre-configured

### Version Map

```ts
// engines/ferretdb/version-maps.ts
export const FERRETDB_VERSION_MAP: Record<string, string> = {
  '2': '2.7.0',  // Latest stable
}

// Maps FerretDB version to required postgresql-documentdb version
export const FERRETDB_PG_DOCUMENTDB_COMPAT: Record<string, string> = {
  '2.7.0': '17-0.107.0',
  '2.0.0': '17-0.102.0',
}
```

## Implementation Checklist

### Phase 1: hostdb - Build Binaries (BLOCKING)

This must be completed before any SpinDB work begins.

**FerretDB binary:**
- [ ] Add FerretDB to hostdb releases.json
- [ ] Build FerretDB 2.x binaries for darwin-arm64, darwin-x64, linux-x64
- [ ] FerretDB is a Go binary - should be straightforward

**PostgreSQL+DocumentDB binary:**
- [ ] Create new `postgresql-documentdb` engine in hostdb
- [ ] Build PostgreSQL 17 with DocumentDB extension compiled in
- [ ] Include pg_cron extension
- [ ] Test extension loads correctly with `shared_preload_libraries`
- [ ] Build for darwin-arm64, darwin-x64, linux-x64

**References:**
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

## Remaining Open Questions

1. **Windows support:** FerretDB is a Go binary (easy), but can DocumentDB extension be built for Windows? May need to skip Windows initially.

2. **Connection strings:** Should `spindb url myferret` return:
   - `mongodb://localhost:27017` (FerretDB endpoint) - **recommended default**
   - `postgresql://localhost:54320/ferretdb` (direct backend access) - optional `--backend` flag?

3. **mongosh for `spindb connect`:** If user has mongosh installed system-wide, use it. Otherwise:
   - Skip interactive shell support?
   - Prompt user to install mongosh?
   - Include mongosh in hostdb builds?

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
shared_preload_libraries = 'pg_documentdb_core,pg_cron'
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
| darwin-arm64 | ✅ Easy (Go) | ⚠️ Needs building | Apple Silicon |
| darwin-x64 | ✅ Easy (Go) | ⚠️ Needs building | Intel Mac |
| linux-x64 | ✅ Easy (Go) | ⚠️ Needs building | Standard Linux |
| linux-arm64 | ✅ Easy (Go) | ⚠️ Needs building | ARM Linux (Raspberry Pi, etc.) |
| win32-x64 | ✅ Easy (Go) | ❌ Unlikely | DocumentDB extension unlikely to build on Windows |

**Recommendation:** Skip Windows initially. FerretDB itself would work, but DocumentDB extension compilation on Windows is uncharted territory.

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

## Sources

- [FerretDB Official Site](https://www.ferretdb.com/)
- [FerretDB GitHub](https://github.com/FerretDB/FerretDB)
- [FerretDB 2.0 Announcement](https://thenewstack.io/ferretdb-2-0-open-source-mongodb-alternative-with-postgresql-power/)
- [FerretDB Documentation](https://docs.ferretdb.io/)
