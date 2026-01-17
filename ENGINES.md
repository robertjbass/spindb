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
| 🔷 **Valkey** | ✅ Complete | hostdb (all platforms) | ~15 MB | Versions 8, 9 (Redis fork) |
| 🏠 **ClickHouse** | ✅ Complete | hostdb (macOS/Linux) | ~300 MB | Version 25.12 (column-oriented OLAP) |

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

### 🔷 Valkey

- **Status:** ✅ Complete
- **Versions:** 8, 9
- **Data location:** `~/.spindb/containers/valkey/{name}/`
- **Process:** Server process (`valkey-server`)
- **Binary source:** hostdb downloads (all platforms)
- **Enhanced CLI:** `iredis` (Redis-protocol compatible)
- **Backup formats:**
  - `.valkey` - Text format (Redis commands, human-readable)
  - `.rdb` - Binary RDB snapshot (faster, requires restart to restore)
- **Multi-version support:** Yes (all platforms)
- **Bundled tools:** valkey-server, valkey-cli
- **Implementation notes:**
  - Redis fork created after Redis license change (BSD-3 license)
  - Fully API-compatible with Redis
  - Uses `redis://` connection scheme for client compatibility
  - Uses numbered databases (0-15) like Redis
  - Does NOT support remote dump (same as Redis)

### 🏠 ClickHouse

- **Status:** ✅ Complete
- **Versions:** 25.12
- **Data location:** `~/.spindb/containers/clickhouse/{name}/`
- **Process:** Server process (`clickhouse server`)
- **Binary source:** hostdb downloads (macOS/Linux only, no Windows)
- **Enhanced CLI:** `clickhouse client` (bundled)
- **Backup format:** `.sql` (DDL + INSERT statements)
- **Multi-version support:** Yes (macOS/Linux)
- **Bundled tools:** `clickhouse` unified binary (server, client subcommands)
- **Implementation notes:**
  - Column-oriented OLAP database for analytics
  - Uses SQL with ClickHouse-specific extensions
  - Uses XML configuration (config.xml, users.xml)
  - Default port 9000 (native TCP), 8123 (HTTP)
  - YY.MM versioning format (e.g., 25.12)
  - Apache-2.0 license

---

## Backup Format Summary

| Engine | Text Format | Binary/Compressed Format | Recommended |
|--------|-------------|-------------------------|-------------|
| PostgreSQL | `.sql` (pg_dump) | `.dump` (custom format) | `.dump` for full backup |
| MySQL | `.sql` (mysqldump) | `.sql.gz` (gzipped SQL) | `.sql.gz` for storage |
| SQLite | `.sql` (.dump) | `.db` (file copy) | File copy for speed |
| Redis | `.redis` (text commands) | `.rdb` (RDB snapshot) | RDB for backups |
| Valkey | `.valkey` (text commands) | `.rdb` (RDB snapshot) | RDB for backups |
| MongoDB | `.json` (mongoexport) | `.bson` (mongodump) | BSON for backups |
| ClickHouse | `.sql` (DDL + INSERT) | N/A | SQL for portability |

---

## Enhanced CLI Tools

| Engine | Standard CLI | Enhanced CLI | Notes |
|--------|-------------|--------------|-------|
| PostgreSQL | `psql` | `pgcli` | Auto-completion, syntax highlighting |
| MySQL | `mysql` | `mycli` | Auto-completion, syntax highlighting |
| SQLite | `sqlite3` | `litecli` | Available in v0.9 |
| Redis | `redis-cli` | `iredis` | Auto-completion, syntax highlighting |
| Valkey | `valkey-cli` | `iredis` | Protocol-compatible with iredis |
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
| 🔷 | Valkey |
| 🪶 | SQLite |

---

## Packaging

- [ ] Consider Bun support for binaries to create smaller, faster distribution packages for faster startup and smaller downloads
