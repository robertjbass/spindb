# SpinDB Engines

## Supported

| Engine | Status | Binary Source | Binary Size | Notes |
|--------|--------|---------------|-------------|-------|
| 🐘 **PostgreSQL** | ✅ Complete | hostdb (macOS/Linux), EDB (Windows) | ~45 MB | Versions 15-18 |
| 🐬 **MySQL** | ✅ Complete | hostdb (all platforms) | ~200 MB | Versions 8.0, 8.4, 9 |
| 🦭 **MariaDB** | ✅ Complete | hostdb (all platforms) | ~120 MB | Versions 10.11, 11.4, 11.8 |
| 🪶 **SQLite** | ✅ Complete | hostdb (all platforms) | ~5 MB | File-based, stores in project directories |
| 🍃 **MongoDB** | ✅ Complete | hostdb (all platforms) | ~200 MB | Versions 7.0, 8.0, 8.2 |
| 🦔 **FerretDB** | ✅ Complete | hostdb (all platforms) | ~100 MB | MongoDB-compatible, PostgreSQL backend |
| 🔴 **Redis** | ✅ Complete | hostdb (all platforms) | ~15 MB | Versions 7, 8 |
| 🔷 **Valkey** | ✅ Complete | hostdb (all platforms) | ~15 MB | Versions 8, 9 (Redis fork) |
| 🏠 **ClickHouse** | ✅ Complete | hostdb (macOS/Linux) | ~300 MB | Version 25.12 (column-oriented OLAP) |
| 🧭 **Qdrant** | ✅ Complete | hostdb (all platforms) | ~50 MB | Version 1 (vector similarity search) |
| 🔍 **Meilisearch** | ✅ Complete | hostdb (all platforms) | ~50 MB | Version 1 (full-text search) |
| 🛋️ **CouchDB** | ✅ Complete | hostdb (all platforms) | ~100 MB | Version 3 (document database) |
| 🪳 **CockroachDB** | ✅ Complete | hostdb (all platforms) | ~150 MB | Version 25 (distributed SQL) |
| 🌀 **SurrealDB** | ✅ Complete | hostdb (all platforms) | ~50 MB | Version 2 (multi-model database) |
| ⏱️ **QuestDB** | ✅ Complete | hostdb (all platforms) | ~150 MB | Version 9 (time-series SQL database) |

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
  - Supports remote dump via `redis-cli` (text format with Redis commands)
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

### 🦔 FerretDB

- **Status:** ✅ Complete
- **Versions:** 2
- **Data location:** `~/.spindb/containers/ferretdb/{name}/`
- **Process:** Two processes (PostgreSQL backend + FerretDB proxy)
- **Binary source:** hostdb downloads (all platforms)
- **Enhanced CLI:** `mongosh` (MongoDB Shell - uses MongoDB protocol)
- **Backup format:** `.sql` or `.dump` (PostgreSQL formats, via pg_dump)
- **Multi-version support:** Yes (all platforms)
- **Bundled tools:** ferretdb, postgresql-documentdb (includes pg_ctl, initdb, pg_dump, etc.)
- **Implementation notes:**
  - Composite engine requiring two binaries from hostdb
  - FerretDB is a stateless Go proxy (MongoDB wire protocol → PostgreSQL SQL)
  - PostgreSQL backend uses DocumentDB extension for MongoDB compatibility
  - Two ports per container: external (27017 for MongoDB) + internal (54320+ for PostgreSQL)
  - Uses `mongodb://` connection scheme for clients
  - Backups use pg_dump on the embedded PostgreSQL database
  - Apache-2.0 license

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
  - Supports remote dump via `valkey-cli` (text format with Redis commands)

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

### 🧭 Qdrant

- **Status:** ✅ Complete
- **Versions:** 1
- **Data location:** `~/.spindb/containers/qdrant/{name}/`
- **Process:** Server process (`qdrant`)
- **Binary source:** hostdb downloads (all platforms)
- **CLI:** REST API (no traditional shell, use curl or API clients)
- **Backup format:** `.snapshot` (Qdrant native snapshot)
- **Multi-version support:** Yes (all platforms)
- **Bundled tools:** `qdrant` binary
- **Implementation notes:**
  - Vector similarity search engine
  - Uses REST API (port 6333) and gRPC (port 6334)
  - Collections instead of traditional databases
  - YAML configuration (config.yaml)
  - No shell connection - displays API endpoint info
  - Apache-2.0 license

### 🔍 Meilisearch

- **Status:** ✅ Complete
- **Versions:** 1
- **Data location:** `~/.spindb/containers/meilisearch/{name}/`
- **Process:** Server process (`meilisearch`)
- **Binary source:** hostdb downloads (all platforms)
- **CLI:** REST API (no traditional shell, use curl or API clients)
- **Backup format:** `.snapshot` (Meilisearch native snapshot)
- **Multi-version support:** Yes (all platforms)
- **Bundled tools:** `meilisearch` binary
- **Implementation notes:**
  - Full-text search engine
  - Uses REST API only (port 7700)
  - Indexes instead of traditional databases
  - CLI flags for configuration (no config file)
  - Dashboard at root URL (/)
  - Health check at /health
  - MIT license

### 🛋️ CouchDB

- **Status:** ✅ Complete
- **Versions:** 3
- **Data location:** `~/.spindb/containers/couchdb/{name}/`
- **Process:** Server process (`couchdb`)
- **Binary source:** hostdb downloads (all platforms)
- **CLI:** REST API (no traditional shell, use curl or API clients)
- **Backup format:** `.json` (all documents via `_all_docs?include_docs=true`)
- **Multi-version support:** Yes (all platforms)
- **Bundled tools:** `couchdb` binary
- **Default credentials:** `admin` / `admin` (CouchDB 3.x requires an admin account)
- **Implementation notes:**
  - Document-oriented NoSQL database
  - Uses REST API only (port 5984)
  - Databases instead of collections
  - Fauxton web dashboard at `/_utils`
  - Health check at `/` (returns welcome JSON with version)
  - Backup via `_all_docs` API, restore via `_bulk_docs` API
  - Change default credentials in non-local/production environments
  - Apache-2.0 license

### 🪳 CockroachDB

- **Status:** ✅ Complete
- **Versions:** 25
- **Data location:** `~/.spindb/containers/cockroachdb/{name}/`
- **Process:** Server process (`cockroach start-single-node --insecure`)
- **Binary source:** hostdb downloads (all platforms)
- **CLI:** `cockroach sql` (bundled)
- **Backup format:** `.sql` (SQL dump)
- **Multi-version support:** Yes (all platforms)
- **Bundled tools:** `cockroach` unified binary
- **Default user:** `root`
- **Default database:** `defaultdb`
- **Implementation notes:**
  - Distributed SQL database with PostgreSQL wire protocol compatibility
  - Runs in single-node mode for local development (--insecure flag)
  - Default SQL port 26257, HTTP Admin UI on port+1 (e.g., 26258)
  - PostgreSQL-compatible SQL syntax
  - Uses `cockroach dump` for backups, `cockroach sql` for restore
  - Connection string: `postgresql://root@localhost:26257/db?sslmode=disable`
  - Business Source License (BSL) - free for non-production use
  - Automatic data replication in distributed mode

### 🌀 SurrealDB

- **Status:** ✅ Complete
- **Versions:** 2
- **Data location:** `~/.spindb/containers/surrealdb/{name}/`
- **Process:** Server process (`surreal start`)
- **Binary source:** hostdb downloads (all platforms)
- **CLI:** `surreal sql` (bundled)
- **Backup format:** `.surql` (SurrealQL script)
- **Multi-version support:** Yes (all platforms)
- **Bundled tools:** `surreal` unified binary
- **Default user:** `root`
- **Default password:** `root`
- **Default namespace:** `test`
- **Default database:** `test`
- **Implementation notes:**
  - Multi-model database (document, graph, relational)
  - Uses SurrealQL (SQL-like query language with graph traversal)
  - Default port 8000 (HTTP/WebSocket)
  - Storage backend: SurrealKV (`surrealkv://` path-based storage)
  - Hierarchy: Root > Namespace > Database
  - Uses `surreal export` for backups, `surreal import` for restore
  - Connection scheme: `ws://` (WebSocket) or `http://`
  - Health check via `surreal isready --endpoint http://localhost:8000`
  - Business Source License (BSL)

### ⏱️ QuestDB

- **Status:** ✅ Complete
- **Versions:** 9
- **Data location:** `~/.spindb/containers/questdb/{name}/`
- **Process:** Server process (`questdb.sh` / `questdb.exe`)
- **Binary source:** hostdb downloads (all platforms)
- **CLI:** PostgreSQL wire protocol (uses `psql` from PostgreSQL engine)
- **Backup format:** `.sql` (SQL dump via psql)
- **Multi-version support:** Yes (all platforms)
- **Bundled tools:** `questdb.sh`/`questdb.exe` (JRE bundled)
- **Dependencies:** Requires PostgreSQL engine for `psql` (backup/restore/shell)
- **Default user:** `admin`
- **Default password:** `quest`
- **Default database:** `qdb`
- **Implementation notes:**
  - High-performance time-series database optimized for fast ingestion
  - Uses PostgreSQL wire protocol (port 8812)
  - Web console at HTTP port (port 9000 by default, or PG port + 188)
  - ILP (InfluxDB Line Protocol) port at PG port + 197
  - Java-based with bundled JRE (no Java installation required)
  - Startup via `questdb.sh start` (Unix) or `questdb.exe start` (Windows)
  - Single database model (`qdb` - no database creation needed)
  - Backup/restore uses PostgreSQL tools (`psql`) over wire protocol - **requires PostgreSQL engine**
  - Connection scheme: `postgresql://` (e.g., `postgresql://admin:quest@localhost:8812/qdb`)
  - Health check via HTTP endpoint at `/` (Web Console)
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
| FerretDB | `.sql` (pg_dump) | `.dump` (custom format) | SQL for portability |
| ClickHouse | `.sql` (DDL + INSERT) | N/A | SQL for portability |
| Qdrant | N/A | `.snapshot` (native) | Snapshot for backups |
| Meilisearch | N/A | `.snapshot` (native) | Snapshot for backups |
| CouchDB | `.json` (all docs) | N/A | JSON for backups |
| CockroachDB | `.sql` (cockroach dump) | N/A | SQL for backups |
| SurrealDB | `.surql` (surreal export) | N/A | SurrealQL for backups |
| QuestDB | `.sql` (psql) | N/A | SQL for backups |

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
| FerretDB | `mongosh` | - | Uses MongoDB shell (mongosh) |
| Universal | - | `usql` | Works with all SQL databases |
| Qdrant | REST API | - | Use curl or HTTP clients |
| Meilisearch | REST API | - | Use curl or HTTP clients |
| CouchDB | REST API | - | Use curl or HTTP clients |
| CockroachDB | `cockroach sql` | - | Built-in shell is full-featured |
| SurrealDB | `surreal sql` | - | Built-in shell is full-featured |
| QuestDB | `psql` | `pgcli` | PostgreSQL wire protocol |

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
| 🦔 | FerretDB |
| 🔴 | Redis |
| 🔷 | Valkey |
| 🪶 | SQLite |
| 🏠 | ClickHouse |
| 🧭 | Qdrant |
| 🔍 | Meilisearch |
| 🛋️ | CouchDB |
| 🪳 | CockroachDB |
| 🌀 | SurrealDB |
| ⏱️ | QuestDB |

---

## Packaging

See [TODO.md](TODO.md) for packaging and distribution roadmap items.
