# SQLite Engine Implementation

## Overview

SQLite is an embedded/file-based SQL database. Unlike server-based engines, SQLite databases are single files stored in the user's project directory, not in `~/.spindb/containers/`.

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

**Important**: SQLite archives have a **flat structure** - binaries are at the root level, NOT in a `bin/` subdirectory:

```
sqlite3              # Main CLI binary
sqldiff              # Database diff tool
sqlite3_analyzer     # Database analyzer
sqlite3_rsync        # Remote sync tool (if available)
```

The `BaseEmbeddedBinaryManager` handles this by checking both root and `bin/` locations, and the standard extraction moves files to `bin/` for consistency.

### Version Map Sync

```typescript
export const SQLITE_VERSION_MAP: Record<string, string> = {
  '3': '3.51.2',
}
```

## Implementation Details

### Binary Manager

SQLite uses `BaseEmbeddedBinaryManager` which is designed for file-based databases:
- No server process management
- Flat archive structure handling
- Simple version verification

### Version Parsing

- **Version output format**: `3.51.2 2025-01-08 12:00:00 ...`
- **Parse pattern**: `/^(\d+\.\d+\.\d+)/` (first line)

### File-Based Model

SQLite is fundamentally different from server-based engines:
- **No start/stop**: `start()` and `stop()` are no-ops
- **No port**: Port is always 0
- **No container directory**: Data lives in user's project directory (CWD)
- **Registry tracking**: `~/.spindb/config.json` tracks registered files by name

### Status Detection

Status is determined by file existence, not process state:
```typescript
async status(): Promise<StatusResult> {
  const exists = existsSync(this.filePath)
  return { running: exists, message: exists ? 'File exists' : 'File not found' }
}
```

### Attach/Detach Commands

SQLite uses special commands instead of create/delete:
- `spindb attach <path>` - Register existing SQLite file in SpinDB
- `spindb detach <name>` - Unregister from SpinDB (keeps file on disk)

### Connection String Format

```
file:/path/to/database.sqlite
```

Or simply the file path.

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| sql | `.sql` | sqlite3 .dump | Plain text SQL |
| binary | `.sqlite` | File copy | Direct file copy |

### Binary Backup

Binary backup is a simple file copy - SQLite databases are single files.

### SQL Backup

Uses SQLite's `.dump` command for portable SQL export.

## Integration Test Notes

### Test Fixtures

Located in `tests/fixtures/sqlite/seeds/`:
- `sample-db.sql`: Contains 5 test_user records

### No Port Allocation

SQLite tests don't need port management since there's no server.

## Docker E2E Test Notes

SQLite Docker E2E tests verify:
- File creation
- SQL operations via CLI
- Backup/restore (both formats)
- Attach/detach workflow

## Known Issues & Gotchas

### 1. Flat Archive Structure

SQLite archives don't have a `bin/` subdirectory. The binary manager handles this, but be aware when debugging extraction issues.

### 2. No Server Lifecycle

Calling `start()` or `stop()` on SQLite does nothing. This is intentional.

### 3. File Location

SQLite files are stored in the user's working directory, not `~/.spindb/containers/`. The registry in `config.json` only tracks metadata.

### 4. WAL Mode Considerations

SQLite in WAL mode creates additional files (`*.wal`, `*.shm`). Binary backup should include these or ensure clean checkpoint first.

### 5. Database Locking

SQLite uses file locking. Only one write connection at a time. Multiple readers are allowed.

### 6. Cross-Platform File Paths

File paths in connection strings should use forward slashes or be properly escaped.

## CI/CD Notes

### GitHub Actions Cache Step

```yaml
- name: Cache SQLite binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/sqlite-*
    key: sqlite-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/sqlite/version-maps.ts') }}
```
