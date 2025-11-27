# SpinDB TODO

## Monetization Ideas

Similar to ngrok - free tier for individual developers with core functionality, paid tiers for power users and teams.

- **Free**: Full local dev experience, unlimited containers, basic backup/restore
- **Pro** ($X/month): Security features, multi-engine support, advanced features
- **Team** ($X/user/month): Shared configs, team collaboration, priority support

## Free Features

### High Priority
- [ ] **Run SQL file** - Add menu option to run a `.sql` file against a container (wrapper around `psql -f`)
- [ ] **Backup command** - Add `spindb backup` to create dumps using `pg_dump`
- [ ] **Logs command** - Add `spindb logs <container>` to tail `postgres.log`
- [x] **Engine/binary management** - Menu to list installed PostgreSQL versions, install new versions, uninstall unused versions (free up disk space)

### Medium Priority
- [x] **Container rename** - Rename a container without cloning/deleting (via Edit menu)
- [ ] **Database rename** - Rename a database within a container (requires stopping container, running `ALTER DATABASE ... RENAME TO ...`, updating config)
- [x] **Export connection string** - Copy connection string to clipboard (via container submenu)
- [ ] **Multiple databases per container** - List/create/delete databases within a container
- [x] **Fetch available versions** - Query Maven Central API to show all available PostgreSQL versions instead of hardcoded list

### Low Priority
- [ ] **SQLite support** - Add SQLite engine
- [ ] **Health checks** - Periodic connection tests to verify containers are responsive
- [ ] **Offline Support** - Package binaries locally for offline installation
- [ ] **Binary caching** - Cache downloaded binaries locally to avoid re-downloading
- [ ] **Binary version management** - List, install, and remove different PostgreSQL versions
- [ ] **Binary verification** - Verify downloaded binaries with checksums
- [ ] **Binary cleanup** - Remove old cached binaries to free up disk space
- [ ] **Binary space monitoring** - Show disk usage of cached binaries
- [ ] **Binary auto-cleanup** - Automatically remove old versions after a retention period

---

## Paid Features (Pro)

### Security
- [ ] **Password support** - Set password on container creation, modify `pg_hba.conf` for password auth
- [ ] **Encrypted backups** - Encrypt dumps with password using gpg/openssl

### Multi-Engine Support
- [ ] **MySQL support** - Add MySQL engine (needs binary source)
- [ ] **MongoDB support** - Add MongoDB engine

### Advanced Features
- [ ] **Container templates** - Save container configs as reusable templates
- [ ] **Import from Docker** - Import data from Docker PostgreSQL containers
- [ ] **Automatic binary updates** - Check for and download newer PostgreSQL versions
- [ ] **Custom superuser name** - Allow changing from default `postgres` user
- [ ] **Scheduled backups** - Cron-like backup scheduling
- [ ] **Cloud backup sync** - Sync backups to S3/GCS/Azure

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

- **No Windows support** - zonky.io doesn't provide Windows binaries
- **Client tools required** - psql/pg_dump/pg_restore must be installed separately (not bundled)
- **Local only** - No remote connection support (binds to 127.0.0.1)


## System Integration Tests

Tests that verify the full container lifecycle using real database processes and filesystem operations.

**Run tests:** `pnpm test`

### Test Configuration

```typescript
// Default test ports (will auto-increment if in use)
const TEST_PORTS = {
  postgresql: { base: 5454, clone: 5456, renamed: 5455 },
  mysql: { base: 3333, clone: 3335, renamed: 3334 },
}
```

### Test Suites

#### PostgreSQL Integration Tests
1. **Cleanup** - Delete any existing containers matching `*-test*` pattern
2. **Create without start** - Create container with `--no-start`, verify not running
3. **Start container** - Start the container, verify running
4. **Seed database** - Run `tests/seeds/postgresql/sample-db.sql`, verify data inserted
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

#### MySQL Integration Tests
Same test cases as PostgreSQL, using MySQL-specific:
- Seed file: `tests/seeds/mysql/sample-db.sql`
- Connection string: `mysql://root@127.0.0.1:{port}/{db}`
- Port range: 3333-3400

### Test Helpers

- `findConsecutiveFreePorts(count, startPort)` - Find N consecutive available ports
- `cleanupTestContainers()` - Delete all containers matching `*-test*`
- `executeSQL(engine, port, database, sql)` - Run SQL and return results
- `waitForReady(engine, port, timeout)` - Wait for database to accept connections

### Future Improvements

- [ ] **Port pre-allocation** - Reserve ports at test start to prevent race conditions
- [ ] **Parallel test isolation** - Run PostgreSQL and MySQL tests in parallel safely
- [ ] **Backup/restore round-trip** - Dump → delete row → restore → verify row is back
- [ ] **Binary download test** - Test first-time PostgreSQL binary download (CI only)