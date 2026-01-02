# SpinDB Engines

## Supported

| Engine | Status | Binary Source | Binary Size | Notes |
|--------|--------|---------------|-------------|-------|
| 🐘 **PostgreSQL** | ✅ Complete | zonky.io (downloaded) | ~45 MB | Versions 14-18 |
| 🐬 **MySQL** | ✅ Complete | System (Homebrew/apt) | N/A (system) | Also supports MariaDB as drop-in replacement |
| 🪶 **SQLite** | ✅ Complete | System | N/A (system) | File-based, stores in project directories |
| 🍃 **MongoDB** | ✅ Complete | System (Homebrew/apt) | N/A (system) | Versions 6.0, 7.0, 8.0 |
| 🔴 **Redis** | ✅ Complete | System (Homebrew/apt) | N/A (system) | Versions 6, 7, 8 |

## Planned

| Engine | Status | Type | Binary Size | Notes |
|--------|--------|------|-------------|-------|
| 🦭 **MariaDB** | 🔜 Planned | SQL DB | N/A (system) | Standalone engine with MariaDB-specific features |
| 🪳 **CockroachDB** | 🔜 Planned | Distributed SQL | ~100 MB | PostgreSQL-compatible distributed database |

---

## Engine Details

### 🪶 SQLite

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

### 🔴 Redis

- **Status:** ✅ Complete
- **Versions:** 6, 7, 8
- **Data location:** `~/.spindb/containers/redis/{name}/`
- **Process:** Server process (like MySQL/PostgreSQL)
- **Binary source:** System install via Homebrew/apt/choco
- **Enhanced CLI:** `iredis` (use `--iredis` flag)
- **Backup format:** RDB (Redis Database Backup) - Binary snapshot via BGSAVE
- **Databases:** Uses numbered databases (0-15) instead of named databases
- **Implementation notes:**
  - Uses PING/PONG for status checks
  - Does NOT support remote dump (dumpFromConnectionString throws an error with guidance)
  - Generates `redis.conf` in data directory for server configuration

### 🍃 MongoDB

- **Status:** ✅ Complete
- **Versions:** 6.0, 7.0, 8.0
- **Data location:** `~/.spindb/containers/mongodb/{name}/`
- **Process:** Server process (`mongod`)
- **Binary source:** System install via Homebrew/apt/choco
- **Enhanced CLI:** `mongosh` (MongoDB Shell - built-in)
- **Backup format:** mongodump (BSON) - preserves all BSON types
- **Implementation notes:**
  - Uses JavaScript for scripts instead of SQL
  - mongodump creates gzipped archive by default
  - Full cross-platform support (macOS, Linux, Windows)

---

## Backup Format Summary

| Engine | Text Format | Binary/Compressed Format | Recommended |
|--------|-------------|-------------------------|-------------|
| PostgreSQL | `.sql` (pg_dump) | `.dump` (custom format) | `.dump` for full backup |
| MySQL | `.sql` (mysqldump) | `.sql.gz` (gzipped SQL) | `.sql.gz` for storage |
| SQLite | `.sql` (.dump) | `.db` (file copy) | File copy for speed |
| Redis | N/A | `.rdb` (RDB snapshot) | RDB for backups |
| MongoDB | `.json` (mongoexport) | `.bson` (mongodump) | BSON for backups |

---

## Enhanced CLI Tools

| Engine | Standard CLI | Enhanced CLI | Notes |
|--------|-------------|--------------|-------|
| PostgreSQL | `psql` | `pgcli` | Auto-completion, syntax highlighting |
| MySQL | `mysql` | `mycli` | Auto-completion, syntax highlighting |
| SQLite | `sqlite3` | `litecli` | Available in v0.9 |
| Redis | `redis-cli` | `iredis` | Auto-completion, syntax highlighting |
| MongoDB | `mongosh` | - | Built-in shell is already enhanced |
| Universal | - | `usql` | Works with all SQL databases |

---

## Considerations

### MariaDB as Separate Engine

Currently MariaDB is treated as a drop-in replacement for MySQL on Linux systems. The MySQL engine auto-detects MariaDB and handles compatibility. However, MariaDB has diverged from MySQL in recent versions with unique features (e.g., sequences, system-versioned tables). Consider creating a dedicated MariaDB engine in the future if:

- Users need MariaDB-specific features not available in MySQL
- Compatibility issues arise between MySQL and MariaDB dumps
- MariaDB binary management differs significantly from MySQL

For now, the MySQL engine's MariaDB support is sufficient for most use cases.

### Engine Emojis

| Emoji | Engine |
|-------|--------|
| 🦭 | MariaDB |
| 🐬 | MySQL |
| 🐘 | PostgreSQL |
| 🍃 | MongoDB |
| 🔴 | Redis |
| 🪶 | SQLite |

---

## Packaging

- [ ] Consider Bun support for binaries to create smaller, faster distribution packages for faster startup and smaller downloads
