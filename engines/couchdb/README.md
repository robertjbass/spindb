# CouchDB Engine Implementation

## Overview

CouchDB is a document-oriented database with a REST API. Like Qdrant and Meilisearch, it uses HTTP for all operations. CouchDB includes the Fauxton web dashboard.

## Platform Support

| Platform | Architecture | Status | Notes |
|----------|--------------|--------|-------|
| darwin | x64 | Supported | Uses hostdb binaries |
| darwin | arm64 | Supported | Uses hostdb binaries (Apple Silicon) |
| linux | x64 | Supported | Uses hostdb binaries |
| linux | arm64 | Supported | Uses hostdb binaries |
| win32 | x64 | Supported | Uses `.cmd` batch file (see below) |

### Windows Binary - .cmd Not .exe

**Critical**: CouchDB on Windows uses a **batch file** (`couchdb.cmd`), not an executable:

```text
couchdb/bin/couchdb.cmd    # NOT couchdb.exe
```

The binary manager has a helper `getCouchDBExtension()` that returns `.cmd` on Windows.

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz`
- **Windows**: `zip`

### Archive Structure
```text
couchdb/
├── bin/
│   ├── couchdb           # Unix: shell script
│   └── couchdb.cmd       # Windows: batch file
├── lib/                  # Erlang libraries
├── etc/                  # Configuration
└── share/               # Data files
```

### CouchDB is an Erlang Application

CouchDB is written in Erlang. This has implications:
- No `--version` flag (Erlang tries to start on any arguments)
- Binary verification only checks file existence
- Startup involves the Erlang runtime

### Version Map Sync

```typescript
export const COUCHDB_VERSION_MAP: Record<string, string> = {
  '3': '3.5.1',
}
```

## Implementation Details

### Binary Manager

CouchDB uses `BaseBinaryManager` with a custom `verify()` override:

```typescript
// CouchDB doesn't support --version (tries to start)
// Verification just checks binary existence
async verify(): Promise<boolean> {
  return existsSync(binaryPath)
}
```

### REST API Engine

CouchDB is a **REST API engine**:
- `spindb run` is **NOT applicable**
- `spindb connect` opens Fauxton dashboard in browser
- All operations use HTTP REST API

### Default Configuration

- **Default Port**: 5984 (auto-increments on conflict)
- **Health Endpoint**: `/` (root - returns JSON with version)
- **Dashboard (Fauxton)**: `/_utils`
- **Default Credentials**: `admin` / `admin`
- **PID File**: `couchdb.pid` in container directory

### Fauxton Authentication

CouchDB 3.x requires an admin account. Even with `require_valid_user = false`:
- Fauxton's session-based auth still shows a login screen
- Default credentials: `admin` / `admin`
- The shell handler shows credentials before opening browser

### Connection String Format

```text
http://127.0.0.1:{port}/{database}
```

### Web Dashboard (Fauxton)

Fauxton dashboard is at:
```text
http://localhost:{port}/_utils
```

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| json | `.json` | REST API | JSON documents |

### Backup Method

Uses CouchDB's bulk document APIs:
- `GET /{db}/_all_docs?include_docs=true` - Export all documents
- `POST /{db}/_bulk_docs` - Import documents

### No Native Snapshot

Unlike Qdrant/Meilisearch, CouchDB doesn't have a native snapshot format. Backup is JSON export.

## Integration Test Notes

### REST API Testing

Integration tests use `fetch()` or `curl`.

### Test Fixtures

Located in `tests/fixtures/couchdb/seeds/`:
- `README.md` documenting the API-based approach

## Docker E2E Test Notes

CouchDB Docker E2E uses `curl`:

```bash
# Health check
curl http://localhost:5984/

# Create database
curl -X PUT http://admin:admin@localhost:5984/mydb

# Add document
curl -X POST http://admin:admin@localhost:5984/mydb \
  -H 'Content-Type: application/json' \
  -d '{"name":"test"}'
```

### Backup/Restore Skipped in Docker E2E

CouchDB backup/restore tests are skipped in Docker E2E (covered by integration tests).

## Known Issues & Gotchas

### 1. No --version Flag

CouchDB is an Erlang application that tries to start when run with any arguments. You cannot run `couchdb --version`. Binary verification only checks file existence.

### 2. Windows Uses .cmd

On Windows, the binary is `couchdb.cmd` (batch file), NOT `couchdb.exe`. This is handled by `getCouchDBExtension()`.

### 3. No CLI Shell

`spindb run` does nothing for CouchDB. Use the REST API or Fauxton.

### 4. Authentication Required

Fauxton requires authentication even for local development:
- Username: `admin`
- Password: `admin`

### 5. Database Creation is Explicit

Unlike MongoDB, databases must be explicitly created via PUT request:
```bash
curl -X PUT http://admin:admin@localhost:5984/newdb
```

### 6. Health Check at Root

The root path `/` returns health/version info:
```json
{"couchdb":"Welcome","version":"3.5.1","features":[...]}
```

## CI/CD Notes

### curl-Based Testing

CI tests use `curl` commands.

### GitHub Actions Cache Step

```yaml
- name: Cache CouchDB binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/couchdb-*
    key: couchdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/couchdb/version-maps.ts') }}
```

## REST API Quick Reference

### Databases
```bash
# List databases
GET /_all_dbs

# Create database
PUT /{db}

# Delete database
DELETE /{db}

# Get database info
GET /{db}
```

### Documents
```bash
# Create document (server-generated ID)
POST /{db}

# Create/update document (specified ID)
PUT /{db}/{id}

# Get document
GET /{db}/{id}

# Delete document
DELETE /{db}/{id}?rev={rev}
```

### Bulk Operations
```bash
# Get all documents
GET /{db}/_all_docs?include_docs=true

# Bulk insert
POST /{db}/_bulk_docs
{"docs": [...]}
```

### Admin
```bash
# Server info/health
GET /

# Session info
GET /_session
```
