# MariaDB Engine Implementation

## Overview

MariaDB is a MySQL-compatible SQL database. SpinDB downloads MariaDB binaries from hostdb and manages them with MySQL-compatible tooling.

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
mariadb/
├── bin/
│   ├── mariadbd         # Server binary (newer versions)
│   ├── mysqld           # Server binary (legacy fallback)
│   ├── mariadb          # Client binary (newer versions)
│   ├── mysql            # Client binary (legacy fallback)
│   ├── mariadb-dump     # Backup utility
│   └── mysqldump        # Backup utility (legacy)
├── lib/                 # Shared libraries
└── share/               # Configuration files
```

### Server Binary Names

MariaDB has transitioned binary names over versions:
- **Newer versions (11.x+)**: `mariadbd`, `mariadb`, `mariadb-dump`
- **Legacy versions (10.x)**: `mysqld`, `mysql`, `mysqldump`

The binary manager checks for both names: `['mariadbd', 'mysqld']`

### Version Map Sync

```typescript
export const MARIADB_VERSION_MAP: Record<string, string> = {
  '10.11': '10.11.15',
  '11.4': '11.4.5',
  '11.8': '11.8.5',
}
```

## Implementation Details

### Binary Manager

MariaDB uses `BaseServerBinaryManager` with configuration for multiple server binary names:

```typescript
serverBinaryNames: ['mariadbd', 'mysqld']
```

### Version Parsing

- **Version output format**: `mariadbd  Ver 11.8.5-MariaDB`
- **Parse pattern**: `/Ver\s+([\d.]+)/`
- **Strip trailing .0**: Same handling as MySQL

### Default Configuration

- **Default Port**: 3306 (same as MySQL, auto-increments on conflict)
- **Default Database**: Name derived from container name
- **PID File**: `mariadb.pid` in container directory

### Connection String Format

```text
mysql://127.0.0.1:{port}/{database}
```

Note: Uses `mysql://` scheme for client compatibility.

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| sql | `.sql` | mariadb-dump/mysqldump | Plain text SQL |
| compressed | `.sql.gz` | dump + gzip | Compressed SQL |

### Tool Detection

The engine detects whether to use `mariadb-dump` or `mysqldump` based on which is available in the binary directory.

## Integration Test Notes

### Port Allocation

MariaDB tests may share port range with MySQL tests. Ensure test isolation.

### Test Fixtures

Located in `tests/fixtures/mariadb/seeds/`:
- `sample-db.sql`: Contains 5 test_user records

## Docker E2E Test Notes

MariaDB is tested in Docker E2E with MySQL-compatible operations.

## Known Issues & Gotchas

### 1. Binary Name Transition

The transition from `mysqld` to `mariadbd` means the engine must check for both binaries. Always test with both old and new MariaDB versions.

### 2. MySQL Compatibility

MariaDB uses the `mysql://` connection scheme for client compatibility, even though it's a different database.

### 3. Port Conflict with MySQL

MariaDB and MySQL share the default port 3306. SpinDB prevents conflicts via auto-increment, but users should be aware of potential issues if running both.

### 4. Client Tool Naming

Client tools like `mariadb-dump` are preferred, but `mysqldump` is used as fallback. The engine's tool detection handles this transparently.

## CI/CD Notes

### GitHub Actions Cache Step

```yaml
- name: Cache MariaDB binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/mariadb-*
    key: mariadb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/mariadb/version-maps.ts') }}
```
