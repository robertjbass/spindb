# Qdrant Engine Implementation

## Overview

Qdrant is a vector similarity search engine with a REST API. Unlike traditional databases, Qdrant is interacted with via HTTP, not a CLI shell.

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
qdrant/
└── bin/
    └── qdrant           # Server binary
```

### Version Map Sync

```typescript
export const QDRANT_VERSION_MAP: Record<string, string> = {
  '1': '1.16.3',
}
```

## Implementation Details

### Binary Manager

Qdrant uses `BaseBinaryManager` with standard configuration.

### Version Parsing

- **Version output format**: `qdrant 1.16.3` or `v1.16.3`
- **Parse pattern**: `/(?:qdrant\s+)?v?(\d+\.\d+\.\d+)/`

### REST API Engine

Qdrant is a **REST API engine** - it doesn't have a CLI shell:
- `spindb run` is **NOT applicable**
- `spindb connect` opens the web dashboard in browser
- All data operations use HTTP REST API

### Dual Ports

Qdrant uses two ports:
- **HTTP Port** (default 6333): REST API
- **gRPC Port** (default 6334): gRPC API (typically HTTP + 1)

### Default Configuration

- **Default HTTP Port**: 6333 (auto-increments on conflict)
- **gRPC Port**: HTTP port + 1
- **Health Endpoint**: `/healthz`
- **Dashboard**: `/dashboard`
- **PID File**: `qdrant.pid` in container directory

### YAML Configuration

Qdrant uses YAML configuration (`config.yaml`):

```yaml
storage:
  storage_path: /path/to/data
service:
  http_port: 6333
  grpc_port: 6334
```

### Connection String Format

```
http://127.0.0.1:{port}
```

### Web Dashboard

Qdrant has a built-in web dashboard at:
```
http://localhost:{port}/dashboard
```

The `connect` command opens this URL in the default browser using platform-specific commands (`open`, `xdg-open`, `cmd /c start`).

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| snapshot | `.snapshot` | REST API | Qdrant native snapshot |

### Snapshot API

Backup and restore use Qdrant's snapshot REST endpoints:
- `POST /collections/{name}/snapshots` - Create snapshot
- `PUT /collections/{name}/snapshots/recover` - Restore snapshot

## Integration Test Notes

### REST API Testing

Integration tests use `fetch()` or `curl` for operations, not CLI tools.

### Test Fixtures

Located in `tests/fixtures/qdrant/seeds/`:
- `README.md` documenting the API-based approach (no SQL/script files)

## Docker E2E Test Notes

Qdrant Docker E2E uses `curl` for all operations:

```bash
# Health check
curl http://localhost:6333/healthz

# Create collection
curl -X PUT http://localhost:6333/collections/test \
  -H 'Content-Type: application/json' \
  -d '{"vectors":{"size":4,"distance":"Dot"}}'

# Insert vectors
curl -X PUT http://localhost:6333/collections/test/points \
  -H 'Content-Type: application/json' \
  -d '{"points":[...]}'
```

### Backup/Restore Skipped in Docker E2E

Qdrant backup/restore tests are skipped in Docker E2E (covered by integration tests).

## Known Issues & Gotchas

### 1. No CLI Shell

`spindb run` does nothing for Qdrant. Use the REST API or web dashboard.

### 2. Vector Database Semantics

Qdrant uses "collections" instead of "databases". Operations are vector-centric:
- Insert points with vectors
- Search by vector similarity
- Filter by payload

### 3. gRPC Port

The gRPC port is separate from HTTP. Ensure both ports are available if using gRPC clients.

### 4. Snapshot Format

Snapshots are Qdrant's native format and are not compatible with other databases.

### 5. Health Check Endpoint

Use `/healthz` (not `/health`) for health checks.

## CI/CD Notes

### curl-Based Testing

CI tests use `curl` commands rather than database CLI tools.

### GitHub Actions Cache Step

```yaml
- name: Cache Qdrant binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/qdrant-*
    key: qdrant-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/qdrant/version-maps.ts') }}
```

## REST API Quick Reference

### Collections
```bash
# List collections
GET /collections

# Create collection
PUT /collections/{name}

# Delete collection
DELETE /collections/{name}
```

### Points (Vectors)
```bash
# Upsert points
PUT /collections/{name}/points

# Search
POST /collections/{name}/points/search

# Get point
GET /collections/{name}/points/{id}
```

### Snapshots
```bash
# Create snapshot
POST /collections/{name}/snapshots

# List snapshots
GET /collections/{name}/snapshots

# Recover from snapshot
PUT /collections/{name}/snapshots/recover
```
