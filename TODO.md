# SpinDB TODO

## Maintenance

- [ ] Review and update `EVALUATION.md` periodically (last updated: 2025-12-06, v0.9.0)

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

- [ ] Redis (in-memory key-value)
- [ ] MongoDB (document database)
- [ ] MariaDB as standalone engine

### v1.3 - Advanced Features

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
- [ ] **Overwrite existing databases on restore** - Add `--force` or `--drop-existing` flag to restore/create commands to drop and recreate tables that already exist (currently fails if tables exist)
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

### Distribution

- [ ] **Homebrew binary** - Distribute as standalone binary (no Node.js dependency) via Homebrew tap
  - Build: `bun build ./cli/bin.ts --compile --outfile dist/spindb`
  - Platforms: darwin-arm64, darwin-x64, linux-x64, win32-x64

---

## Known Issues & Technical Debt

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

```typescript
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

### Low: Progress Reporting

- [ ] **Define progress stages enum** - Standardize stages: downloading, extracting, verifying, initializing, starting
- [ ] **Add percentage progress** - For downloads and large file operations
- [ ] **Stream backup/restore progress** - Currently no feedback during long operations