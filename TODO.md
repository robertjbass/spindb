# SpinDB TODO

## Monetization Ideas

Similar to ngrok - free tier for individual developers with core functionality, paid tiers for power users and teams.

- **Free**: Full local dev experience, unlimited containers, basic backup/restore
- **Pro** ($X/month): Security features, advanced features
- **Team** ($X/user/month): Shared configs, team collaboration, priority support

## Free Features

### High Priority
- [ ] **Run SQL file** - Add menu option to run a `.sql` file against a container (wrapper around `psql -f` / `mysql <`)
- [ ] **Backup command** - Add `spindb backup` to create dumps using `pg_dump` / `mysqldump`
- [ ] **Logs command** - Add `spindb logs <container>` to tail `postgres.log` / `mysql.log`
- [x] **Engine/binary management** - Menu to list installed PostgreSQL versions, install new versions, uninstall unused versions (free up disk space)
- [x] **MySQL support** - Add MySQL engine using system-installed MySQL binaries
- [x] **MariaDB support** - Automatically detect and support MariaDB as MySQL alternative on Linux

### Medium Priority
- [x] **Container rename** - Rename a container without cloning/deleting (via Edit menu)
- [ ] **Database rename** - Rename a database within a container (requires stopping container, running `ALTER DATABASE ... RENAME TO ...`, updating config)
- [x] **Export connection string** - Copy connection string to clipboard (via container submenu)
- [ ] **Multiple databases per container** - List/create/delete databases within a container
- [x] **Fetch available versions** - Query Maven Central API to show all available PostgreSQL versions instead of hardcoded list
- [x] **Engine-aware shell** - Open shell uses psql for PostgreSQL, mysql for MySQL
- [x] **Cross-engine dump detection** - Detect and error when restoring wrong engine dump (e.g., MySQL dump to PostgreSQL)
- [x] **Version compatibility validation** - Warn/error when dump version is incompatible with client version

### Low Priority
- [ ] **SQLite support** - Add SQLite engine
- [ ] **Health checks** - Periodic connection tests to verify containers are responsive
- [ ] **Offline Support** - Package binaries locally for offline installation
- [ ] **Binary caching** - Cache downloaded binaries locally to avoid re-downloading
- [ ] **Binary verification** - Verify downloaded binaries with checksums

---

## Paid Features (Pro)

### Security
- [ ] **Password support** - Set password on container creation, modify auth config for password auth
- [ ] **Encrypted backups** - Encrypt dumps with password using gpg/openssl

### Advanced Features
- [ ] **Container templates** - Save container configs as reusable templates
- [ ] **Import from Docker** - Import data from Docker PostgreSQL/MySQL containers
- [ ] **Automatic binary updates** - Check for and download newer PostgreSQL versions
- [ ] **Custom superuser name** - Allow changing from default `postgres`/`root` user
- [ ] **Scheduled backups** - Cron-like backup scheduling
- [ ] **Cloud backup sync** - Sync backups to S3/GCS/Azure
- [ ] **MongoDB support** - Add MongoDB engine

### Team Features
- [ ] **Shared configs** - Export/import container configs for team sharing
- [ ] **Config profiles** - Dev/staging/test profiles with different settings

---

## Stretch Goals

- [ ] **Terminal-based IDE** - Full TUI (terminal UI) for browsing tables, running queries, viewing results, editing data inline (think `lazygit` but for databases)
  - Potential libraries: [blessed](https://github.com/chjj/blessed), [ink](https://github.com/vadimdemedes/ink), [terminal-kit](https://github.com/cronvel/terminal-kit)
  - Inspiration: `lazygit`, `k9s`, `pgcli`

---

## Known Limitations

- **No Windows support** - zonky.io doesn't provide Windows PostgreSQL binaries
- **Client tools required** - psql/pg_dump/pg_restore and mysql/mysqldump must be installed separately (not bundled)
- **Local only** - No remote connection support (binds to 127.0.0.1)
- **MySQL uses system binaries** - Unlike PostgreSQL, MySQL requires system installation


## System Integration Tests

Tests that verify the full container lifecycle using real database processes and filesystem operations.

**Run tests:**
```bash
pnpm test           # Run all tests (PostgreSQL + MySQL sequentially)
pnpm test:pg        # PostgreSQL tests only
pnpm test:mysql     # MySQL tests only
```

### Test Configuration

```typescript
// Default test ports (will auto-increment if in use)
const TEST_PORTS = {
  postgresql: { base: 5454, clone: 5456, renamed: 5455 },
  mysql: { base: 3333, clone: 3335, renamed: 3334 },
}
```

### Test Suites

#### PostgreSQL Integration Tests (14 tests)
1. **Cleanup** - Delete any existing containers matching `*-test*` pattern
2. **Create without start** - Create container with `--no-start`, verify not running
3. **Start container** - Start the container, verify running
4. **Seed database** - Run `tests/fixtures/postgresql/seeds/sample-db.sql`, verify data inserted
5. **Query data** - Query the seeded table, record row count
6. **Create from dump** - Use `--from` with connection string to create new container with data
7. **Verify restored data** - Query restored container, verify row count matches
8. **Stop and delete restored container** - Clean up, verify filesystem removed
9. **Modify original data** - Delete 1 row from original container
10. **Edit container** - Rename container and change port
11. **Verify persistence** - Start renamed container, verify row count reflects deletion
12. **Port conflict handling** - Create container on busy port, verify auto-increment
13. **Start already running** - Attempt to start running container, verify warning (not error)
14. **Stop already stopped** - Attempt to stop stopped container, verify warning (not error)
15. **Delete container** - Delete with `--force`, verify filesystem and list updated
16. **Final cleanup** - Ensure no test containers remain

#### MySQL Integration Tests (14 tests)
Same test cases as PostgreSQL, using MySQL-specific:
- Seed file: `tests/fixtures/mysql/seeds/sample-db.sql`
- Connection string: `mysql://root@127.0.0.1:{port}/{db}`
- Port range: 3333-3400

### Test Helpers

Located in `tests/integration/helpers.ts`:

- `generateTestName(prefix)` - Generate unique test container name
- `findConsecutiveFreePorts(count, startPort)` - Find N consecutive available ports
- `cleanupTestContainers()` - Delete all containers matching `*-test*`
- `executeSQL(engine, port, database, sql)` - Run SQL and return results
- `executeSQLFile(engine, port, database, filePath)` - Run SQL file
- `getRowCount(engine, port, database, table)` - Get row count from table
- `waitForReady(engine, port, timeout)` - Wait for database to accept connections
- `containerDataExists(containerName, engine)` - Check if data directory exists
- `getConnectionString(engine, port, database)` - Get connection string
- `assert(condition, message)` - Assert helper
- `assertEqual(actual, expected, message)` - Assert equality helper

### Future Improvements

- [ ] **Port pre-allocation** - Reserve ports at test start to prevent race conditions
- [ ] **Parallel test isolation** - Run PostgreSQL and MySQL tests in parallel safely
- [ ] **Backup/restore round-trip** - Dump → delete row → restore → verify row is back
- [ ] **Binary download test** - Test first-time PostgreSQL binary download (CI only)
- [x] **Cross-engine format detection tests** - Unit tests for detecting wrong-engine dumps
- [x] **MySQL dump version parsing tests** - Unit tests for parsing MySQL/MariaDB dump file headers
- [x] **MySQL 5.7 fixture** - Test fixture for MySQL 5.7 LTS version dumps


---

# Dump/Restore Notes:

## Postgres

for pg_restore the version info can be found in the dump file like this:

### Method 1: Use pg_restore to show TOC (Table of Contents)
`pg_restore --list _dumps/{filename}.dump | head -20`
to see this:

```bash
; Archive created at 2025-11-25 14:12:57 CST
;     dbname: database_name
;     TOC Entries: 1524
;     Compression: gzip
;     Dump Version: 1.15-0
;     Format: CUSTOM
;     Integer: 4 bytes
;     Offset: 8 bytes
;     Dumped from database version: 16.9 (415ebe8)
;     Dumped by pg_dump version: 16.0
```

### Method 2: Use strings to extract version info
`strings _dumps/{filename}.dump | head -10`
to see this:

```bash
strings _dumps/database_name.dump | head -10
PGDMP
efficientdb
16.9 (415ebe8)
16.0
ENCODING
ENCODING
SET client_encoding = 'UTF8';
false
STDSTRINGS
STDSTRINGS
```