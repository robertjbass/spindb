# SpinDB TODO

## Monetization Ideas

Similar to ngrok - free tier for individual developers with core functionality, paid tiers for power users and teams.

- **Free**: Full local dev experience, unlimited containers, basic backup/restore
- **Pro** ($X/month): Security features, advanced features
- **Team** ($X/user/month): Shared configs, team collaboration, priority support

## Free Features

### High Priority
- [ ] **Run SQL file** - Add menu option to run a `.sql` file against a container (wrapper around `psql -f` / `mysql <`)
- [x] **Backup command** - Add `spindb backup` to create dumps using `pg_dump` / `mysqldump`
- [ ] **Logs command** - Add `spindb logs <container>` to tail `postgres.log` / `mysql.log`

### Medium Priority
- [ ] **Database rename** - Rename a database within a container (requires stopping container, running `ALTER DATABASE ... RENAME TO ...`, updating config)
- [x] **Multiple databases per container** - List/create/delete databases within a container (tracking via `databases[]` in container.json)
- [ ] **Multi-database container backup** - Bundle all databases in a container into a single proprietary archive format with metadata

### Low Priority
- [ ] **SQLite support** - Add SQLite engine
- [ ] **MongoDB support** - Add MongoDB engine
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
- [x] **Self-update** - `spindb self-update` command with automatic update notifications on startup
- [ ] **User management** - Support for custom usernames, passwords, and additional database users
  - Custom superuser name (instead of default `postgres`/`root`)
  - Set password on container creation
  - Create additional users with specific privileges
  - Store credentials securely (keychain integration?)
- [ ] **Scheduled backups** - Cron-like backup scheduling
- [ ] **Cloud backup sync** - Sync backups to S3/GCS/Azure
- [ ] **MongoDB support** - Add MongoDB engine

### Team Features
- [ ] **Shared configs** - Export/import container configs for team sharing
- [ ] **Config profiles** - Dev/staging/test profiles with different settings

---

## Stretch Goals

- [ ] **Desktop GUI (Tauri)** - System tray app showing running database status, with full GUI for container management. Separate repository.
- [ ] **Terminal-based IDE** - Full TUI (terminal UI) for browsing tables, running queries, viewing results, editing data inline (think `lazygit` but for databases)
  - Potential libraries: [blessed](https://github.com/chjj/blessed), [ink](https://github.com/vadimdemedes/ink), [terminal-kit](https://github.com/cronvel/terminal-kit)
  - Inspiration: `lazygit`, `k9s`, `pgcli`
- [ ] **Multi-database container backup** - Bundle all databases in a container into a single proprietary archive format with metadata
- [ ] **Multi-database container restore** - Restore all databases from a single proprietary archive format with metadata
- [ ] **Windows support** - Add Windows support for PostgreSQL
- [ ] **Windows support** - Add Windows support for MySQL
- [ ] **Offline support** - Add offline support for PostgreSQL
- [ ] **Offline support** - Add offline support for MySQL

---

## Brew Binary

Distribute SpinDB as a standalone Homebrew binary (no Node.js dependency).

### Approach: Standalone Binary with Bun

Compile TypeScript to a single executable using `bun build --compile`:

```bash
# Build standalone binary
bun build ./cli/bin.ts --compile --outfile dist/spindb
```

### Build Script

Add to `package.json`:
```json
"build:binary": "bun build ./cli/bin.ts --compile --outfile dist/spindb"
```

### Homebrew Formula

Create a tap at `github.com/robertjbass/homebrew-tap` with:

```ruby
# Formula/spindb.rb
class Spindb < Formula
  desc "Spin up local database containers without Docker"
  homepage "https://github.com/robertjbass/spindb"
  version "X.X.X"
  license "PolyForm-Noncommercial-1.0.0"

  on_macos do
    on_arm do
      url "https://github.com/robertjbass/spindb/releases/download/vX.X.X/spindb-darwin-arm64.tar.gz"
      sha256 "ARM64_CHECKSUM"
    end
    on_intel do
      url "https://github.com/robertjbass/spindb/releases/download/vX.X.X/spindb-darwin-x64.tar.gz"
      sha256 "X64_CHECKSUM"
    end
  end

  def install
    bin.install "spindb"
  end

  test do
    system bin/"spindb", "--version"
  end
end
```

### GitHub Release Workflow

Build binaries for multiple platforms in CI:
- `darwin-arm64` (Apple Silicon)
- `darwin-x64` (Intel Mac)
- `linux-x64` (Linux)

### User Installation

```bash
brew tap robertjbass/tap
brew install spindb
```

### Alternative Tools

| Tool | Notes |
|------|-------|
| [pkg](https://github.com/vercel/pkg) | Single binary with Node.js bundled |
| [bun build --compile](https://bun.sh/docs/bundler/executables) | Native executable (recommended) |
| [esbuild](https://esbuild.github.io/) + [caxa](https://github.com/leafac/caxa) | Bundled app |

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

- [ ] **Parallel test isolation** - Run PostgreSQL and MySQL tests in parallel safely
- [ ] **Backup/restore round-trip** - Dump → delete row → restore → verify row is back
- [ ] **Binary download test** - Test first-time PostgreSQL binary download (CI only)


---

## Desktop GUI Architecture (Future)

**Framework:** Tauri v2 (Rust backend + React frontend)
**Repository:** Separate repo (not monorepo) - avoids restructuring CLI, GUI shells out to `spindb` commands
**Bundle size:** ~10-15MB (vs ~150MB for Electron)

### Core Features (v1)
- System tray icon showing running database count/status
- Click tray icon to open main GUI window
- List all containers with status indicators
- Start/stop/delete containers
- Create new containers
- View connection strings

### Optional Features (user opt-in)
- Auto-updates via `tauri-plugin-updater`
- Launch on system startup via `tauri-plugin-autostart`

### Technical Approach
- Rust backend: Thin wrappers around `spindb` CLI commands via `std::process::Command`
- React frontend: Full TypeScript, component library TBD (Radix, shadcn, etc.)
- IPC: Tauri's `invoke` for React → Rust communication
- State: Poll `spindb list --json` periodically or on user action

### Future Enhancements
- Tray dropdown menu with quick start/stop (instead of opening full GUI)
- Native notifications for container events
- Database browser/query tool
