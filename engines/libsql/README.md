# libSQL Engine Implementation

## Overview

libSQL (sqld) is a SQLite fork by Turso that runs as a server with an HTTP API. Like Meilisearch and Qdrant, it is a REST API engine -- there is no native CLI shell.

## Platform Support

| Platform | Architecture | Status | Notes |
|----------|--------------|--------|-------|
| darwin | arm64 | Supported | Uses hostdb binaries (Apple Silicon) |
| darwin | x64 | Supported | Uses hostdb binaries |
| linux | arm64 | Supported | Uses hostdb binaries |
| linux | x64 | Supported | Uses hostdb binaries |
| win32 | x64 | Not supported | No Windows binaries available |

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz`

### Archive Structure
```
libsql/
└── bin/
    └── sqld           # Server binary
```

### Version Map Sync

```typescript
export const LIBSQL_VERSION_MAP: Record<string, string> = {
  '0': '0.24.32',
}
```

## Implementation Details

### Binary Manager

libSQL uses `BaseBinaryManager` with standard configuration. The server binary is `sqld`.

### Version Parsing

- **Version output format**: `sqld 0.24.32` or `v0.24.32`
- **Parse pattern**: `/(?:sqld\s+)?v?(\d+\.\d+\.\d+)/`

### REST API Engine

libSQL is a **REST API engine**:
- `spindb run` is **NOT applicable** (throws `UnsupportedOperationError`)
- `spindb connect` prints curl examples (no web dashboard)
- All query operations use the Hrana over HTTP protocol

### Single Port

libSQL only uses a single HTTP port:
- **HTTP Port** (default 8080): REST API (Hrana protocol)

### Default Configuration

- **Default Port**: 8080 (auto-increments on conflict)
- **Health Endpoint**: `/health`
- **Query Endpoint**: `/v2/pipeline` (Hrana over HTTP)
- **PID File**: `libsql.pid` in container directory
- **Data File**: `data/data.db` (SQLite file inside container data dir)

### Single Database Per Instance

libSQL runs a single SQLite database per server instance:
- `listDatabases()` always returns `['main']`
- `createDatabase()` throws `UnsupportedOperationError`
- `dropDatabase()` throws `UnsupportedOperationError`
- Use `spindb create` to make a new instance instead

### No Authentication

libSQL local dev mode does not support user management:
- `createUser()` throws `UnsupportedOperationError`
- No `--auth` / `--no-auth` flag support

### Connection String Format

```
http://127.0.0.1:{port}
```

### Start Command

```bash
sqld --http-listen-addr {bind}:{port} --db-path {dataDir}/data.db
```

### Server Process Management

- Spawned as a detached process with `stdio: ['ignore', 'ignore', 'ignore']` (prevents fd leaks)
- Health check loop polls `GET /health` up to 30 times at 500ms intervals
- Checks log file for startup errors (e.g., "Address already in use")
- Stop uses PID file first, then falls back to port-based process lookup

## Hrana HTTP Protocol

libSQL uses the Hrana over HTTP protocol for queries. All SQL goes through `POST /v2/pipeline`.

### Request Format

```json
{
  "requests": [
    { "type": "execute", "stmt": { "sql": "SELECT 1" } },
    { "type": "close" }
  ]
}
```

### Response Format

```json
{
  "results": [
    {
      "type": "ok",
      "response": {
        "type": "execute",
        "result": {
          "cols": [{ "name": "1", "decltype": null }],
          "rows": [[{ "type": "integer", "value": "1" }]],
          "affected_row_count": 0,
          "last_insert_rowid": null
        }
      }
    },
    { "type": "ok", "response": { "type": "close" } }
  ],
  "baton": null
}
```

### Value Types

| Hrana Type | Example |
|-----------|---------|
| `null` | `{ "type": "null" }` |
| `integer` | `{ "type": "integer", "value": "42" }` |
| `float` | `{ "type": "float", "value": 3.14 }` |
| `text` | `{ "type": "text", "value": "hello" }` |
| `blob` | `{ "type": "blob", "base64": "AQID" }` |

### Reference

See the [Hrana 3 spec](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md) for full protocol details.

## Backup & Restore

### Backup Formats

| Format | Extension | Method | Server State |
|--------|-----------|--------|--------------|
| binary | `.db` | File copy of `data.db` | Running or stopped |
| sql | `.sql` | HTTP API dump via `sqlite_master` queries | Must be running |

### Binary Backup

Copies the `data/data.db` file directly. Simple and fast.

### SQL Backup

Queries the running server via the HTTP API:
1. Reads `sqlite_master` for table schemas, indexes, views, and triggers
2. Dumps all rows with `SELECT *` per table
3. Outputs standard SQL statements wrapped in a transaction

### Restore

| Format | Method | Server State |
|--------|--------|--------------|
| binary | Copy `.db` file to `data/data.db` | Must be stopped |
| sql | Execute statements via HTTP API | Must be running |

### Format Detection

- `.sql` extension -> SQL format
- `.db` extension -> binary format
- Unknown extension -> defaults to binary

## Integration Test Notes

### REST API Testing

Integration tests use `fetch()` against the Hrana HTTP endpoint.

### curl Examples

```bash
# Health check
curl http://localhost:8080/health

# Execute a query
curl -s http://localhost:8080/v2/pipeline \
  -H "Content-Type: application/json" \
  -d '{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}'

# Create a table
curl -s http://localhost:8080/v2/pipeline \
  -H "Content-Type: application/json" \
  -d '{"requests":[{"type":"execute","stmt":{"sql":"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"}},{"type":"close"}]}'

# Insert data
curl -s http://localhost:8080/v2/pipeline \
  -H "Content-Type: application/json" \
  -d '{"requests":[{"type":"execute","stmt":{"sql":"INSERT INTO users (name) VALUES ('\''Alice'\'')"}},{"type":"close"}]}'
```

## Docker E2E Test Notes

libSQL Docker E2E uses `curl` against the Hrana HTTP endpoint.

### GitHub Actions Cache Step

```yaml
- name: Cache libSQL binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/libsql-*
    key: libsql-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/libsql/version-maps.ts') }}
```

## Known Issues & Gotchas

### 1. No CLI Shell

`spindb run` throws `UnsupportedOperationError`. Use the HTTP API or a libSQL SDK (e.g., `@libsql/client`).

### 2. No Web Dashboard

Unlike Meilisearch (dashboard at `/`) or Qdrant (dashboard at `/dashboard`), libSQL has no built-in web UI. `spindb connect` prints curl examples instead of opening a browser.

### 3. Single Database Per Instance

Each sqld server manages exactly one SQLite database file (`data.db`). There is no concept of multiple databases within a single server. Create separate containers for separate databases.

### 4. No Windows Support

libSQL (sqld) binaries are not available for Windows. The `SUPPORTED_PLATFORMS` set in `binary-urls.ts` only includes darwin and linux variants.

### 5. No Authentication

sqld in local dev mode does not support authentication or user management. All requests are unauthenticated.

### 6. SQL Restore Skips Transaction Control

When restoring from SQL dumps, `BEGIN TRANSACTION`, `COMMIT`, and `ROLLBACK` statements are skipped because sqld handles transactions differently via the Hrana protocol.

## License

libSQL is licensed under the MIT License.
