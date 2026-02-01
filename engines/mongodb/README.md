# MongoDB Engine Implementation

## Overview

MongoDB is a document database with JavaScript-based queries. SpinDB downloads MongoDB binaries from hostdb and manages them with `mongod` server and `mongosh` shell.

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
mongodb/
├── bin/
│   ├── mongod           # Server binary
│   ├── mongos           # Sharding router
│   └── mongosh          # Interactive shell
└── lib/                 # Shared libraries (if any)
```

### macOS Extended Attributes Recovery

The `BaseDocumentBinaryManager` includes special handling for macOS extended attribute files (`._*` prefix) that may cause tar extraction warnings. The manager recovers from these non-fatal warnings.

### Version Map Sync

```typescript
export const MONGODB_VERSION_MAP: Record<string, string> = {
  '7.0': '7.0.28',
  '8.0': '8.0.x',
  '8.2': '8.2.x',
}
```

## Implementation Details

### Binary Manager

MongoDB uses `BaseDocumentBinaryManager` which extends the base manager with:
- macOS tar recovery for extended attribute files
- Major version matching for verification

### Version Parsing

- **Version output format**: `db version v7.0.28` or fallback to semantic version
- **Parse pattern**: `/db version v(\d+\.\d+\.\d+)/` then fallback to `/(\d+\.\d+\.\d+)/`
- **Major version matching**: Only major version needs to match for verification

### Default Configuration

- **Default Port**: 27017 (auto-increments on conflict)
- **Default Database**: Name derived from container name
- **PID File**: `mongod.pid` in container directory

### Implicit Database Creation

MongoDB/FerretDB don't create databases until data is written. To force immediate creation (so databases appear in tools like TablePlus):

```javascript
// createDatabase() implementation:
db.getCollection('_spindb_init').insertOne({})
db.getCollection('_spindb_init').drop()
```

This creates and immediately drops a temporary collection, leaving the database visible.

### Connection String Format

```
mongodb://127.0.0.1:{port}/{database}
```

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| bson | (directory) | mongodump | Directory with BSON files |
| archive | `.archive` | mongodump --archive | Single file archive |

### Restore Methods

- **BSON directory**: Restored via `mongorestore`
- **Archive format**: Restored via `mongorestore --archive`

## Integration Test Notes

### Reserved Ports

MongoDB integration tests use port ranges to avoid conflicts with default MongoDB installations.

### Test Fixtures

Located in `tests/fixtures/mongodb/seeds/`:
- Test documents for data operations

### Shell Scripts

MongoDB uses `mongosh` (modern shell) for script execution, not the legacy `mongo` shell.

## Docker E2E Test Notes

MongoDB is tested in Docker E2E with:
- Container lifecycle
- Database operations
- BSON and archive backup/restore
- Multi-database support

## Known Issues & Gotchas

### 1. mongosh vs mongo

SpinDB uses `mongosh` (the modern MongoDB Shell). The legacy `mongo` shell is deprecated and not bundled.

### 2. macOS Tar Warnings

When extracting MongoDB archives on macOS, tar may emit warnings about `._*` extended attribute files. The `BaseDocumentBinaryManager` handles these warnings gracefully without failing extraction.

### 3. Database Visibility

Databases in MongoDB don't appear in `show dbs` until they contain data. The `createDatabase()` method uses the temp collection trick to force visibility.

### 4. Windows Detached Spawn

On Windows, MongoDB uses detached spawn with `windowsHide: true` for background operation. The process is tracked via PID file.

### 5. Slow Initial Startup

First startup may take longer as MongoDB initializes WiredTiger storage engine.

## CI/CD Notes

### GitHub Actions Cache Step

```yaml
- name: Cache MongoDB binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/mongodb-*
    key: mongodb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/mongodb/version-maps.ts') }}
```

### Docker E2E Alias

```bash
pnpm test:docker -- mongo
# or
pnpm test:docker -- mongodb
```
