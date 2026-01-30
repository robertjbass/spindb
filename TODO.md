# TODO

## Triage

Quick capture for ideas that need review and prioritization:

-

---

## High Priority

- [ ] **Registry system for binary download locations** - Centralized configuration for where to download engine binaries
- [ ] **WSL proxy for Windows** - Create a proxy layer for Windows computers to use WSL seamlessly
- [ ] **Migrate binaries from hostdb to spindb** - Self-host compiled engine binaries under spindb infrastructure
- [ ] **Proxy/reverse-proxy MVP** - Build system to deploy directly to containers with network access
- [ ] **Git hook integration** - Add hooks for pre-commit, post-checkout, etc. to automate database workflows
- [ ] **Refine API** - Clean up and stabilize the programmatic API surface
- [ ] **Build package to mimic CLI** - Export package that provides CLI functionality programmatically
- [ ] **Rethink testing processes** - Optimize test suite for faster execution time
- [ ] **Default username/password for all engines** - Standardize credential defaults across all database engines

---

## Roadmap

### v1.1 - Remote Connections & Secrets

- [ ] **Remote database connections** - Connect to remote databases (not just local containers)
  - `spindb connect --remote "postgresql://user:pass@host:5432/db"`
  - Save remote connections in config for quick access
  - List saved remotes with `spindb remotes list`
- [ ] **Environment variable support** - Use env vars in connection strings
  - `spindb connect --remote "$DATABASE_URL"`
  - `spindb create mydb --from "$PROD_DATABASE_URL"`
- [ ] **Secrets management** - Secure credential storage
  - macOS Keychain integration for storing passwords
  - `spindb secrets set mydb-password`
  - `spindb secrets get mydb-password`
  - Reference secrets in connection strings: `postgresql://user:${secret:mydb-password}@host/db`

### v1.2 - Advanced Features

- [ ] **Database rename** - Rename databases within containers
- [ ] **Container templates** - Save/load container configurations
- [ ] **Scheduled backups** - Cron-like backup scheduling
- [ ] **Import from Docker** - Migrate data from Docker containers

---

## Backlog

### CLI Improvements

- [ ] **Export query results** - `spindb run <container> query.sql --format csv/json --output file`
- [ ] **Run multiple SQL files** - `spindb run <container> schema.sql seed.sql`
- [ ] **Health checks** - Periodic connection tests for container status
- [ ] **Add `--json` to remaining commands** - clone, connect, logs, run, edit, attach, detach

### Chained Commands

Combine common multi-step workflows into single commands:

| Proposed Command | Steps Combined | Example |
|------------------|----------------|---------|
| `spindb db create <container> <dbname> [--seed file.sql] [--connect]` | Create database + run seed file + open shell | `spindb db create myapp users --seed schema.sql --connect` |
| `spindb clone <container> <new-name> --start` | Clone container + start it | `spindb clone prod-backup local-test --start` |
| `spindb restore <container> <backup> --start` | Restore backup + start container | `spindb restore mydb backup.dump --start` |
| `spindb backup <container> --stop` | Stop container + create backup | `spindb backup mydb --stop` (for consistent backups) |

### Security (Pro)

- [ ] **Password authentication** - Set passwords on container creation
- [ ] **Encrypted backups** - GPG/OpenSSL encryption for dumps
- [ ] **User management** - Custom users with specific privileges

### Team Features (Pro)

- [ ] **Shared configs** - Export/import container configs
- [ ] **Config profiles** - Dev/staging/test environment profiles
- [ ] **Cloud backup sync** - S3/GCS/Azure backup storage

### Platform Support

- [ ] **Offline mode** - Bundle binaries for air-gapped environments
- [ ] **Parallel CI matrix for all 5 platforms** - Run engine tests in parallel across all supported OS/arch combinations
  - Runners: `macos-14` (ARM64), `macos-13` (Intel), `ubuntu-latest` (x64), `windows-latest` (x64)
  - linux-arm64: Requires `ubuntu-24.04-arm` or self-hosted runner
  - Trade-off: macOS runners cost 10x Linux minutes
- [ ] **Windows support for ClickHouse and FerretDB** - Currently not supported due to binary issues
  - **ClickHouse**: hostdb doesn't have Windows builds. Investigate MinGW/MSYS2 or WSL2 fallback
  - **FerretDB**: postgresql-documentdb fails to start on Windows. Debug or WSL2 fallback

### Distribution

- [ ] **Add build step** - Compile TypeScript to JavaScript before npm publish to reduce ~100-200ms startup overhead
- [ ] **Homebrew binary** - Distribute as standalone binary via Homebrew tap
  - Build: `bun build ./cli/bin.ts --compile --outfile dist/spindb`
  - Platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64
- [ ] **Self-host compiled engine binaries** - Reduce dependency on external binary hosts (significant infrastructure investment)

---

## Technical Debt

### Critical

#### Version Containerization Uses Wrong Binary

When multiple versions of an engine are installed, containers may use the wrong binary version (e.g., Redis 6 container running with Redis 7 binary).

- [ ] Audit version resolution - verify each engine maps container version to binary path correctly
- [ ] Add version validation on start - check binary version matches container config
- [ ] Consider version-specific binary caching for system-installed engines

#### EDB Binary URLs Will Break

**File:** `engines/postgresql/edb-binary-urls.ts`

Hardcoded file IDs will become stale when EDB updates their download system.

- [ ] Add dynamic version discovery - scrape EDB download page or use API
- [ ] Add remote config fallback - fetch version mappings from remote JSON
- [ ] Add download validation - verify HTTP 200 before proceeding
- [ ] Add version update monitoring - CI job to detect new PostgreSQL releases

#### Shell Injection in Windows Extraction

**File:** `core/binary-manager.ts` lines 243-250

- [ ] Replace shell commands with Node.js APIs - use `fs.rename()` and `fs.cp()` instead of `mv`/`xcopy`
- [ ] Validate paths are within expected directories before operations

### Medium

#### SQLite Container Creation Doesn't Validate Path

Creating SQLite container with non-existent path succeeds without rollback.

- [ ] Validate parent directory exists before container creation
- [ ] Add rollback on failure using `TransactionManager`
- [ ] Add `--create-path` flag to optionally create parent directories

#### No File Locking for Concurrent Access

Multiple CLI instances can corrupt `container.json` or SQLite registry.

- [ ] Add file locking with `proper-lockfile` or similar
- [ ] Consider SQLite for config storage (atomic operations, better concurrency)

#### Version Validation at Wrong Layer

**Files:** Engine `resolveFullVersion()` methods

Invalid versions like `"foo"` become `"foo.0.0"` and fail later with confusing 404 errors.

- [ ] Add CLI-layer version validation against `supportedVersions` array
- [ ] Standardize error messages across all engines
- [ ] Remove engine fallbacks once CLI validates

### Low

#### Progress Reporting

- [ ] Define progress stages enum - downloading, extracting, verifying, initializing, starting
- [ ] Add percentage progress for downloads and large file operations
- [ ] Stream backup/restore progress (currently no feedback during long operations)

#### MongoDB Restore Format Gaps

- [ ] Single .bson file restore - detection exists but restore logic doesn't derive collection name from filename

---

## Testing

### Pull Command Testing

The `spindb pull` command is implemented but needs comprehensive testing across all engines. See `plans/CLONE_FEATURE.md` for detailed status.

- [ ] **End-to-end pull tests** - Test full `spindb pull` workflow for each engine (replace mode, clone mode)
- [ ] **Post-script integration** - Verify `SPINDB_CONTEXT` JSON and legacy env vars work correctly
- [ ] **Error handling** - Test network timeouts, invalid credentials, disk space, transaction rollback
- [ ] **terminateConnections audit** - Verify engines that need connection termination have proper implementations

### Integration Tests Needed

- [ ] **dumpFromConnectionString tests** - Requires remote database instances. Consider Docker Compose for CI
- [ ] **Browser/Web UI tests** - Test `openInBrowser()` cross-platform for Qdrant, ClickHouse, Meilisearch, CouchDB

### Windows Testing

- [ ] Test EDB binary download and extraction
- [ ] Test MySQL TCP-only mode (no Unix sockets)
- [ ] Test SQLite binary detection with Chocolatey/winget/Scoop
- [ ] Test process termination with `taskkill`
- [ ] Create Windows CLI tool availability map
- [ ] Hide "open shell" option for engines without Windows CLI tools

### Migrate to Vitest

Node.js test runner lacks features needed for robust CI:

- [ ] Install vitest as dev dependency
- [ ] Update test scripts in package.json
- [ ] Add vitest.config.ts with platform-specific settings
- [ ] Enable `--bail` flag to stop on first failure

---

## Code TODOs

Items noted in source code that need attention:

- [ ] **ClickHouse native backup format** (`engines/clickhouse/backup.ts:227`) - Enable when restore support is implemented
- [ ] **Redis/Valkey SCAN iterator** (`engines/redis/index.ts:1140`, `engines/valkey/index.ts:1157`) - Replace KEYS with SCAN for large dataset support
- [ ] **Redis/Valkey pipelining** (`engines/valkey/index.ts:1175`) - Optimize with pipelining or Lua script to batch TYPE/TTL/value fetches
- [ ] **Redis Streams support** (`engines/redis/index.ts:1274`) - Add XRANGE/XADD commands for Streams data type
- [ ] **FerretDB backup method** (`tests/integration/ferretdb.test.ts:223`) - Replace pg_dump/pg_restore with mongodump/mongorestore
- [ ] **SQLite version source of truth** (`tests/unit/sqlite-binary-manager.test.ts:18`) - Derive test versions from single source

---

## Maintenance

- [ ] Add examples for each database in `CHEATSHEET.md`

---

## Design Decisions to Revisit

### Database Tracking (`databases` array)

Container configs store a `databases` array that can get stale when databases are created/dropped/renamed outside SpinDB.

**Current solution:** `spindb databases` CLI command for manual sync.

**Alternative approaches:**
- Query on demand when server is running
- Filesystem inference for MySQL/MariaDB/ClickHouse (directories)
- Keep only `database` (singular) for primary database
- Hybrid: auto-populate from server, cache on stop

**Decision needed:** Is the maintenance burden worth the benefit?
