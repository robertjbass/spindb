# PostgreSQL Engine Implementation

## Overview

PostgreSQL is a traditional SQL database with full server-based lifecycle management. SpinDB downloads PostgreSQL binaries from hostdb and manages them locally.

## Platform Support

| Platform | Architecture | Status | Notes |
|----------|--------------|--------|-------|
| darwin | x64 | Supported | Uses hostdb binaries |
| darwin | arm64 | Supported | Uses hostdb binaries (Apple Silicon) |
| linux | x64 | Supported | Uses hostdb binaries |
| linux | arm64 | Supported | Uses hostdb binaries |
| win32 | x64 | Supported | Uses EDB binaries (uploaded to hostdb) |

### Windows Binary Source

PostgreSQL on Windows uses [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries) binaries. These are downloaded from EDB's CDN and uploaded to hostdb for consistency. File IDs are maintained in `edb-binary-urls.ts`.

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz`
- **Windows**: `zip`

### Archive Structure
```
postgresql/
├── bin/
│   ├── postgres         # Main server binary
│   ├── pg_ctl           # Server control utility
│   ├── initdb           # Database cluster initialization
│   ├── psql             # Interactive terminal
│   ├── pg_dump          # Backup utility
│   ├── pg_restore       # Restore utility
│   └── pg_basebackup    # Streaming backup
└── lib/                 # Shared libraries
```

### Version Map Sync

The `version-maps.ts` file must stay synchronized with hostdb's `releases.json`:

```typescript
export const POSTGRESQL_VERSION_MAP: Record<string, string> = {
  '15': '15.x.x',
  '16': '16.x.x',
  '17': '17.x.x',
  '18': '18.x.x',
}
```

## Implementation Details

### Binary Manager

PostgreSQL uses `BaseServerBinaryManager` with a custom `verify()` override for version parsing. This is necessary because:

1. PostgreSQL's version output differs between EDB and standard builds
2. Version format: `postgres (PostgreSQL) X.Y` or `postgres (PostgreSQL) X.Y - Percona Server for PostgreSQL X.Y.Z`

### Version Parsing Quirks

- **Strip trailing .0**: Versions like `17.0` are normalized to match `17`
- **Accept major.minor matches**: `18.1.0` matches requested version `18.1`
- **EDB format handling**: EDB binaries may include additional branding in version output

### Default Configuration

- **Default Port**: 5432 (auto-increments on conflict)
- **Default Database**: Name derived from container name
- **PID File**: `postmaster.pid` in container directory

### initdb and pg_ctl

PostgreSQL uses a two-step initialization:
1. `initdb` creates the data directory structure
2. `pg_ctl start` launches the server in background mode

### Connection String Format

```
postgresql://127.0.0.1:{port}/{database}
```

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| sql | `.sql` | pg_dump | Plain text SQL, portable |
| custom | `.dump` | pg_dump -Fc | Binary, supports parallel restore |

### Restore Methods

- **SQL format**: Restored via `psql -f`
- **Custom format**: Restored via `pg_restore`

## Integration Test Notes

### Reserved Ports

Integration tests use reserved ports to avoid conflicts:
- **Test Ports**: 5454-5456 (NOT 5432)

### Test Fixtures

Located in `tests/fixtures/postgresql/seeds/`:
- `sample-db.sql`: Contains 5 test_user records

## Docker E2E Test Notes

PostgreSQL is tested in Docker E2E with full lifecycle verification:
- Container creation with `initdb`
- Server start/stop
- Database operations
- Backup and restore
- Multi-database support

## Known Issues & Gotchas

### 1. Windows Binary Differences

Windows uses EDB binaries which have slightly different behavior:
- File paths use Windows conventions internally
- Some environment variables differ

### 2. Port Conflicts

When the default port is in use, SpinDB auto-increments (5432 -> 5433 -> etc.).

### 3. Connection Termination

Before dropping a database, active connections must be terminated. The engine uses:
```sql
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'dbname';
```

Special handling for single quotes in shell commands on different platforms.

### 4. Orphaned Container Support

If PostgreSQL binaries are deleted while containers exist, starting those containers prompts the user to re-download the binaries.

## CI/CD Notes

### GitHub Actions Cache Step

PostgreSQL binaries are cached in CI to speed up test runs:
```yaml
- name: Cache PostgreSQL binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/postgresql-*
    key: postgresql-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/postgresql/version-maps.ts') }}
```
