# FerretDB Engine Implementation

## Overview

FerretDB is a MongoDB-compatible proxy that stores data in PostgreSQL. It supports **two major versions** with different backends:

**v2 (default, macOS/Linux only):**
1. **ferretdb** (hostdb: `ferretdb`) - Stateless Go proxy
2. **postgresql-documentdb** (hostdb: `postgresql-documentdb`) - PostgreSQL 17 with DocumentDB extension

**v1 (all platforms including Windows):**
1. **ferretdb** (hostdb: `ferretdb`) - Stateless Go proxy (same protocol, older version)
2. **Plain PostgreSQL** - Standard PostgreSQL via `postgresqlBinaryManager` (shared with standalone PG containers)

This is a **composite engine** with unique binary management requirements. The `isV1(version)` helper in `version-maps.ts` is the single branching point for all version-dependent behavior.

## Platform Support

| Platform | Architecture | v1 Status | v2 Status | Notes |
|----------|--------------|-----------|-----------|-------|
| darwin | x64 | Supported | Supported | Both backends available |
| darwin | arm64 | Supported | Supported | Both backends available (Apple Silicon) |
| linux | x64 | Supported | Supported | Both backends available |
| linux | arm64 | Supported | Supported | Both backends available |
| win32 | x64 | Supported | **NOT SUPPORTED** | v2: postgresql-documentdb has startup issues |

### Windows Support

FerretDB **v1 is supported on Windows**. v2 is not available on Windows because postgresql-documentdb fails to initialize properly. `spindb create` auto-selects v1 on Windows. `spindb engines download ferretdb 2` on Windows is blocked with a helpful error suggesting v1.

**Important hostdb note:** hostdb has `ferretdb` v2 proxy binaries for Windows but does NOT have `postgresql-documentdb` for Windows. This means the v2 proxy would download successfully but fail to start (no backend). The version-aware platform check in `binary-urls.ts` prevents this.

### macOS SIP / Container Limitations

On macOS, System Integrity Protection (SIP) can block creating symlinks in system directories (e.g., `/usr/local`). In containerized or locked-down environments, even `sudo` may not permit writes to those paths. If you hit permission errors during setup, use a non-system install location or run with elevated privileges when available. See https://github.com/robertjbass/spindb#ferretdb for details. This only applies to v2 (DocumentDB's Homebrew-derived paths).

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz` for both versions
- **Windows**: `zip` for v1 proxy, plain PostgreSQL handled by `postgresqlBinaryManager`

### FerretDB Archive Structure (both v1 and v2)
```
ferretdb/
└── bin/
    └── ferretdb          # Go proxy binary
```

### postgresql-documentdb Archive Structure (v2 only)
```
postgresql-documentdb/
├── bin/
│   ├── pg_ctl           # PostgreSQL control utility
│   ├── initdb           # Database initialization
│   ├── psql             # Interactive terminal
│   ├── pg_dump          # Backup utility
│   └── pg_restore       # Restore utility
├── lib/
│   ├── libpq.so         # PostgreSQL client library
│   ├── postgresql/      # Extension modules
│   │   └── documentdb.so
│   └── *.dylib/*.so     # Other shared libraries
└── share/               # Configuration and data files
```

### v1 Backend (Plain PostgreSQL)

v1 delegates backend management to `postgresqlBinaryManager`, which downloads standard PostgreSQL from hostdb. The PostgreSQL binaries are shared with standalone PostgreSQL containers — deleting a FerretDB v1 installation does NOT delete the shared PostgreSQL.

**Caveat:** If `postgresqlBinaryManager.isInstalled()` finds an existing minimal PostgreSQL install (e.g., from a previous DocumentDB extraction) that only has server binaries (`postgres`, `pg_ctl`, `initdb`) but lacks client tools (`psql`), the engine falls back to `postgres --single` mode for pre-start database creation.

### Why Custom PostgreSQL Build? (v2)

The postgresql-documentdb bundle is a **custom PostgreSQL 17 build** that includes:
- DocumentDB extension (MongoDB-compatible storage)
- PostGIS extension (built from source)
- pgvector extension
- All required dylibs bundled with rewritten paths

**Why not use Homebrew PostgreSQL?**

Homebrew PostgreSQL has hardcoded paths (`/opt/homebrew/lib/...`) that break on other machines. The hostdb build:
1. Builds PostgreSQL from source with relative paths
2. Builds PostGIS from source against that PostgreSQL
3. Bundles all dependencies (OpenSSL, ICU, GEOS, PROJ, etc.)
4. Rewrites dylib paths to use `@loader_path` for macOS
5. Re-signs all binaries (macOS requires code signing after modification)

### Version Map Sync

```typescript
// FerretDB versions
export const FERRETDB_VERSION_MAP: Record<string, string> = {
  '1': '1.24.2',   // v1: plain PostgreSQL backend
  '2': '2.7.0',    // v2: postgresql-documentdb backend
}

// v2 backend version format: {pg_major}-{documentdb_version}
export const DEFAULT_DOCUMENTDB_VERSION = '17-0.107.0'

// v1 backend: standard PostgreSQL major version
export const DEFAULT_V1_POSTGRESQL_VERSION = '17'
```

## Implementation Details

### Composite Binary Manager

FerretDB uses a custom `FerretDBCompositeBinaryManager` that:
- Downloads both binaries atomically (rolls back if either fails) — v2 only
- For v1, downloads FerretDB proxy then delegates PostgreSQL to `postgresqlBinaryManager`
- `isV1(version)` branches all version-dependent behavior
- `getBackendBinaryPath()` / `getBackendSpawnEnv()` abstract v1/v2 backend resolution

### Architecture

```
MongoDB Client (:27017) -> FerretDB Proxy -> PostgreSQL backend (:54320+)
                                              v1: plain PostgreSQL
                                              v2: PostgreSQL + DocumentDB
```

### Three Ports Per Container

FerretDB containers use **three ports**:
- **MongoDB Port** (default 27017): MongoDB wire protocol for client connections
- **PostgreSQL Backend Port** (default 54320+): Internal PostgreSQL connection
- **Debug HTTP Port** (default 37017+): FerretDB debug/metrics handler

### FerretDB-Specific Startup Flags

```bash
# v2:
ferretdb \
  --no-auth \                              # Disable SCRAM authentication (v2 only)
  --debug-addr=127.0.0.1:${port + 10000} \ # Unique debug port per container
  --listen-addr=127.0.0.1:${port} \        # MongoDB wire protocol port
  --postgresql-url=postgres://postgres@127.0.0.1:${backendPort}/ferretdb

# v1 (differences):
ferretdb \
  # no --no-auth (auth disabled by default in v1)
  --debug-addr=127.0.0.1:${port + 10000} \
  --listen-addr=127.0.0.1:${port} \
  --postgresql-url=postgres://postgres@127.0.0.1:${backendPort}/ferretdb?sslmode=disable
```

### Linux LD_LIBRARY_PATH

On Linux, the bundled binaries need `LD_LIBRARY_PATH` set to find shared libraries:

```typescript
getBackendSpawnEnv(): { LD_LIBRARY_PATH: '/path/to/lib:$LD_LIBRARY_PATH' }
```

macOS uses `@loader_path` which doesn't need environment variables. Applies to both v1 and v2.

### macOS Code Signing

Downloaded binaries are re-signed with ad-hoc signature (`codesign -s -`) due to Gatekeeper quarantine invalidating original signatures.

### Connection String Format

```
mongodb://127.0.0.1:{port}/{database}
```

No authentication required with `--no-auth` flag.

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| sql | `.sql` | pg_dump (DocumentDB) | Plain text SQL |
| custom | `.dump` | pg_dump -Fc (DocumentDB) | Binary, parallel restore |

### Restore Limitations

**Warning**: pg_dump/pg_restore between FerretDB containers has issues because DocumentDB creates internal metadata tables (e.g., `job`) that conflict during restore.

Restore may fail with: `duplicate key value violates unique constraint`

**Workaround**: Use `--clean --if-exists` flags, but some data loss may occur.

**For production**: Consider mongodump/mongorestore on the MongoDB protocol side.

## Engine Dependency Management

### Uninstall Behavior

**v2:** Both FerretDB proxy and postgresql-documentdb are deleted. The postgresql-documentdb binary is a dedicated dependency not shared with other engines.

**v1:** Only the FerretDB proxy is deleted. Plain PostgreSQL binaries are **NOT deleted** because they are shared with standalone PostgreSQL containers.

This differs from QuestDB's PostgreSQL dependency (see QuestDB README).

## Known Issues & Gotchas

### 1. Authentication Gotcha

FerretDB 2.x enables SCRAM authentication by default. The `--setup-username` and `--setup-password` flags **do NOT exist** despite documentation suggestions. Use `--no-auth` instead. FerretDB 1.x has auth disabled by default (no flag needed).

### 2. Debug Port Conflicts

Running multiple FerretDB containers fails if all use default debug port 8088. Solution: `--debug-addr=127.0.0.1:${port + 10000}`

### 3. Database Visibility

Like MongoDB, databases don't appear until data is written. The engine uses the temp collection trick (`_spindb_init`).

### 4. Namespace Derivation

Namespace is derived from container name: `my-app` -> `my_app` (dashes replaced with underscores).

### 5. Windows: v2 Unsupported, v1 Supported

Extensive testing confirmed postgresql-documentdb (v2 backend) does not start properly on Windows. FerretDB v1 uses plain PostgreSQL and works on all platforms including Windows. **Note:** hostdb has v2 proxy binaries for Windows but NOT the backend — the download command blocks v2 on Windows to prevent broken installs.

### 6. v1 Binary Verification

FerretDB v1 hostdb builds panic on `--version` because the source expects `build/version/version.txt` (via `//go:embed`). The hostdb build script must create this file. SpinDB skips `--version` verification for v1 (only checks binary exists).

### 7. v1 Database Creation Without psql

If the PostgreSQL backend is a minimal install lacking `psql`, the engine uses `postgres --single` mode before server start to create the `ferretdb` database. This requires exclusive data directory access, so it runs before `pg_ctl start`.

## Docker E2E Test Notes

FerretDB Docker E2E tests verify:
- Composite binary download
- Two-process startup (PostgreSQL backend + FerretDB proxy)
- MongoDB protocol operations
- Backup/restore via PostgreSQL tools

## CI/CD Notes

### Windows CI

FerretDB v2 CI tests are skipped on Windows runners. v1 tests should run on all platforms.

### GitHub Actions Cache Step

```yaml
- name: Cache FerretDB binaries
  uses: actions/cache@v4
  with:
    path: |
      ~/.spindb/bin/ferretdb-*
      ~/.spindb/bin/postgresql-documentdb-*
      ~/.spindb/bin/postgresql-*
    key: ferretdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/ferretdb/version-maps.ts') }}
```

## Related Documentation

- [plans/FERRETDB.md](../../plans/FERRETDB.md) - Original implementation plan (may be outdated)
- hostdb releases: [ferretdb-2.7.0](https://github.com/robertjbass/hostdb/releases/tag/ferretdb-2.7.0) (v2 proxy)
- hostdb releases: [ferretdb-1.24.2](https://github.com/robertjbass/hostdb/releases/tag/ferretdb-1.24.2) (v1 proxy)
- hostdb releases: [postgresql-documentdb-17-0.107.0](https://github.com/robertjbass/hostdb/releases/tag/postgresql-documentdb-17-0.107.0) (v2 backend)
