# SpinDB Engines

## Supported

| Engine | Status | Binary Source | Binary Size | Notes |
|--------|--------|---------------|-------------|-------|
| 🐘 **PostgreSQL** | ✅ Complete | zonky.io (downloaded) | ~45 MB | Versions 14-17 |
| 🐬 **MySQL** | ✅ Complete | System (Homebrew/apt) | N/A (system) | Also supports MariaDB as drop-in replacement |
| 🪶 **SQLite** | ✅ Complete | System | N/A (system) | File-based, stores in project directories |

## Planned

| Engine | Status | Type | Binary Size | Notes |
|--------|--------|------|-------------|-------|
| 🔴 **Redis** | 🔜 Planned | In-memory | ~3-5 MB | Lightweight server binary |
| 🍃 **MongoDB** | 🔜 Planned | Document DB | ~200-300 MB | Large binary, may use system install like MySQL |

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

### 🍃 MongoDB

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
| Redis | `redis-cli` | `iredis` | Planned for v1.2 |
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
