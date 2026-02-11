# TODO

## Triage

Quick capture for ideas that need review and prioritization:

-

---

## High Priority

- [ ] **Pick logo and branding assets** - Review SVG concepts in `assets/` and `assets/concepts/`, finalize a logo for the tray icon, app badge, and wordmark
- [ ] **Docker export testing for all engines** - Test and verify `spindb export docker` works correctly for all 18 database engines, including file-based databases (SQLite, DuckDB). Ensure exported containers start, connect, and persist data properly.
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

### Supabase Enhancements

- [ ] **GoTrue macOS/Windows binaries** - Build and host via hostdb (currently Linux-only from GitHub)
- [ ] **Studio + pg_meta support** - Download and manage Supabase Studio (web dashboard) and pg_meta (metadata API)
- [ ] **Docker export with Supabase** - Include Supabase services in `spindb export docker` output
- [ ] **Supabase Storage** - File storage service integration
- [ ] **Supabase Realtime** - WebSocket-based realtime subscriptions (Elixir app, complex)

### Future Engines Under Consideration

The following engines may be added based on community interest:

| Engine | Type | Notes |
|--------|------|-------|
| **libSQL** | Embedded relational | SQLite fork with replication |
| **OpenSearch** | Search engine | Elasticsearch alternative |
| **Neo4j** | Graph database | Relationships and network data |

---

## Backlog

### CLI Improvements

- [ ] **Export query results** - `spindb run <container> query.sql --format csv/json --output file`
- [ ] **Run multiple SQL files** - `spindb run <container> schema.sql seed.sql`
- [ ] **Health checks** - Periodic connection tests for container status
- [ ] **Add `--json` to remaining commands** - clone, connect, logs, edit, attach, detach
- [ ] **Add `--json` to `spindb run`** - Capture stdout/stderr and return as JSON instead of inheriting stdio
  - Requires updating `runScript` signature in `BaseEngine` (line 233-236 of `engines/base-engine.ts`)
  - All 18 engine implementations need to be updated to support output capture mode
  - Output format: `{ success: boolean, stdout: string, stderr: string, exitCode: number, container: string, engine: string, database: string }`
  - Once implemented, update layerbase query logic to use this for programmatic SQL execution

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
- [x] **User management** - Custom users with specific privileges (`spindb users create/list`)
- [ ] **Delete users** - `spindb users delete <container> <username>` — DROP USER + remove credential file
- [ ] **Auth enforcement toggle** - `spindb users enforce-auth <container>` — modify server config to require auth
- [ ] **Docker export credential security** - Secure storage for `.env` credentials in exported Docker artifacts
  - Current: plaintext `.env` file with auto-generated password
  - Problem: Anyone with access to export directory can read credentials
  - Potential solutions:
    - Encrypt `.env` using local SSH key (user's `~/.ssh/id_rsa` or `id_ed25519`)
    - HashiCorp Vault integration for production deployments
    - SOPS (Secrets OPerationS) with age/GPG encryption
    - Docker secrets integration (Swarm mode or Compose secrets)
  - Requirements: Must be bulletproof for production, accessible by right person, protected from wrong person
  - Related file: `core/docker-exporter.ts` - `generateCredentials()` and `.env` generation

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

#### Generate Scripts CLI Length Limits

SQL seed files are passed via command-line argument (`-e` or `-c`), which could fail for large files due to OS limits (~128KB-2MB).

**Affected files:**
- `scripts/generate/db/postgresql.ts` - uses `-c seedContent`
- `scripts/generate/db/mysql.ts` - uses `-e seedContent`
- `scripts/generate/db/mariadb.ts` - uses `-e seedContent`
- `scripts/generate/db/clickhouse.ts` - uses `-q seedContent`
- `scripts/generate/db/cockroachdb.ts` - uses `-e seedContent`

**Fix:** Switch to stdin-based approach using `spawnSync` `input` option.

- [ ] Update all affected scripts to pipe seed content via stdin
- [ ] Not urgent - current seed files are small (~1KB)

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

- [x] ~~Add examples for each database in `CHEATSHEET.md`~~ - Covered by existing CHEATSHEET.md content for all 18 engines

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

---

## Contributing

### Development Setup

See [CLAUDE.md](CLAUDE.md) for architecture documentation and development guidelines.

### Pull Request Requirements

All PRs must:

1. **Target the `dev` branch** (not `main`)
2. **Pass the linter:** `pnpm lint`
3. **Be formatted with Prettier:** `pnpm format`
4. **Pass all unit/integration tests:** `pnpm test:unit`
5. **Pass all Docker integration tests:** `pnpm test:docker`

Please run all commands before opening a PR.

### Adding a New Engine

1. `git checkout dev && git pull && git checkout -b feature/<engine-name>`
2. Ensure the engine binaries are available for all supported platforms (macOS, Linux, Windows) using all architectures (x64 and ARM64) for darwin and linux and hosted on hostdb
3. Add unit and integration tests for the new engine
4. Add CI.yml tests for each architecture and platform following the established patterns
5. See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for the full 20+ file checklist

### Running Tests

```bash
pnpm test:unit         # Unit tests (1113+ tests)
pnpm test:engine       # All integration tests (17+ per engine)
pnpm test:engine pg    # PostgreSQL integration (aliases: postgres, postgresql)
pnpm test:engine mysql # MySQL integration
pnpm test:engine mongo # MongoDB integration (alias: mongodb)
pnpm test:engine --help # Show all available engines and aliases
pnpm test:docker       # Docker Linux E2E
```

### Why `--experimental-test-isolation=none`?

All test scripts use `--experimental-test-isolation=none` due to a Node 22 macOS worker thread bug where worker thread IPC fails with "Unable to deserialize cloned data." Running tests without worker isolation is reliable cross-platform. Don't remove this flag.

### Test Ports

Integration tests use reserved ports (not defaults) to avoid conflicts:

- PostgreSQL: 5454-5456
- MySQL: 3333-3335
- Redis: 6399-6401

### Silent Catch Blocks (By Design)

These catch blocks intentionally suppress errors because they handle expected failure scenarios:

| Location | Purpose |
|----------|---------|
| `mysql/binary-detection.ts:71,87` | Version/MariaDB detection probes |
| `mysql/binary-detection.ts:231,261,278,295,312` | Package manager detection |
| `mysql/index.ts:315` | MySQL readiness probe loop |
| `mysql/index.ts:356` | MySQL ping check (no PID file) |
| `cli/commands/list.ts:28` | Database size fetch (container not running) |
| `postgresql/binary-urls.ts:75` | Maven version fetch (fallback to hardcoded) |
| `cli/index.ts:78,88` | Update check notification (non-critical) |

### Desktop GUI (Separate Repository)

**Framework:** Tauri v2 (Rust + React)
**Architecture:** GUI shells out to `spindb` CLI commands

Features:
- System tray with running container status
- Start/stop/delete containers
- Create new containers
- View connection strings
- Auto-updates and launch on startup (opt-in)
