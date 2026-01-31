# DuckDB Engine Implementation

## Overview

DuckDB is an embedded OLAP (analytical) database. Like SQLite, it's file-based with no server process. DuckDB is optimized for analytical queries and columnar storage.

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

### Archive Structure - FLAT (No bin/ Subdirectory)

Like SQLite, DuckDB archives have a **flat structure**:

```
duckdb              # Main CLI binary
```

The `BaseEmbeddedBinaryManager` handles moving this to `bin/` during extraction.

### Version Map Sync

```typescript
export const DUCKDB_VERSION_MAP: Record<string, string> = {
  '1': '1.4.3',
}
```

## Implementation Details

### Binary Manager

DuckDB uses `BaseEmbeddedBinaryManager` with the same file-based model as SQLite.

### Version Parsing

- **Version output format**: `v1.4.3 abcdef123`
- **Parse pattern**: `/v?(\d+\.\d+\.\d+)/`

### File-Based Model

Same as SQLite:
- **No start/stop**: No-ops
- **No port**: Port is always 0
- **No container directory**: Data in user's project directory
- **Registry tracking**: `~/.spindb/config.json` tracks files

### Attach/Detach Commands

- `spindb attach <path>` - Register existing DuckDB file
- `spindb detach <name>` - Unregister (keeps file)

### Connection String Format

```
duckdb:/path/to/database.duckdb
```

Or simply the file path.

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| sql | `.sql` | Custom export | SQL statements |
| binary | `.duckdb` | File copy | Direct file copy |

### OLAP Considerations

DuckDB backups may be larger than equivalent SQLite backups due to columnar storage format. Binary backup preserves columnar layout for fast analytical queries.

## Integration Test Notes

### Test Fixtures

Located in `tests/fixtures/duckdb/seeds/`:
- Test data for OLAP operations

### No Port Allocation

Like SQLite, no server means no ports.

## Docker E2E Test Notes

DuckDB Docker E2E tests verify:
- File operations
- SQL execution
- Backup/restore
- Attach/detach workflow

## Known Issues & Gotchas

### 1. Flat Archive Structure

Same as SQLite - binaries at root, not in `bin/`.

### 2. OLAP vs OLTP

DuckDB is optimized for analytical (OLAP) workloads:
- Fast columnar scans
- Efficient aggregations
- May be slower for single-row operations

### 3. Memory Usage

DuckDB uses memory aggressively for performance. Large analytical queries may consume significant RAM.

### 4. File Extensions

DuckDB databases typically use `.duckdb` or `.db` extension. The engine accepts any extension.

### 5. Concurrent Access

DuckDB allows multiple readers but only one writer. Similar to SQLite's locking model.

### 6. Extensions

DuckDB supports extensions (parquet, httpfs, etc.). Extension loading requires the binary to be in a writable location.

## DuckDB vs SQLite

| Feature | DuckDB | SQLite |
|---------|--------|--------|
| Workload | OLAP (analytical) | OLTP (transactional) |
| Storage | Columnar | Row-based |
| Large scans | Very fast | Slower |
| Single rows | Slower | Very fast |
| Memory | Aggressive | Conservative |

## CI/CD Notes

### GitHub Actions Cache Step

```yaml
- name: Cache DuckDB binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/duckdb-*
    key: duckdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/duckdb/version-maps.ts') }}
```
