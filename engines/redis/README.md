# Redis Engine Implementation

## Overview

Redis is an in-memory key-value store with persistence. SpinDB downloads Redis binaries from hostdb and manages them with `redis-server` and `redis-cli`.

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
```text
redis/
└── bin/
    ├── redis-server     # Server binary
    ├── redis-cli        # Client CLI
    ├── redis-benchmark  # Benchmarking tool
    └── redis-check-*    # Diagnostic tools
```

### Version Map Sync

```typescript
export const REDIS_VERSION_MAP: Record<string, string> = {
  '7': '7.4.7',
  '8': '8.4.0',
}
```

## Implementation Details

### Binary Manager

Redis uses `BaseBinaryManager` with standard key-value store configuration.

### Version Parsing

- **Version output format**: `Redis server v=7.4.7 sha=00000000:0 malloc=jemalloc-5.3.0...`
- **Parse pattern**: `/v=(\d+\.\d+\.\d+)/` then fallback to `/(\d+\.\d+\.\d+)/`

### Default Configuration

- **Default Port**: 6379 (auto-increments on conflict)
- **Databases**: 16 numbered databases (0-15)
- **PID File**: `redis.pid` in container directory
- **Persistence**: RDB snapshots enabled by default

### Generated Configuration

SpinDB generates `redis.conf` with:
```
port {port}
bind 127.0.0.1
dir {dataDir}
daemonize yes     # Unix: uses native daemonization
logfile {logFile}
pidfile {pidFile}

# Persistence - RDB snapshots
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb

# AOF disabled for local dev
appendonly no
```

### Windows Daemonize Workaround

Redis on Windows doesn't support `daemonize yes`. SpinDB uses:
- `detached: true` spawn option
- `windowsHide: true` to hide console window
- Manual PID file management

### Connection String Format

```text
redis://127.0.0.1:{port}/{database}
```

Where `{database}` is 0-15.

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| text | `.redis` | Custom RESP | Human-readable commands |
| rdb | `.rdb` | Native RDB | Binary snapshot |

### Text Format (Merge vs Replace)

The text backup format supports two restore modes:
- **Merge**: Adds keys without clearing existing data
- **Replace (flush)**: Clears database before restoring

### RDB Format

RDB backups are native Redis snapshots. Restore requires stopping Redis, replacing `dump.rdb`, and restarting.

## Database Model

Redis uses numbered databases (0-15) instead of named databases:
- `createDatabase()` is effectively a no-op (databases always exist)
- `dropDatabase()` uses `FLUSHDB` to clear all keys in that database

## Integration Test Notes

### Reserved Ports

Integration tests use reserved ports:
- **Test Ports**: 6399-6401 (NOT 6379)

### Test Fixtures

Located in `tests/fixtures/redis/seeds/`:
- Key-value pairs for testing

## Docker E2E Test Notes

Redis Docker E2E tests verify:
- Server lifecycle
- Key-value operations
- RDB and text backup/restore
- Database switching (SELECT)

## Known Issues & Gotchas

### 1. Windows Daemonization

Redis doesn't natively support `daemonize yes` on Windows. SpinDB spawns a detached process instead and manages the PID file manually.

### 2. Database Numbers

Redis databases are always 0-15. Attempting to use a number outside this range throws an error.

### 3. Memory-First Storage

Redis is primarily in-memory. Large datasets may consume significant RAM. RDB snapshots persist to disk.

### 4. AOF Disabled

Append-Only File (AOF) is disabled by default in SpinDB for simpler local development. Enable it manually in `redis.conf` for durability.

### 5. Graceful Shutdown

Redis uses `SHUTDOWN SAVE` command for graceful shutdown with data persistence. Falls back to SIGTERM if CLI fails.

## CI/CD Notes

### GitHub Actions Cache Step

```yaml
- name: Cache Redis binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/redis-*
    key: redis-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/redis/version-maps.ts') }}
```
