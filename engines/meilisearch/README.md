# Meilisearch Engine Implementation

## Overview

Meilisearch is a fast full-text search engine with a REST API. Like Qdrant, it uses HTTP for all operations instead of a CLI shell.

## Platform Support

| Platform | Architecture | Status | Notes |
|----------|--------------|--------|-------|
| darwin | x64 | Supported | Uses hostdb binaries |
| darwin | arm64 | Supported | Uses hostdb binaries (Apple Silicon) |
| linux | x64 | Supported | Uses hostdb binaries |
| linux | arm64 | Supported | Uses hostdb binaries |
| win32 | x64 | Supported | Backup/restore has issues (see below) |

### Windows Backup/Restore Limitation

Windows backup/restore **fails** due to an upstream Meilisearch bug:
- Snapshot creation fails with page size alignment error
- This is a Meilisearch issue, not SpinDB

Server operations (start, stop, indexing) work correctly on Windows.

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz`
- **Windows**: `zip`

### Archive Structure
```
meilisearch/
└── bin/
    └── meilisearch      # Server binary
```

### Version Map Sync

```typescript
export const MEILISEARCH_VERSION_MAP: Record<string, string> = {
  '1': '1.33.1',
}
```

## Implementation Details

### Binary Manager

Meilisearch uses `BaseBinaryManager` with standard configuration.

### Version Parsing

- **Version output format**: `meilisearch 1.33.1` or `v1.33.1`
- **Parse pattern**: `/(?:meilisearch\s+)?v?(\d+\.\d+\.\d+)/`

### REST API Engine

Meilisearch is a **REST API engine**:
- `spindb run` is **NOT applicable**
- `spindb connect` opens the web dashboard in browser
- All operations use HTTP REST API

### Single Port

Unlike Qdrant (dual ports), Meilisearch only uses HTTP:
- **HTTP Port** (default 7700): REST API and dashboard

### Default Configuration

- **Default Port**: 7700 (auto-increments on conflict)
- **Health Endpoint**: `/health` (returns `{"status":"available"}`)
- **Dashboard**: `/` (root path, NOT `/dashboard`)
- **PID File**: `meilisearch.pid` in container directory

### Index Naming

Meilisearch uses "indexes" instead of "databases":
- Index UIDs only allow **alphanumeric characters and underscores**
- Container names with dashes are auto-converted: `my-app` -> index `my_app`

### Connection String Format

```
http://127.0.0.1:{port}
```

### Web Dashboard

Meilisearch dashboard is at the root path:
```
http://localhost:{port}/
```

(NOT `/dashboard` like Qdrant)

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| snapshot | `.snapshot` | REST API | Meilisearch native snapshot |

### Snapshot Directory Placement - CRITICAL

**MUST be a sibling of data directory, NOT inside it.**

```
container/
├── data/           # Meilisearch data (--db-path)
└── snapshots/      # Snapshot directory (--snapshot-dir)
```

**NOT:**
```
container/
└── data/
    └── snapshots/  # WRONG - causes "failed to infer version" error
```

If `--snapshot-dir` points inside `--db-path`, Meilisearch fails with:
> "failed to infer the version of the database"

### Windows Backup Failure

On Windows, snapshot creation fails with page size alignment errors. This is an upstream Meilisearch bug.

## Integration Test Notes

### REST API Testing

Integration tests use `fetch()` or `curl`.

### Test Fixtures

Located in `tests/fixtures/meilisearch/seeds/`:
- `README.md` documenting the API-based approach

## Docker E2E Test Notes

Meilisearch Docker E2E uses `curl`:

```bash
# Health check
curl http://localhost:7700/health

# Create index
curl -X POST http://localhost:7700/indexes \
  -H 'Content-Type: application/json' \
  -d '{"uid":"movies","primaryKey":"id"}'

# Add documents
curl -X POST http://localhost:7700/indexes/movies/documents \
  -H 'Content-Type: application/json' \
  -d '[{"id":1,"title":"Batman"}]'
```

### Backup/Restore Skipped in Docker E2E

Meilisearch backup/restore tests are skipped in Docker E2E (covered by integration tests).

## Known Issues & Gotchas

### 1. No CLI Shell

`spindb run` does nothing for Meilisearch. Use the REST API or web dashboard.

### 2. Dashboard at Root

The dashboard is at `/` (root), not `/dashboard`. Different from Qdrant.

### 3. Snapshot Directory Location

Snapshot directory **must be sibling** of data directory. This is the most common Meilisearch configuration issue.

### 4. Index UID Constraints

Index UIDs only allow `[a-zA-Z0-9_]`. Dashes cause API errors:
```
# Invalid: my-movies
# Valid: my_movies
```

### 5. Windows Backup Broken

Snapshot creation fails on Windows due to page size alignment bug. This is a Meilisearch upstream issue.

### 6. Health Endpoint

Use `/health` (not `/healthz` like Qdrant) for health checks.

## CI/CD Notes

### curl-Based Testing

CI tests use `curl` commands.

### Windows Backup Tests Skipped

Backup/restore tests are skipped on Windows due to upstream bug.

### GitHub Actions Cache Step

```yaml
- name: Cache Meilisearch binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/meilisearch-*
    key: meilisearch-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/meilisearch/version-maps.ts') }}
```

## REST API Quick Reference

### Indexes
```bash
# List indexes
GET /indexes

# Create index
POST /indexes
{"uid": "movies", "primaryKey": "id"}

# Get index
GET /indexes/{uid}

# Delete index
DELETE /indexes/{uid}
```

### Documents
```bash
# Add documents
POST /indexes/{uid}/documents

# Get document
GET /indexes/{uid}/documents/{id}

# Search
POST /indexes/{uid}/search
{"q": "search query"}
```

### Snapshots
```bash
# Create snapshot
POST /snapshots
```

### Health
```bash
# Health check
GET /health
# Returns: {"status": "available"}
```
