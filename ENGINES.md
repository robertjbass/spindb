# SpinDB Engines

## Supported

| Engine | Status | Binary Source | Binary Size | Notes |
|--------|--------|---------------|-------------|-------|
| 🐘 **PostgreSQL** | ✅ Complete | hostdb (macOS/Linux), EDB (Windows) | ~45 MB | Versions 15-18 |
| 🐬 **MySQL** | ✅ Complete | hostdb (all platforms) | ~200 MB | Versions 8.0, 8.4, 9 |
| 🦭 **MariaDB** | ✅ Complete | hostdb (all platforms) | ~120 MB | Versions 10.11, 11.4, 11.8 |
| 🪶 **SQLite** | ✅ Complete | hostdb (all platforms) | ~5 MB | File-based, stores in project directories |
| 🍃 **MongoDB** | ✅ Complete | hostdb (all platforms) | ~200 MB | Versions 7.0, 8.0, 8.2 |
| 🔴 **Redis** | ✅ Complete | hostdb (all platforms) | ~15 MB | Versions 7, 8 |

## Planned

| Engine | Status | Type | Binary Size | Notes |
|--------|--------|------|-------------|-------|
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
- **Versions:** 7, 8
- **Data location:** `~/.spindb/containers/redis/{name}/`
- **Process:** Server process (like MySQL/PostgreSQL)
- **Binary source:** hostdb downloads (all platforms)
- **Enhanced CLI:** `iredis` (use `--iredis` flag)
- **Backup format:** RDB (Redis Database Backup) - Binary snapshot via BGSAVE
- **Databases:** Uses numbered databases (0-15) instead of named databases
- **Multi-version support:** Yes (all platforms)
- **Implementation notes:**
  - Uses PING/PONG for status checks
  - Does NOT support remote dump (dumpFromConnectionString throws an error with guidance)
  - Generates `redis.conf` in data directory for server configuration

### 🍃 MongoDB

- **Status:** ✅ Complete
- **Versions:** 7.0, 8.0, 8.2
- **Data location:** `~/.spindb/containers/mongodb/{name}/`
- **Process:** Server process (`mongod`)
- **Binary source:** hostdb downloads (all platforms)
- **Enhanced CLI:** `mongosh` (MongoDB Shell - bundled with hostdb)
- **Backup format:** mongodump (BSON) - preserves all BSON types
- **Multi-version support:** Yes (all platforms)
- **Bundled tools:** mongod, mongosh, mongodump, mongorestore
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

### MariaDB vs MySQL

MariaDB and MySQL are now **separate engines** with their own hostdb binaries:
- `spindb create mydb --engine mariadb` - Uses MariaDB binaries
- `spindb create mydb --engine mysql` - Uses MySQL binaries

Both engines support multi-version side-by-side installations. Client tools are bundled with the downloaded binaries.

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
