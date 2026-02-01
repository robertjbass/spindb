# QuestDB Engine Implementation

## Overview

QuestDB is a high-performance time-series database with SQL support via PostgreSQL wire protocol. It's a Java-based database with a bundled JRE, making it one of the more complex engines to manage.

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

### Archive Structure - Platform Differences

**macOS:**
```
questdb/
├── questdb.sh           # Startup script (at ROOT, not bin/)
├── questdb.jar          # Main application
├── lib/                 # Dependencies
└── jre/                 # Bundled JRE
    └── bin/
        └── java
```

**Linux:**
```
questdb/
├── bin/
│   └── questdb.sh       # Startup script (in bin/)
├── lib/
│   └── jvm/             # JRE in different location
│       └── */bin/java
└── questdb.jar
```

**Windows:**
```
questdb/
├── questdb.exe          # Windows executable
├── questdb.jar
├── lib/
└── jre/
```

### Startup Script Location Varies

The binary manager checks BOTH root and `bin/` subdirectory for `questdb.sh`/`questdb.exe`:

```typescript
// Check both locations
const shPathRoot = join(binPath, 'questdb.sh')
const shPathBin = join(binPath, 'bin', 'questdb.sh')
```

### Custom moveExtractedEntries

QuestDB has a custom `moveExtractedEntries()` that preserves its unique structure - it does NOT move `questdb.sh` to `bin/` like other engines.

### Version Map Sync

```typescript
export const QUESTDB_VERSION_MAP: Record<string, string> = {
  '9': '9.2.3',
}
```

## Implementation Details

### Binary Manager

QuestDB uses `BaseBinaryManager` with extensive customizations:
- `isInstalled()` - Checks both root and bin/ locations
- `moveExtractedEntries()` - Preserves QuestDB's directory structure
- `postExtract()` - Makes script executable, creates java symlink
- `verify()` - Custom verification (no --version flag)

### Java-Based Architecture

QuestDB is a Java application with bundled JRE:
- No Java installation required
- JRE included in download
- Startup via shell script (Unix) or exe (Windows)

### Post-Extraction Setup

The `postExtract()` method:
1. Makes `questdb.sh` executable (`chmod 755`)
2. Creates symlink: `java` -> `jre/bin/java` (macOS)

The symlink is needed because `questdb.sh` checks for `$BASE/java` to determine if JRE is bundled.

### Multi-Port Configuration - CRITICAL

QuestDB uses **FOUR ports** per container:

| Port | Offset | Default | Purpose |
|------|--------|---------|---------|
| PostgreSQL Wire | Base | 8812 | SQL connections via psql |
| HTTP Web Console | +188 | 9000 | REST API and Web UI |
| HTTP Min Server | +191 | 9003 | Health checks/metrics |
| ILP TCP | +197 | 9009 | InfluxDB Line Protocol |

**Multi-container conflicts**: When running multiple QuestDB containers, ALL ports must be configured uniquely via environment variables:
- `QDB_PG_NET_BIND_TO`
- `QDB_HTTP_BIND_TO`
- `QDB_HTTP_MIN_NET_BIND_TO`
- `QDB_LINE_TCP_NET_BIND_TO`

The HTTP Min Server (default 9003) causes conflicts if not configured per-container.

### PID Handling - Shell Script Problem

**Critical gotcha**: When spawning `questdb.sh start`, the shell script forks the Java process and exits immediately. The PID from `proc.pid` is the shell's PID, which becomes invalid within milliseconds.

QuestDB also doesn't create its own PID file in daemon mode.

**Solution**: After startup, find the actual Java process by port:

```typescript
// After waitForReady() succeeds:
const pids = await platformService.findProcessByPort(port)
if (pids.length > 0) {
  await writeFile(pidFile, pids[0].toString(), 'utf-8')
}
```

Stop also uses port lookup first, falling back to PID file.

### Default Configuration

- **Default PG Port**: 8812 (auto-increments on conflict)
- **HTTP Port**: PG port + 188 (default 9000)
- **Default Database**: `qdb` (single database model)
- **Default Credentials**: `admin` / `quest`
- **Log File**: `questdb.log` in container directory
- **Config File**: `server.conf` in `conf/` subdirectory

### Connection String Format

```
postgresql://admin:quest@127.0.0.1:{port}/qdb
```

Uses PostgreSQL wire protocol.

### Health Check

Uses HTTP GET to Web Console:
```bash
curl http://127.0.0.1:{httpPort}/
```

Or via psql if available:
```bash
psql -h 127.0.0.1 -p {port} -U admin -d qdb -c "SELECT 1;"
```

### Critical: Background Process Stdio

Like CockroachDB and SurrealDB, **MUST use `stdio: ['ignore', 'ignore', 'ignore']`**:

```typescript
const proc = spawn(questdbBinary, args, {
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
  cwd: containerDir,
  env: {
    QDB_HTTP_BIND_TO: `0.0.0.0:${httpPort}`,
    QDB_HTTP_MIN_NET_BIND_TO: `0.0.0.0:${port + 191}`,
    QDB_PG_NET_BIND_TO: `0.0.0.0:${port}`,
    QDB_LINE_TCP_NET_BIND_TO: `0.0.0.0:${port + 197}`,
  },
  windowsHide: true,
})
proc.unref()
```

### Startup Commands

**Unix:**
```bash
questdb.sh start -d {dataDir} -t {name} -n
```

**Windows:**
```bash
questdb.exe -d {dataDir} -t {name}
```

Note: Windows doesn't support 'start' subcommand reliably.

The `-t {name}` flag is the process tag - allows multiple instances by unique identifier.

## Backup & Restore

### Cross-Engine Dependency

**Critical**: QuestDB backup/restore requires PostgreSQL's `psql` binary to connect via wire protocol.

```typescript
// Find psql from SpinDB's PostgreSQL engine
let psqlPath = await configManager.getBinaryPath('psql')
```

**Warning**: Deleting PostgreSQL will break QuestDB backup/restore!

This is different from FerretDB's postgresql-documentdb dependency, which is deleted WITH FerretDB. PostgreSQL is a standalone engine, so it's kept.

### Timestamp Column

QuestDB tables have a designated timestamp column that can have any name. Don't assume `timestamp` - query `tables()` for `designatedTimestamp` column name.

## Web Console

QuestDB has a built-in Web Console at:
```
http://localhost:{httpPort}/
```

Where `httpPort = pgPort + 188` (default 9000).

## Integration Test Notes

### psql Dependency

Integration tests need `psql` available (from PostgreSQL engine).

### Test Fixtures

Located in `tests/fixtures/questdb/seeds/`:
- SQL data for time-series testing

## Docker E2E Test Notes

QuestDB Docker E2E tests verify:
- Multi-port startup
- PostgreSQL wire protocol
- HTTP Web Console
- Time-series operations

### Windows Extended Timeout

Windows needs more time for Java to start and release file locks:
- Startup timeout: 90000ms (vs 60000ms on Unix)
- Graceful shutdown wait: 5000ms (vs 2000ms on Unix)

## Known Issues & Gotchas

### 1. Shell Script PID is Useless

`questdb.sh` forks and exits. Must find Java process by port.

### 2. Four Ports Required

Each container needs four unique ports. HTTP Min Server (port +191) is often forgotten.

### 3. psql Dependency

Backup/restore needs PostgreSQL's psql binary. Inform users of this cross-engine dependency.

### 4. stdio Must Be 'ignore'

Same as CockroachDB/SurrealDB - prevents Node.js from hanging.

### 5. Archive Structure Varies

macOS has `questdb.sh` at root, Linux has it in `bin/`. The binary manager handles both.

### 6. No --version Flag

QuestDB is Java-based. Verification checks script/jar existence, not version output.

### 7. Single Database Model

QuestDB uses a single database (`qdb`). "createDatabase" is effectively a no-op.

### 8. Java Symlink (macOS)

The `java` symlink at base level is needed for `questdb.sh` to find the bundled JRE.

## CI/CD Notes

### GitHub Actions Cache Step

```yaml
- name: Cache QuestDB binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/questdb-*
    key: questdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/questdb/version-maps.ts') }}
```

### Windows CI Considerations

Windows tests use extended timeouts due to Java startup time.

## Time-Series SQL Examples

### Create Table
```sql
CREATE TABLE sensors (
  timestamp TIMESTAMP,
  sensor_id SYMBOL,
  value DOUBLE
) TIMESTAMP(timestamp) PARTITION BY DAY;
```

### Insert Data
```sql
INSERT INTO sensors VALUES (now(), 'sensor1', 23.5);
```

### Time-Based Queries
```sql
-- Last hour
SELECT * FROM sensors WHERE timestamp > now() - 1h;

-- Sample by 1 minute
SELECT timestamp, avg(value) FROM sensors SAMPLE BY 1m;

-- Latest value per sensor
SELECT * FROM sensors LATEST ON timestamp PARTITION BY sensor_id;
```
