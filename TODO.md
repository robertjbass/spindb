# SpinDB TODO

## Maintenance

- [ ] Review and update `EVALUATION.md` periodically (last updated: 2025-12-06, v0.9.0)

- [ ] Add examples for each database in `CHEATSHEET.md`

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

### v1.2 - Additional Engines

See [ENGINES.md](ENGINES.md) for full engine status and details.

- [x] Redis (in-memory key-value)
- [x] Valkey (Redis fork with BSD-3 license)
- [x] MongoDB (document database)
- [x] MariaDB as standalone engine (using hostdb binaries)
- [x] ClickHouse (column-oriented OLAP database)

### Engine Binary Migration (hostdb)

Migrate system-installed engines to downloadable hostdb binaries for multi-version support. Reference: MariaDB engine migration.

**Detailed Plan:** `~/.claude/plans/declarative-toasting-quail.md` (MongoDB & Redis migration plan)

- [x] **MySQL migration to hostdb** - Completed in v0.15.0
- [x] **MongoDB migration to hostdb** - Completed
  - [x] Add `engines/mongodb/version-maps.ts` synced with hostdb releases.json
  - [x] Add `engines/mongodb/binary-urls.ts` for hostdb download URLs
  - [x] Add `engines/mongodb/binary-manager.ts` for download/extraction
  - [x] Update MongoDB engine to use `getMongoshPath()` from downloaded binaries
  - [x] Register MongoDB binary names (`mongod`, `mongosh`, `mongodump`, `mongorestore`)
  - [x] Update backup.ts and restore.ts to use configManager
  - [x] Update shell handlers for MongoDB with hostdb binaries
  - [x] Add MongoDB to "Manage Engines" menu with delete option
  - [x] Update CI to download MongoDB binaries via SpinDB (macOS/Linux)

- [x] **Redis migration to hostdb** - Completed
  - [x] Add `engines/redis/version-maps.ts` synced with hostdb releases.json
  - [x] Add `engines/redis/binary-urls.ts` for hostdb download URLs
  - [x] Add `engines/redis/binary-manager.ts` for download/extraction
  - [x] Update Redis engine to use downloaded binaries on macOS/Linux
  - [x] Register Redis binary names (`redis-server`, `redis-cli`)
  - [x] Update backup.ts and restore.ts to use configManager
  - [x] Add Redis to "Manage Engines" menu with delete option
  - [x] Update CI to download Redis binaries via SpinDB (macOS/Linux)

**Reference implementation:** See `engines/mariadb/` for hostdb migration pattern.

### v1.3 - Advanced Features

- [ ] **Database rename** - Rename databases within containers
- [ ] **Container templates** - Save/load container configurations
- [ ] **Scheduled backups** - Cron-like backup scheduling
- [ ] **Import from Docker** - Migrate data from Docker containers

---

## Backlog

### Redis Enhancements

- [ ] **Redis remote dump/restore** - Support creating containers from remote Redis connection strings
  - Unlike PostgreSQL/MySQL/MongoDB, Redis doesn't have a native remote dump tool
  - Options to explore:
    - Use `DUMP`/`RESTORE` commands to serialize individual keys
    - Implement incremental key migration using `SCAN` + `DUMP`
    - Add `--migrate` flag that copies keys from remote to local
  - Current behavior: throws helpful error with manual migration instructions

- [x] **Redis CI/CD tests** - Redis integration tests added to CI matrix
  - All platforms: macOS (Intel/ARM), Linux (Ubuntu 22.04/24.04), Windows
  - Uses hostdb binaries for all platforms

### CLI Improvements

- [ ] **Export query results** - `spindb run <container> query.sql --format csv/json --output file`
- [ ] **Run multiple SQL files** - `spindb run <container> schema.sql seed.sql`
- [ ] **Health checks** - Periodic connection tests for container status
- [x] **Overwrite existing databases on restore** - Add `--force` or `--drop-existing` flag to restore/create commands to drop and recreate tables that already exist (currently fails if tables exist)
- [x] **Update doctor tool** - Add checks for database file permissions, container health, and engines

### Chained Command Ideas

Combine common multi-step workflows into single commands. These should remain intuitive and not bloat the CLI.

| Proposed Command | Steps Combined | Example |
|------------------|----------------|---------|
| `spindb db create <container> <dbname> [--seed file.sql] [--connect]` | Create database + run seed file + open shell | `spindb db create myapp users --seed schema.sql --connect` |
| `spindb clone <container> <new-name> --start` | Clone container + start it | `spindb clone prod-backup local-test --start` |
| `spindb restore <container> <backup> --start` | Restore backup + start container | `spindb restore mydb backup.dump --start` |
| `spindb backup <container> --stop` | Stop container + create backup | `spindb backup mydb --stop` (for consistent backups) |

**Guidelines:**
- Flags should be additive (each flag adds one step)
- Order of operations should be intuitive (create → seed → start → connect)
- Don't combine conflicting operations
- Keep documentation clear about what each flag does

### Security (Pro)

- [ ] **Password authentication** - Set passwords on container creation
- [ ] **Encrypted backups** - GPG/OpenSSL encryption for dumps
- [ ] **User management** - Custom users with specific privileges

### Team Features (Pro)

- [ ] **Shared configs** - Export/import container configs
- [ ] **Config profiles** - Dev/staging/test environment profiles
- [ ] **Cloud backup sync** - S3/GCS/Azure backup storage

### Platform Support

- [x] **Windows support** - Added in v0.9.4 using EDB binaries for PostgreSQL
- [ ] **Offline mode** - Bundle binaries for air-gapped environments
- [ ] **Expand GitHub Actions coverage** - Add CI tests that validate major features across macOS, Linux, and Windows (not just unit tests), so cross-platform regressions are caught early
- [ ] **Parallel CI matrix for all 5 platforms** - Run engine tests in parallel across all supported OS/arch combinations for faster CI and better platform bug detection
  - Runners: `macos-14` (ARM64), `macos-13` (Intel), `ubuntu-latest` (x64), `windows-latest` (x64)
  - linux-arm64: Requires `ubuntu-24.04-arm` or self-hosted runner
  - Use GitHub Actions matrix strategy to parallelize
  - Trade-off: macOS runners cost 10x Linux minutes

### Distribution

- [ ] **Add build step** - Currently using `tsx` to run TypeScript directly in production. Works well but adds ~100-200ms startup overhead per invocation. Consider adding a build step that compiles to JavaScript before publishing to npm. This would:
  - Reduce startup latency
  - Remove tsx as a runtime dependency
  - Shrink installed package size
  - Enable tree-shaking and other optimizations
- [ ] **Homebrew binary** - Distribute as standalone binary (no Node.js dependency) via Homebrew tap
  - Build: `bun build ./cli/bin.ts --compile --outfile dist/spindb`
  - Platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64
- [x] **Fix package-manager mismatch for tests** - ~~`npm test` currently shells out to `pnpm` and fails if `pnpm` isn't installed~~ Fixed: now using `npm-run-all` so scripts work with any package manager
- [ ] **Self-host compiled engine binaries** - Compile and host database engine binaries instead of relying on external sources (zonky.io for PostgreSQL). This would:
  - Reduce dependency on third-party binary hosts
  - Provide control over version availability and timing
  - Enable adding platforms/versions not available upstream
  - **Trade-offs:** Significant infrastructure (cross-platform builds, hosting costs, security responsibility). Only pursue if external sources become unreliable or project gains significant adoption. Consider intermediate step of mirroring/caching known-good binaries first.

---

## Known Issues & Technical Debt

### Critical: Version Containerization Uses Wrong Binary

**Bug:** When multiple versions of an engine are installed on the system, containers may use the wrong binary version. A container created for Redis 6 was found to be running with the Redis 7 binary.

**Impact:** Containers don't properly isolate to their specified version. While this may not cause immediate failures (Redis 6 container ran fine on Redis 7), it defeats the purpose of version-specific containers and could cause subtle compatibility issues.

**Root cause:** System binary detection finds whichever version is in PATH rather than respecting the container's configured version.

- [ ] **Audit version resolution** - Verify each engine correctly maps container version to binary path
- [ ] **Add version validation on start** - Check that the binary version matches the container's configured version
- [ ] **Consider version-specific binary caching** - For system-installed engines, cache the path to each detected version

### Windows Support (Added v0.9.4) - Needs Testing

- [ ] **Test Windows binary download and extraction** - Verify EDB binaries download and extract correctly
- [ ] **Test MySQL on Windows** - Verify TCP-only mode works (no Unix sockets)
- [ ] **Test SQLite on Windows** - Verify binary detection with Chocolatey/winget/Scoop
- [ ] **Test process termination** - Verify `taskkill` works for graceful and forced shutdown

### Critical: EDB Binary URLs Will Break

**File:** `engines/postgresql/edb-binary-urls.ts`

The hardcoded file IDs (`'17.7.0': '1259911'`) will become stale when EDB updates their download system or releases new PostgreSQL versions.

- [ ] **Add dynamic version discovery** - Scrape EDB download page or use their API
- [ ] **Add remote config fallback** - Fetch version mappings from a remote JSON file
- [ ] **Add download validation** - Verify HTTP 200 before proceeding, fail fast on 404
- [ ] **Add version update monitoring** - CI job to detect new PostgreSQL releases

### Critical: Shell Injection in Windows Extraction

**File:** `core/binary-manager.ts` lines 243-250

```ts
// UNSAFE: paths with special characters could execute arbitrary commands
await execAsync(`mv "${sourcePath}" "${destPath}"`)
await execAsync(`xcopy /E /I /H /Y "${sourcePath}" "${destPath}"`)
```

- [ ] **Replace shell commands with Node.js APIs** - Use `fs.rename()` and `fs.cp()` instead
- [ ] **Validate paths** - Ensure paths are within expected directories before operations

### Medium: SQLite Container Creation Doesn't Validate Path

**File:** `engines/sqlite/index.ts`

Creating an SQLite container with a non-existent path succeeds without error, and the container is not rolled back on failure.

```bash
spindb create mydb --engine sqlite --path /nonexistent/path/db.sqlite
# Container is created but unusable, no rollback occurs
```

- [ ] **Validate path exists** - Check that parent directory exists before container creation
- [ ] **Add rollback on failure** - Use `TransactionManager` to clean up container if path validation fails
- [ ] **Add `--create-path` flag** - Optionally create parent directories if they don't exist

### Medium: No File Locking for Concurrent Access

Multiple CLI instances can corrupt `container.json` or SQLite registry.

- [ ] **Add file locking** - Use `proper-lockfile` or similar for config file access
- [ ] **Consider SQLite for config** - Atomic operations, better concurrency

### Medium: Frontend Integration Gaps

For potential Electron/web frontend integration:

- [ ] **Wire up progress callbacks** - `ProgressCallback` exists but CLI uses spinners instead
- [ ] **Standardize JSON output** - Only 10/24 commands have `--json`, inconsistent error formats
- [ ] **Add `--json` to all commands** - backup, clone, connect, create, delete, logs, restore, run, start, stop
- [ ] **Structured error format** - Standard `{ code, message, suggestion, context }` for all JSON errors
- [ ] **Add timestamps to JSON output** - For audit trails and debugging
- [ ] **Add event streaming mode** - WebSocket or SSE for real-time progress updates

### Medium: Version Validation at Wrong Layer

**Files:** `engines/redis/index.ts`, `engines/valkey/index.ts`, and other engines

The `resolveFullVersion()` method in each engine silently falls back to `${version}.0.0` for invalid version inputs instead of validating. This means invalid versions like `"foo"` become `"foo.0.0"` and proceed to fail later in the download step with a confusing 404 error.

**Problem:** Each engine independently handles (or doesn't handle) invalid versions, leading to inconsistent error messages.

**Solution:** Add version validation at the CLI layer (`cli/commands/create.ts`, etc.) before reaching engine code. Validate against `supportedVersions` array and fail fast with a clear message like "Invalid version 'foo'. Supported versions: 7, 8, 9".

- [ ] **Add CLI-layer version validation** - Validate version against engine's `supportedVersions` before calling engine methods
- [ ] **Standardize error messages** - Consistent "Invalid version" message across all engines
- [ ] **Consider removing engine fallbacks** - Once CLI validates, engines can throw on invalid versions instead of guessing

### Low: Progress Reporting

- [ ] **Define progress stages enum** - Standardize stages: downloading, extracting, verifying, initializing, starting
- [ ] **Add percentage progress** - For downloads and large file operations
- [ ] **Stream backup/restore progress** - Currently no feedback during long operations