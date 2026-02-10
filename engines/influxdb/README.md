# InfluxDB Engine Implementation

## Overview

InfluxDB 3.x is a time-series database rewritten in Rust. It uses a REST API for all operations (no CLI client). InfluxDB 3.x supports SQL queries via its HTTP API, unlike earlier versions which used InfluxQL/Flux.

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
influxdb/
├── influxdb3           # Server binary
├── python/             # Bundled Python runtime
│   └── lib/
│       └── libpython3.13.dylib
├── LICENSE-APACHE
└── LICENSE-MIT
```

### Binary + Python Runtime
InfluxDB 3.x ships as a single `influxdb3` binary that acts as the server, bundled with a Python runtime. The binary uses `@executable_path/python/lib/libpython3.13.dylib`, so the `python/` directory must be co-located with the binary. The custom `moveExtractedEntries` override ensures both end up in `bin/`. There is no separate CLI client — all interactions use the REST API.

### Version Map Sync

```typescript
export const INFLUXDB_VERSION_MAP: Record<string, string> = {
  '3': '3.8.0',
}
```

## Implementation Details

### Binary Manager

InfluxDB uses `BaseBinaryManager` since it's a server-based engine with single-digit major versions:

```typescript
class InfluxDBBinaryManager extends BaseBinaryManager {
  protected readonly config = {
    engine: Engine.InfluxDB,
    engineName: 'influxdb',
    displayName: 'InfluxDB',
    serverBinary: 'influxdb3',
  }
}
```

### REST API Engine

InfluxDB is a **REST API engine**:
- `spindb run` is **NOT applicable** (scriptFileLabel is `null`)
- `spindb connect` opens the health endpoint info in terminal
- All operations use HTTP REST API

### Default Configuration

- **Default Port**: 8086
- **Health Endpoint**: `GET /health`
- **SQL Query Endpoint**: `POST /api/v3/query_sql`
- **Write Endpoint**: `POST /api/v3/write_lp`
- **No Authentication**: InfluxDB 3.x local dev has no auth by default
- **PID File**: `influxdb.pid` in container directory

### Database Creation

InfluxDB 3.x creates databases **implicitly on first write**. There is no explicit `CREATE DATABASE` command. When you write data with a database name, it's auto-created.

### Connection String Format

```text
http://127.0.0.1:{port}
```

## Backup & Restore

### Backup Formats

| Format | Extension | Method | Notes |
|--------|-----------|--------|-------|
| sql | `.sql` | REST API | SQL dump with CREATE TABLE + INSERT statements |

### Backup Method

Uses InfluxDB's SQL query API to export data:
1. `SHOW TABLES` — lists all tables/measurements
2. `SELECT * FROM {table}` — exports all data per table
3. Generates SQL INSERT statements for restore

### Restore Method

Parses SQL dump file and executes statements via `POST /api/v3/query_sql`.

## Integration Test Notes

### REST API Testing

Integration tests use `fetch()` to interact with InfluxDB REST API.

### Test Fixtures

Located in `tests/fixtures/influxdb/seeds/`:
- `README.md` documenting the API-based approach

## Known Issues & Gotchas

### 1. No CLI Client

InfluxDB 3.x has no bundled CLI client. All operations use the HTTP REST API. The `clientTools` array in engine-defaults is empty.

### 2. Implicit Database Creation

Databases are created on first write, not via explicit commands. `createDatabase()` verifies server health but doesn't create anything.

### 3. SQL Query Support

InfluxDB 3.x supports SQL queries (not InfluxQL or Flux from v1/v2). Query via:
```bash
curl -X POST http://localhost:8086/api/v3/query_sql \
  -H "Content-Type: application/json" \
  -d '{"db":"mydb","q":"SELECT * FROM measurement","format":"json"}'
```

### 4. Write via Line Protocol

Data writes use InfluxDB line protocol format:
```bash
curl -X POST "http://localhost:8086/api/v3/write_lp?db=mydb" \
  -H "Content-Type: text/plain" \
  -d 'measurement,tag=value field=123'
```

### 5. Windows PID Handling

On Windows, uses `platformService.findProcessByPort(port)` after startup to find the real PID, similar to QuestDB/TypeDB pattern.

## REST API Quick Reference

### Health
```bash
GET /health
```

### Query (SQL)
```bash
POST /api/v3/query_sql
Content-Type: application/json
{"db":"mydb","q":"SELECT 1","format":"json"}
```

### Write (Line Protocol)
```bash
POST /api/v3/write_lp?db=mydb
Content-Type: text/plain
measurement,tag=value field=123
```

### Show Tables
```bash
POST /api/v3/query_sql
{"db":"mydb","q":"SHOW TABLES","format":"json"}
```

### List Databases
```bash
GET /api/v3/configure/database?format=json
```
