# FerretDB Engine Implementation

## Overview

FerretDB is a MongoDB-compatible proxy that stores data in PostgreSQL. It requires **two binaries** to function:

1. **ferretdb** - Stateless Go proxy (MongoDB wire protocol -> PostgreSQL SQL)
2. **postgresql-documentdb** - PostgreSQL 17 with DocumentDB extension

This is a **composite engine** with unique binary management requirements.

## Platform Support

| Platform | Architecture | Status | Notes |
|----------|--------------|--------|-------|
| darwin | x64 | Supported | Both binaries available |
| darwin | arm64 | Supported | Both binaries available (Apple Silicon) |
| linux | x64 | Supported | Both binaries available |
| linux | arm64 | Supported | Both binaries available |
| win32 | x64 | **NOT SUPPORTED** | postgresql-documentdb has startup issues |

### Windows Limitation

FerretDB is **not available on Windows** due to postgresql-documentdb startup issues. The Windows binaries exist in hostdb, but the PostgreSQL backend fails to initialize properly. This has been extensively tested and currently requires WSL as a workaround.

### macOS SIP / Container Limitations

On macOS, System Integrity Protection (SIP) can block creating symlinks in system directories (e.g., `/usr/local`). In containerized or locked-down environments, even `sudo` may not permit writes to those paths. If you hit permission errors during setup, use a non-system install location or run with elevated privileges when available. See https://github.com/robertjbass/spindb#ferretdb for details.

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz` for both binaries
- **Windows**: Not applicable (unsupported)

### FerretDB Archive Structure
```
ferretdb/
└── bin/
    └── ferretdb          # Go proxy binary
```

### postgresql-documentdb Archive Structure
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

### Why Custom PostgreSQL Build?

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
  '2': '2.7.0',
}

// postgresql-documentdb version format: {pg_major}-{documentdb_version}
export const DEFAULT_DOCUMENTDB_VERSION = '17-0.107.0'
```

## Implementation Details

### Composite Binary Manager

FerretDB uses a custom `FerretDBCompositeBinaryManager` that:
- Downloads both binaries atomically (rolls back if either fails)
- Manages separate version tracking for FerretDB and DocumentDB
- Handles platform-specific library requirements

### Architecture

```
MongoDB Client (:27017) -> FerretDB Proxy -> PostgreSQL+DocumentDB (:54320+)
```

### Three Ports Per Container

FerretDB containers use **three ports**:
- **MongoDB Port** (default 27017): MongoDB wire protocol for client connections
- **PostgreSQL Backend Port** (default 54320+): Internal PostgreSQL connection
- **Debug HTTP Port** (default 37017+): FerretDB debug/metrics handler

### FerretDB-Specific Startup Flags

```bash
ferretdb \
  --no-auth \                              # Disable SCRAM authentication
  --debug-addr=127.0.0.1:${port + 10000} \ # Unique debug port per container
  --listen-addr=127.0.0.1:${port} \        # MongoDB wire protocol port
  --postgresql-url=postgres://postgres@127.0.0.1:${backendPort}/ferretdb
```

### Linux LD_LIBRARY_PATH

On Linux, the bundled binaries need `LD_LIBRARY_PATH` set to find shared libraries:

```typescript
getDocumentDBSpawnEnv(): { LD_LIBRARY_PATH: '/path/to/lib:$LD_LIBRARY_PATH' }
```

macOS uses `@loader_path` which doesn't need environment variables.

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

When uninstalling FerretDB:
- FerretDB proxy binary is deleted
- postgresql-documentdb binary is **also deleted** (dedicated dependency)

This differs from QuestDB's PostgreSQL dependency (see QuestDB README).

## Known Issues & Gotchas

### 1. Authentication Gotcha

FerretDB 2.x enables SCRAM authentication by default. The `--setup-username` and `--setup-password` flags **do NOT exist** despite documentation suggestions. Use `--no-auth` instead.

### 2. Debug Port Conflicts

Running multiple FerretDB containers fails if all use default debug port 8088. Solution: `--debug-addr=127.0.0.1:${port + 10000}`

### 3. Database Visibility

Like MongoDB, databases don't appear until data is written. The engine uses the temp collection trick (`_spindb_init`).

### 4. Namespace Derivation

Namespace is derived from container name: `my-app` -> `my_app` (dashes replaced with underscores).

### 5. Windows Unsupported

Extensive testing confirmed postgresql-documentdb does not start properly on Windows. WSL is the recommended workaround.

## Docker E2E Test Notes

FerretDB Docker E2E tests verify:
- Composite binary download
- Two-process startup (PostgreSQL backend + FerretDB proxy)
- MongoDB protocol operations
- Backup/restore via PostgreSQL tools

## CI/CD Notes

### Skipped on Windows

FerretDB CI tests are skipped on Windows runners due to platform limitation.

### GitHub Actions Cache Step

```yaml
- name: Cache FerretDB binaries
  uses: actions/cache@v4
  with:
    path: |
      ~/.spindb/bin/ferretdb-*
      ~/.spindb/bin/postgresql-documentdb-*
    key: ferretdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/ferretdb/version-maps.ts') }}
```

## Related Documentation

- [plans/FERRETDB.md](../../plans/FERRETDB.md) - Original implementation plan (may be outdated)
- hostdb releases: [ferretdb-2.7.0](https://github.com/robertjbass/hostdb/releases/tag/ferretdb-2.7.0)
- hostdb releases: [postgresql-documentdb-17-0.107.0](https://github.com/robertjbass/hostdb/releases/tag/postgresql-documentdb-17-0.107.0)
