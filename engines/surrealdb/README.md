# SurrealDB Engine Implementation

## Overview

SurrealDB is a multi-model database supporting document, graph, and relational paradigms. It uses SurrealQL (SQL-like with graph traversal) for queries.

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
surrealdb/
└── bin/
    └── surreal          # Unified binary
```

### Version Map Sync

```typescript
export const SURREALDB_VERSION_MAP: Record<string, string> = {
  '2': '2.3.2',
}
```

## Implementation Details

### Binary Manager

SurrealDB uses `BaseBinaryManager` with standard configuration.

### Version Parsing

- **Version output format**: `surreal 2.3.2 for linux on x86_64` or just `2.3.2`
- **Parse pattern**: `/(\d+\.\d+\.\d+)/`

### Default Configuration

- **Default Port**: 8000 (auto-increments on conflict)
- **Default Credentials**: `root` / `root`
- **Storage Backend**: SurrealKV (`surrealkv://path`)
- **Hierarchy**: Root > Namespace > Database
- **PID File**: `surrealdb.pid` in container directory

### Namespace Derivation

Namespace is derived from container name:
- `my-app` -> namespace `my_app` (dashes replaced with underscores)
- Default database: `test`

### Connection Schemes

- **WebSocket**: `ws://127.0.0.1:{port}` (for real-time queries)
- **HTTP**: `http://127.0.0.1:{port}` (REST API)

### Critical: Background Process Stdio

Like CockroachDB, **MUST use `stdio: ['ignore', 'ignore', 'ignore']`**:

```typescript
const proc = spawn(surrealBinary, args, {
  stdio: ['ignore', 'ignore', 'ignore'],  // NOT 'pipe'
  detached: true,
  cwd: containerDir,  // For history file
  windowsHide: true,
})
proc.unref()
```

Using `'pipe'` causes hangs in Docker/CI environments.

### History File Handling

SurrealDB writes `history.txt` to CWD. The engine sets `cwd` to container directory so history is stored in `~/.spindb/containers/surrealdb/<name>/history.txt` rather than polluting user's working directory.

### Startup Command

```bash
surreal start \
  --bind 127.0.0.1:{port} \
  --user root \
  --pass root \
  surrealkv://{dataDir}
```

### Health Check

```bash
surreal isready --endpoint http://127.0.0.1:{port}
```

### CLI Shell

```bash
surreal sql --endpoint ws://127.0.0.1:{port}
```

### Scripting Flag

Use `--hide-welcome` with `surreal sql` to suppress the welcome banner for scriptable/parseable output. The engine uses this automatically for non-interactive commands.

## Backup & Restore

### Backup Method

Uses SurrealDB's native export/import:
- `surreal export` - Creates SurrealQL script
- `surreal import` - Restores from SurrealQL script

## Integration Test Notes

### Test Fixtures

Located in `tests/fixtures/surrealdb/seeds/`:
- SurrealQL scripts for testing

## Docker E2E Test Notes

SurrealDB Docker E2E tests verify:
- Server lifecycle
- SurrealQL operations
- Multi-model features (if tested)
- Export/import

## Known Issues & Gotchas

### 1. stdio Must Be 'ignore'

**Critical**: Same as CockroachDB - using `stdio: 'pipe'` causes hangs. Always use `['ignore', 'ignore', 'ignore']`.

### 2. History File Pollution

Without setting `cwd`, SurrealDB writes `history.txt` to user's working directory. The engine sets `cwd` to container directory.

### 3. Namespace/Database Hierarchy

SurrealDB has a three-level hierarchy:
- Root (authentication level)
- Namespace (derived from container name)
- Database (default: `test`)

This differs from most other databases.

### 4. WebSocket vs HTTP

SurrealDB supports both WebSocket (`ws://`) and HTTP (`http://`) connections:
- WebSocket: For real-time subscriptions
- HTTP: For REST-style requests

### 5. Multi-Model Complexity

SurrealDB supports document, graph, and relational models. Queries can combine paradigms, which can be confusing for new users.

### 6. --hide-welcome Flag

For scripting, always use `--hide-welcome` to suppress the interactive welcome banner.

## CI/CD Notes

### GitHub Actions Cache Step

```yaml
- name: Cache SurrealDB binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/surrealdb-*
    key: surrealdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/surrealdb/version-maps.ts') }}
```

## SurrealQL Quick Reference

### Namespace & Database
```sql
USE NS my_namespace DB my_database;
```

### Records
```sql
-- Create
CREATE user:john SET name = 'John', age = 30;

-- Select
SELECT * FROM user;

-- Update
UPDATE user:john SET age = 31;

-- Delete
DELETE user:john;
```

### Graph Traversal
```sql
-- Create relation
RELATE user:john->knows->user:jane;

-- Traverse
SELECT ->knows->user FROM user:john;
```

### Schema
```sql
DEFINE TABLE user SCHEMAFULL;
DEFINE FIELD name ON user TYPE string;
DEFINE FIELD age ON user TYPE int;
```
