# MySQL Engine Implementation

## Overview

MySQL is a traditional SQL database with full server-based lifecycle management. SpinDB downloads MySQL binaries from hostdb.

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
mysql/
├── bin/
│   ├── mysqld           # Server binary
│   ├── mysql            # Client binary
│   ├── mysqldump        # Backup utility
│   └── mysqladmin       # Admin utility
├── lib/                 # Shared libraries
└── share/               # Configuration files
```

### Version Map Sync

The `version-maps.ts` file must stay synchronized with hostdb's `releases.json`:

```typescript
export const MYSQL_VERSION_MAP: Record<string, string> = {
  '8.0': '8.0.40',
  '8.4': '8.4.3',
  '9': '9.5.0',
}
```

## Implementation Details

### Binary Manager

MySQL uses `BaseServerBinaryManager` with standard configuration.

### Version Parsing

- **Version output format**: `mysqld  Ver 8.0.40`
- **Parse pattern**: `/Ver\s+([\d.]+)/`
- **Strip trailing .0**: Handles 4-part versions like `8.0.40.0` -> `8.0.40`

### Server Binary Name

MySQL uses `mysqld` (with the 'd' for daemon) as the server binary, unlike PostgreSQL's `postgres`.

### Default Configuration

- **Default Port**: 3306 (auto-increments on conflict)
- **Default Database**: Name derived from container name
- **PID File**: `mysql.pid` in container directory

### Initialization

MySQL uses `mysqld --initialize-insecure` to create the data directory without root password, suitable for local development.

### Connection String Format

```text
mysql://127.0.0.1:{port}/{database}
```

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| sql | `.sql` | mysqldump | Plain text SQL |
| compressed | `.sql.gz` | mysqldump + gzip | Compressed SQL |

### Restore Methods

- **SQL format**: Restored via `mysql < file.sql`
- **Compressed format**: `gunzip -c file.sql.gz | mysql`

## Integration Test Notes

### Reserved Ports

Integration tests use reserved ports to avoid conflicts:
- **Test Ports**: 3333-3335 (NOT 3306)

### Test Fixtures

Located in `tests/fixtures/mysql/seeds/`:
- `sample-db.sql`: Contains 5 test_user records

## Docker E2E Test Notes

MySQL is tested in Docker E2E with full lifecycle verification:
- Container creation
- Server start/stop
- Database operations
- Backup and restore

## Known Issues & Gotchas

### 1. Initialization Time

MySQL's `--initialize-insecure` can take longer than other databases on first startup. The engine allows extended timeout for initial setup.

### 2. Socket vs TCP

By default, SpinDB configures MySQL to use TCP connections only (not Unix sockets) for consistency across platforms.

### 3. Root User

MySQL containers are created without a root password for local development convenience. The default user is 'root' with no password.

### 4. Slow Shutdown

MySQL may take several seconds to shut down gracefully. The engine waits for proper termination before reporting stopped status.

## CI/CD Notes

### GitHub Actions Cache Step

MySQL binaries are cached in CI:
```yaml
- name: Cache MySQL binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/mysql-*
    key: mysql-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/mysql/version-maps.ts') }}
```
