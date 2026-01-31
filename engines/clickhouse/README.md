# ClickHouse Engine Implementation

## Overview

ClickHouse is a high-performance columnar OLAP database. It uses a single unified binary that handles server, client, and local modes.

## Platform Support

| Platform | Architecture | Status | Notes |
|----------|--------------|--------|-------|
| darwin | x64 | Supported | Uses hostdb binaries |
| darwin | arm64 | Supported | Uses hostdb binaries (Apple Silicon) |
| linux | x64 | Supported | Uses hostdb binaries |
| linux | arm64 | Supported | Uses hostdb binaries |
| win32 | x64 | **NOT SUPPORTED** | See "Windows Support" section |

### Windows Support - Extensive Investigation

ClickHouse on Windows is **not supported** after extensive investigation:

1. **No official Windows binaries**: ClickHouse does not provide official Windows builds
2. **hostdb build attempts**: Multiple attempts were made to build ClickHouse for Windows in hostdb
3. **Compilation failures**: The Windows build process has significant issues with the ClickHouse codebase
4. **WSL recommended**: Users on Windows should use WSL (Windows Subsystem for Linux)

This is one of the unsolved platform limitations in SpinDB. The decision was made to put a pin in Windows support and document it clearly rather than continue spending time on an unviable path.

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz`
- **Windows**: Not applicable (unsupported)

### Archive Structure - Potentially Flat

ClickHouse archives may have either structure:

**Standard structure:**
```
clickhouse/
└── bin/
    └── clickhouse       # Unified binary
```

**Flat structure:**
```
clickhouse              # Unified binary (no subdirectory)
```

The binary manager handles both cases with custom `moveExtractedEntries()`.

### Unified Binary

ClickHouse uses a single `clickhouse` binary for all operations:
- `clickhouse server` - Run server
- `clickhouse client` - Interactive client
- `clickhouse local` - Local query processing

### Version Map Sync

**Important**: ClickHouse uses YY.MM versioning, not semver:

```typescript
export const CLICKHOUSE_VERSION_MAP: Record<string, string> = {
  '25.12': '25.12.3.21',  // YY.MM.patch.build format
}
```

## Implementation Details

### Binary Manager

ClickHouse uses `BaseServerBinaryManager` with several overrides:
- `extractWindowsBinaries()` - Throws error (Windows unsupported)
- `moveExtractedEntries()` - Handles flat archive structure
- `verify()` - Custom YY.MM version matching

### Version Format - YY.MM

ClickHouse versions are **year.month** based:
- `25.12.3.21` means 2025, December, patch 3, build 21
- Version matching compares first two parts (YY.MM)

### Version Parsing

- **Version output format**: `ClickHouse client version 25.12.3.21`
- **Parse pattern**: `/(\d+\.\d+\.\d+\.\d+)/` (4-part version)
- **Major version matching**: Compares `YY.MM` portion

### XML Configuration

ClickHouse uses XML configuration (not YAML):

```xml
<?xml version="1.0"?>
<clickhouse>
    <http_port>8124</http_port>
    <tcp_port>9000</tcp_port>
    <listen_host>127.0.0.1</listen_host>
    <path>/data/</path>
    <!-- ... -->
</clickhouse>
```

### Dual Ports

ClickHouse uses two ports:
- **TCP Port** (default 9000): Native protocol
- **HTTP Port** (default 8123): HTTP API and Play UI

### Default Configuration

- **Default TCP Port**: 9000 (auto-increments on conflict)
- **HTTP Port**: TCP port + 1
- **PID File**: `clickhouse.pid` in container directory
- **Web UI**: Play at `http://localhost:8123/play`

### PID File Handling

ClickHouse in daemon mode doesn't respect `<pid_file>` config. The engine manually finds the process by port and writes the PID file:

```typescript
const pids = await platformService.findProcessByPort(port)
if (pids.length > 0) {
  await writeFile(pidFile, String(pids[0]), 'utf8')
}
```

### Startup Command

```bash
clickhouse server --config-file config.xml --daemon
```

### Connection String Format

```
clickhouse://127.0.0.1:{port}/{database}
```

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| sql | `.sql` | clickhouse client | SQL export |

ClickHouse backup uses `SELECT * FORMAT SQLInsert` for data export.

## Integration Test Notes

### Extended Timeout

ClickHouse can take longer to start on CI runners (up to 90 seconds). The `waitForReady()` timeout is extended accordingly.

### Test Fixtures

Located in `tests/fixtures/clickhouse/seeds/`:
- SQL data for testing

## Docker E2E Test Notes

ClickHouse Docker E2E tests verify:
- Server lifecycle
- SQL operations via client
- HTTP API availability
- Backup/restore

### Linux-Only in CI

ClickHouse CI tests only run on Linux and macOS runners.

## Known Issues & Gotchas

### 1. Windows Not Supported

Extensive work was done trying to get ClickHouse working on Windows. It's not viable. Use WSL.

### 2. YY.MM Version Format

Don't expect semver. Version `25.12.3.21` is December 2025, not version 25.12.

### 3. Flat Archive Handling

Some ClickHouse archives have binaries at the root, not in `bin/`. The engine handles this but be aware when debugging.

### 4. XML Config

Unlike most databases, ClickHouse uses XML configuration. The engine generates `config.xml` and `users.xml`.

### 5. Long Startup Time

ClickHouse may take longer to start than other databases, especially on first run or on resource-constrained systems.

### 6. Memory Usage

ClickHouse is designed for high-performance analytics and may use significant memory. The default `mark_cache_size` is 5GB.

### 7. HTTP Port for Play UI

The Play UI (web-based query interface) is at the HTTP port, not TCP port:
- TCP: `clickhouse://localhost:9000`
- HTTP/UI: `http://localhost:8123/play`

## CI/CD Notes

### Skipped on Windows

ClickHouse CI tests are completely skipped on Windows runners.

### GitHub Actions Cache Step

```yaml
- name: Cache ClickHouse binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/clickhouse-*
    key: clickhouse-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/clickhouse/version-maps.ts') }}
  if: runner.os != 'Windows'
```

## Windows Alternative

For Windows users who need ClickHouse:

1. **WSL (Recommended)**: Install SpinDB in WSL and run ClickHouse there
2. **Docker**: Use official ClickHouse Docker images
3. **ClickHouse Cloud**: Use managed cloud service

There is no workaround for native Windows support at this time.
