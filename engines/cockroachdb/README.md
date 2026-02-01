# CockroachDB Engine Implementation

## Overview

CockroachDB is a distributed SQL database with PostgreSQL wire protocol compatibility. It uses a single `cockroach` binary for all operations.

## Platform Support

| Platform | Architecture | Status | Notes |
|----------|--------------|--------|-------|
| darwin | x64 | Supported | Uses hostdb binaries |
| darwin | arm64 | Supported | Uses hostdb binaries (Apple Silicon) |
| linux | x64 | Supported | Uses hostdb binaries |
| linux | arm64 | Supported | Uses hostdb binaries |
| win32 | x64 | Supported | Uses hostdb binaries |

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz`
- **Windows**: `zip`

### Archive Structure
```
cockroachdb/
└── bin/
    └── cockroach        # Unified binary
```

### Version Format - YY.MM

Like ClickHouse, CockroachDB uses **year-based versioning**:
- `25.4.2` means 2025, release 4, patch 2
- **NOT** semver

### Version Map Sync

```typescript
export const COCKROACHDB_VERSION_MAP: Record<string, string> = {
  '25': '25.4.2',
}
```

## Implementation Details

### Binary Manager

CockroachDB uses `BaseBinaryManager` with standard configuration.

### Version Parsing

- **Version output format**: `Build Tag: v25.4.2` or `CockroachDB CCL v25.4.2`
- **Parse pattern**: `/v?(\d+\.\d+\.\d+)/`

### Default Configuration

- **Default Port**: 26257 (auto-increments on conflict)
- **HTTP Port**: 8080 (Admin UI)
- **PID File**: `cockroach.pid` in container directory

### PostgreSQL Wire Protocol

CockroachDB is PostgreSQL-compatible:
- Use `psql` for connections
- Standard PostgreSQL connection strings work
- PostgreSQL drivers work

### Connection String Format

```
postgresql://root@127.0.0.1:{port}/{database}
```

### Critical: Background Process Stdio

**MUST use `stdio: ['ignore', 'ignore', 'ignore']`** for spawning detached server:

```typescript
const proc = spawn(cockroachBinary, args, {
  stdio: ['ignore', 'ignore', 'ignore'],  // NOT 'pipe'
  detached: true,
  windowsHide: true,
})
proc.unref()
```

Using `'pipe'` for stdout/stderr keeps file descriptors open that prevent Node.js from exiting, causing `spindb start` to hang indefinitely in Docker/CI environments.

This is documented in CLAUDE.md as a major gotcha.

### Startup Command

```bash
cockroach start-single-node \
  --insecure \
  --store={dataDir} \
  --listen-addr=127.0.0.1:{port} \
  --http-addr=127.0.0.1:{httpPort} \
  --background
```

## Backup & Restore

CockroachDB supports SQL-based backup/restore compatible with PostgreSQL tools.

## Integration Test Notes

### PostgreSQL Tools

Integration tests can use `psql` for CockroachDB operations.

### Test Fixtures

Located in `tests/fixtures/cockroachdb/seeds/`:
- SQL data for testing

## Docker E2E Test Notes

CockroachDB Docker E2E tests verify:
- Single-node cluster startup
- PostgreSQL wire protocol operations
- Database creation/deletion
- Data operations

## Known Issues & Gotchas

### 1. stdio Must Be 'ignore'

**Critical**: Using `stdio: 'pipe'` causes Node.js to hang. Always use `['ignore', 'ignore', 'ignore']` for detached spawn. This is the most important gotcha for CockroachDB.

### 2. YY.MM Version Format

Version `25.4.2` is year 2025, not semver version 25.

### 3. Single-Node Mode

SpinDB runs CockroachDB in single-node mode (`--insecure`) for local development. Not suitable for production.

### 4. Admin UI Port

CockroachDB has a web Admin UI on a separate HTTP port (default 8080). This is in addition to the SQL port.

### 5. Slow Initial Startup

First startup can be slow as CockroachDB initializes its distributed storage layer.

### 6. Memory Usage

CockroachDB is designed for distributed systems and may use more memory than simpler databases.

## CI/CD Notes

### GitHub Actions Cache Step

```yaml
- name: Cache CockroachDB binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/cockroachdb-*
    key: cockroachdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/cockroachdb/version-maps.ts') }}
```

## PostgreSQL Compatibility Notes

CockroachDB is largely PostgreSQL-compatible but has some differences:
- Not all PostgreSQL features are supported
- Some SQL syntax differences
- Different system tables

For most common operations, PostgreSQL tools and drivers work correctly.
