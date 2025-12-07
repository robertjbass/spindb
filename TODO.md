# SpinDB TODO

## Roadmap

### Maintenance
- [ ] Review and update `EVALUATION.md` periodically (last updated: 2025-12-06, v0.9.0)

### v1.0 - Core Features (Complete)
- [x] PostgreSQL container management (create, start, stop, delete)
- [x] MySQL/MariaDB engine support
- [x] Backup and restore with version compatibility checking
- [x] Clone containers from connection strings
- [x] Multiple databases per container
- [x] Interactive menu with arrow-key navigation
- [x] Enhanced shells (pgcli, mycli, usql)
- [x] Run SQL files and inline statements
- [x] Logs command with follow and editor options
- [x] Self-update with automatic notifications
- [x] JSON output for scripting (`--json` flags)

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

See [Engines](#engines) section below for full engine status and details.

### v1.3 - Advanced Features
- [ ] **Database rename** - Rename databases within containers
- [ ] **Container templates** - Save/load container configurations
- [ ] **Scheduled backups** - Cron-like backup scheduling
- [ ] **Import from Docker** - Migrate data from Docker containers

---

## Feature Backlog

### CLI Improvements
- [ ] **Export query results** - `spindb run <container> query.sql --format csv/json --output file`
- [ ] **Run multiple SQL files** - `spindb run <container> schema.sql seed.sql`
- [ ] **Health checks** - Periodic connection tests for container status
- [ ] **Overwrite existing databases on restore** - Add `--force` or `--drop-existing` flag to restore/create commands to drop and recreate tables that already exist (currently fails if tables exist)
- [ ] **Update doctor tool** - Add checks for database file permissions, container health, and engines

### Chained Command Ideas

Combine common multi-step workflows into single commands. These should remain intuitive and not bloat the CLI.

| Proposed Command | Steps Combined | Example |
|------------------|----------------|---------|
| `spindb db create <container> <dbname> [--seed file.sql] [--connect]` | Create database + run seed file + open shell | `spindb db create myapp users --seed schema.sql --connect` |
| `spindb clone <container> <new-name> --start` | Clone container + start it | `spindb clone prod-backup local-test --start` |
| `spindb restore <container> <backup> --start` | Restore backup + start container | `spindb restore mydb backup.dump --start` |
| `spindb create <name> --start [--connect]` | Create + start + optionally connect | `spindb create mydb --start --connect` |
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
- [ ] **Windows support** - Requires alternative binary source (zonky.io is macOS/Linux only)
- [ ] **Offline mode** - Bundle binaries for air-gapped environments

---

## Distribution

### Homebrew Binary

Distribute SpinDB as a standalone binary (no Node.js dependency) via Homebrew tap.

**Build:** `bun build ./cli/bin.ts --compile --outfile dist/spindb`

**Install:**
```bash
brew tap robertjbass/tap
brew install spindb
```

**Platforms:**
- darwin-arm64 (Apple Silicon)
- darwin-x64 (Intel Mac)
- linux-x64

See `.github/workflows/release.yml` for CI build configuration.

---

## Desktop GUI (Separate Repository)

**Framework:** Tauri v2 (Rust + React)
**Architecture:** GUI shells out to `spindb` CLI commands

### Features
- System tray with running container status
- Start/stop/delete containers
- Create new containers
- View connection strings
- Auto-updates and launch on startup (opt-in)

---

## Known Limitations

- **No Windows support** - zonky.io doesn't provide Windows PostgreSQL binaries
- **Client tools required** - psql/pg_dump and mysql/mysqldump must be installed separately
- **Local only (currently)** - Binds to 127.0.0.1; remote connections planned for v1.1
- **MySQL uses system binaries** - Unlike PostgreSQL, MySQL requires system installation

---

## Silent Catch Blocks (By Design)

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

---

## Testing

### Run Tests
```bash
pnpm test           # All tests (unit + integration)
pnpm test:unit      # Unit tests only
pnpm test:pg        # PostgreSQL integration
pnpm test:mysql     # MySQL integration
```

### Test Ports
- PostgreSQL: 5454-5456
- MySQL: 3333-3335

### Test Coverage
- **Unit tests:** 358 tests covering validation, error handling, version compatibility, SQLite registry, relocation
- **Integration tests:** 38 tests (14 PostgreSQL + 14 MySQL + 10 SQLite) covering full container lifecycle

---

## Engines

### Supported

| Engine | Status | Binary Source | Binary Size | Notes |
|--------|--------|---------------|-------------|-------|
| 🐘 **PostgreSQL** | ✅ Complete | zonky.io (downloaded) | ~45 MB | Versions 14-17 |
| 🐬 **MySQL** | ✅ Complete | System (Homebrew/apt) | N/A (system) | Also supports MariaDB as drop-in replacement |
| 🪶 **SQLite** | ✅ Complete | System | N/A (system) | File-based, stores in project directories |

### Planned

| Engine | Status | Type | Binary Size | Notes |
|--------|--------|------|-------------|-------|
| 🔴 **Redis** | 🔜 Planned | In-memory | ~3-5 MB | Lightweight server binary |
| 🍃 **MongoDB** | 🔜 Planned | Document DB | ~200-300 MB | Large binary, may use system install like MySQL |

### Engine Details

#### 🪶 SQLite
- **Data location:** Project directory (CWD by default), not `~/.spindb/`
- **Create:** `spindb create mydb --engine sqlite --path ./data/mydb.sqlite`
- **Process:** No start/stop needed (embedded database, no server process)
- **Enhanced CLI:** `litecli`
- **Backup formats:**
  - `.dump` → SQL text file (portable, can import to other DBs)
  - File copy / `.backup` → Binary database file (faster, SQLite-only)
  - Compressed: `sqlite3 db.sqlite .dump | gzip > backup.sql.gz`
- **Considerations:**
  - No port management needed
  - Connection string is just the file path
  - May need to handle file locking for concurrent access

#### 🔴 Redis
- **Data location:** `~/.spindb/containers/redis/{name}/`
- **Process:** Server process (like MySQL/PostgreSQL)
- **Binary source:** Could download from redis.io or use system install
- **Enhanced CLI:** `iredis`
- **Backup formats:**
  - **RDB** (Redis Database Backup) - Compact binary snapshot, fast recovery, recommended for backups
  - **AOF** (Append Only File) - Change log format, larger but more durable
  - RDB is typically smaller and faster to restore than AOF
- **Considerations:**
  - RDB files use LZF compression internally
  - May want to support both RDB snapshots and AOF for different use cases
  - `BGSAVE` for background saves, `SAVE` for synchronous

#### 🍃 MongoDB
- **Data location:** `~/.spindb/containers/mongodb/{name}/`
- **Process:** Server process (`mongod`)
- **Binary source:** System install recommended due to large binary size (~200-300 MB)
- **Enhanced CLI:** `mongosh` (MongoDB Shell)
- **Backup formats:**
  - **mongodump** (BSON) - Binary format, preserves all BSON types, recommended for backups
  - **mongoexport** (JSON/CSV) - Human-readable, but loses some BSON type fidelity
  - **WARNING:** Avoid mongoexport for production backups (doesn't preserve all BSON types)
- **Considerations:**
  - Large binary size may favor system install approach (like MySQL)
  - BSON format is more compact and faster than JSON
  - mongodump creates directory with .bson files per collection

### Backup Format Summary

| Engine | Text Format | Binary/Compressed Format | Recommended |
|--------|-------------|-------------------------|-------------|
| PostgreSQL | `.sql` (pg_dump) | `.dump` (custom format) | `.dump` for full backup |
| MySQL | `.sql` (mysqldump) | `.sql.gz` (gzipped SQL) | `.sql.gz` for storage |
| SQLite | `.sql` (.dump) | `.db` (file copy) | File copy for speed |
| Redis | N/A | `.rdb` (RDB snapshot) | RDB for backups |
| MongoDB | `.json` (mongoexport) | `.bson` (mongodump) | BSON for backups |

### Considerations

**MariaDB as separate engine:**
Currently MariaDB is treated as a drop-in replacement for MySQL on Linux systems. The MySQL engine auto-detects MariaDB and handles compatibility. However, MariaDB has diverged from MySQL in recent versions with unique features (e.g., sequences, system-versioned tables). Consider creating a dedicated MariaDB engine in the future if:
- Users need MariaDB-specific features not available in MySQL
- Compatibility issues arise between MySQL and MariaDB dumps
- MariaDB binary management differs significantly from MySQL

For now, the MySQL engine's MariaDB support is sufficient for most use cases.

Engine Emojis:
🦭 MariaDB
🐬 MySQL
🐘 Postgres
🍃 MongoDB
🔴 Redis
🪶 SQLite

### Enhanced CLI Tools

| Engine | Standard CLI | Enhanced CLI | Notes |
|--------|-------------|--------------|-------|
| PostgreSQL | `psql` | `pgcli` | Auto-completion, syntax highlighting |
| MySQL | `mysql` | `mycli` | Auto-completion, syntax highlighting |
| SQLite | `sqlite3` | `litecli` | Available in v0.9 |
| Redis | `redis-cli` | `iredis` | Planned for v1.2 |
| MongoDB | `mongosh` | - | Built-in shell is already enhanced |
| Universal | - | `usql` | Works with all SQL databases |

### Packaging
- [ ] Consider Bun support for binaries to create smaller, faster distribution packages for faster startup and smaller downloads