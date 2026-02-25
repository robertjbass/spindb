# Engine-Specific Implementation Notes

Detailed implementation notes for each engine. These are reference material for when you're working on a specific engine — you don't need to read all of them at once.

## Meilisearch

- **Snapshots directory placement**: MUST be a sibling of the data directory, not inside it. Meilisearch fails with "failed to infer the version of the database" if `--snapshot-dir` points inside `--db-path`. Directory structure: `container/data/` and `container/snapshots/` (not `container/data/snapshots/`).
- **Index naming**: Uses "indexes" instead of databases. Index UIDs only allow alphanumeric characters and underscores. Container names with dashes are auto-converted (e.g., `my-app` → index `my_app`).
- **Health endpoint**: `/health` (returns `{"status":"available"}`)
- **No secondary port**: Unlike Qdrant (HTTP + gRPC), Meilisearch only uses HTTP port
- **Dashboard URL**: Root path `/` (not `/dashboard` like Qdrant)

## Qdrant

- **Dual ports**: HTTP (default 6333) + gRPC (default 6334, typically HTTP+1)
- **Health endpoint**: `/healthz`
- **Dashboard URL**: `/dashboard`
- **Config file**: Uses YAML config (`config.yaml`) for settings

## MongoDB & FerretDB

- **Implicit database creation**: MongoDB/FerretDB don't create databases until you first write data. To force immediate creation (so the database appears in tools like TablePlus), `createDatabase()` creates a temp collection `_spindb_init` and immediately drops it. This leaves the database visible with no marker clutter.
- **Connection via mongosh**: Both engines use MongoDB's `mongosh` shell for connections and script execution
- **Database validation**: Database names must be alphanumeric + underscores (same as SQL engines)

## CouchDB

- **REST API only**: Uses HTTP REST API for all operations (no CLI shell)
- **Health endpoint**: `/` returns welcome JSON with version info
- **Dashboard URL**: Fauxton at `/_utils`
- **Default port**: 5984
- **Backup/restore**: Uses `_all_docs?include_docs=true` for backup, `_bulk_docs` for restore
- **Connection scheme**: `http://` (e.g., `http://127.0.0.1:5984/mydb`)
- **Database creation**: Explicit via PUT request to database endpoint
- **No --version flag**: CouchDB is an Erlang application that tries to start when run with any arguments. Binary verification only checks file existence, not version output.
- **Windows binary**: CouchDB on Windows uses `couchdb.cmd` (batch file), not `couchdb.exe`. The binary manager and engine use `getCouchDBExtension()` helper to return `.cmd` on Windows.
- **Fauxton authentication**: CouchDB 3.x requires an admin account. Even with `require_valid_user = false` in the config, Fauxton's session-based auth still shows a login screen. Default credentials are `admin`/`admin`. The shell handler shows these credentials before opening the browser.

## SurrealDB

- **Multi-model database**: Supports document, graph, and relational paradigms
- **Query language**: SurrealQL (SQL-like with graph traversal capabilities)
- **Default port**: 8000 (HTTP/WebSocket)
- **Storage backend**: SurrealKV (`surrealkv://path`)
- **Hierarchy**: Root > Namespace > Database
- **Default credentials**: `root`/`root`
- **Namespace derivation**: Namespace is derived from container name using `.replace(/-/g, '_')`. For container `my-app`, namespace is `my_app`.
- **Default database**: `test` (or container's configured database)
- **Connection scheme**: `ws://` for WebSocket, `http://` for HTTP
- **Health check**: `surreal isready --endpoint http://127.0.0.1:${port}`
- **Backup/restore**: Uses `surreal export` (SurrealQL script) and `surreal import`
- **CLI shell**: `surreal sql --endpoint ws://127.0.0.1:${port}` for interactive queries
- **Scripting flag**: Use `--hide-welcome` with `surreal sql` to suppress the welcome banner for scriptable/parseable output. The engine uses this automatically for non-interactive commands.
- **History file**: SurrealDB writes `history.txt` to cwd. The engine sets `cwd` to the container directory so history is stored in `~/.spindb/containers/surrealdb/<name>/history.txt` rather than polluting the user's working directory.
- **Background process stdio**: MUST use `stdio: ['ignore', 'ignore', 'ignore']` when spawning the detached server process. Using `'pipe'` for stdout/stderr keeps file descriptors open that prevent Node.js from exiting even after `proc.unref()`. This caused `spindb start` to hang indefinitely in Docker/CI environments. See CockroachDB for the same pattern.

## QuestDB

- **Time-series database**: High-performance database optimized for fast ingestion and time-series analytics
- **Query language**: SQL via PostgreSQL wire protocol
- **Default port**: 8812 (PostgreSQL wire protocol)
- **Secondary ports**: HTTP Web Console at PG port + 188 (default 9000), HTTP Min at PG port + 191, ILP at PG port + 197
- **Java-based**: Bundled JRE (no Java installation required)
- **Startup**: Uses `questdb.sh start` (Unix) or `questdb.exe start` (Windows)
- **Default credentials**: `admin`/`quest`
- **Single database**: Uses `qdb` database (no database creation needed)
- **Backup/restore**: Requires PostgreSQL's psql binary (from SpinDB's PostgreSQL engine) to connect via wire protocol. **Cross-engine dependency**: Deleting PostgreSQL will break QuestDB backup/restore
- **Connection scheme**: `postgresql://` (e.g., `postgresql://admin:quest@localhost:8812/qdb`)
- **Health check**: HTTP GET to Web Console at `/`
- **Log file**: `questdb.log` in container directory
- **Config file**: `server.conf` in `conf/` subdirectory
- **PID handling**: QuestDB's shell script forks and exits immediately - the spawned shell's PID is useless. QuestDB also doesn't create its own PID file. Solution: find the actual Java process by port after startup using `platformService.findProcessByPort()` and write that PID to our PID file. See "Shell Script / JRE Engines" gotcha in Development Gotchas.
- **Multi-port conflicts**: When running multiple QuestDB containers, must configure ALL ports uniquely via environment variables: `QDB_HTTP_BIND_TO`, `QDB_HTTP_MIN_NET_BIND_TO`, `QDB_PG_NET_BIND_TO`, `QDB_LINE_TCP_NET_BIND_TO`. The HTTP Min Server (health/metrics) defaults to port 9003 for all instances and will cause conflicts if not configured.
- **Backup timestamp column**: QuestDB tables have a designated timestamp column that can have any name. Don't assume `timestamp` - query `tables()` for `designatedTimestamp` column name.

## TypeDB

- **Knowledge graph database**: Strongly-typed database with its own query language (TypeQL), built for knowledge representation and reasoning
- **Rust-native binary**: TypeDB v3 was rewritten in Rust (not Java like QuestDB), making it a simpler start/stop pattern
- **Default port**: 1729 (main TypeDB protocol)
- **Secondary port**: HTTP at port 8000 (main port + 6271)
- **Query language**: TypeQL (not SQL, not REST)
- **Separate console binary**: `typedb_console_bin` for interactive queries and database management
- **No authentication**: Community edition has no auth for local dev
- **No default database**: Explicit database creation required via `database create`
- **Config file**: YAML config (`config.yml`) per container, configures ports, storage, logging
- **Health check**: HTTP GET to port 8000 (`server.http.address`)
- **Backup/restore**: Two-file model (schema + data), exported via `database export` console command
- **Connection scheme**: `typedb://` (e.g., `typedb://127.0.0.1:1729`)
- **Multi-port conflicts**: Each container needs unique main port and HTTP port; monitoring is disabled per-container to avoid conflicts
- **Emoji**: 🤖, **Alias**: `tdb`
- **Version**: 3.8.0 (semver, major=3), MPL-2.0 license

## FerretDB (Composite Engine)

FerretDB is a MongoDB-compatible proxy that stores data in PostgreSQL. Supports **two major versions** with different backends:

**v2 (default, macOS/Linux only):**
1. **ferretdb** (hostdb: `ferretdb`) - Stateless Go proxy
2. **postgresql-documentdb** (hostdb: `postgresql-documentdb`) - PostgreSQL 17 with DocumentDB extension

**v1 (all platforms including Windows):**
1. **ferretdb** (hostdb: `ferretdb`) - Stateless Go proxy (same protocol, older version)
2. **Plain PostgreSQL** - Standard PostgreSQL via `postgresqlBinaryManager` (shared with standalone PG containers)

Architecture: `MongoDB Client (:27017) → FerretDB → PostgreSQL backend (:54320+)`

**Key differences between v1 and v2:**
- v1 uses plain PostgreSQL (lighter, all 5 platforms). v2 uses postgresql-documentdb (DocumentDB extension, macOS/Linux only).
- v1 has auth disabled by default (no `--no-auth` flag). v2 requires `--no-auth` to disable SCRAM.
- v1 needs `?sslmode=disable` on `--postgresql-url` (pgx defaults to TLS, plain PG has no SSL).
- v1 binary verification skips `--version` (hostdb build lacks `version.txt` for go embed).
- v1 engine deletion does NOT delete shared PostgreSQL binaries (v2 cleans up postgresql-documentdb).
- v1 backend may lack `psql` (minimal PG install) — `postgres --single` used pre-start for database creation.

**Windows support:**
- hostdb has `ferretdb` v2 binaries for Windows but NOT `postgresql-documentdb` — v2 would download the proxy but fail to start (no backend).
- `spindb create` auto-selects v1 on Windows. `spindb engines download ferretdb 2` on Windows is blocked with a helpful error.
- `engines/index.ts` does NOT list FerretDB in `WINDOWS_UNSUPPORTED_ENGINES` — version-specific checks handled by the engine itself.

**Three ports per container** — MongoDB (27017), PostgreSQL backend (54320+), debug HTTP (37017+)

**FerretDB-specific flags (in `engines/ferretdb/index.ts`):**
- `--no-auth` - v2 only: disables SCRAM authentication for local development
- `--debug-addr=127.0.0.1:${port + 10000}` - Unique debug HTTP port per container (default 8088 causes conflicts)
- `--listen-addr=127.0.0.1:${port}` - MongoDB wire protocol port
- `--postgresql-url=postgres://postgres@127.0.0.1:${backendPort}/ferretdb` - Backend connection (v1 appends `?sslmode=disable`)

**Known issues & gotchas:**
1. **Authentication**: FerretDB 2.x enables SCRAM by default. `--setup-username`/`--setup-password` flags do NOT exist. Use `--no-auth` for local dev. v1 has auth disabled by default.
2. **Debug port conflicts**: Multiple containers fail if all use default debug port 8088. Solution: `--debug-addr=127.0.0.1:${port + 10000}`
3. **Backup/restore limitations**: pg_dump/pg_restore has issues due to DocumentDB internal metadata tables (v2). Use `custom` format with `--clean --if-exists`.
4. **Connection strings**: No auth needed: `mongodb://127.0.0.1:${port}/${db}`
5. **v1 hostdb build**: FerretDB v1 source uses `//go:embed *.txt` for `build/version/version.txt`. The hostdb build script must create this file before `go build`, otherwise the binary panics on `--version`.
6. **v1 psql missing**: If `postgresqlBinaryManager.isInstalled()` finds an existing minimal PG install that lacks client tools, v1 falls back to `postgres --single` for pre-start database creation.
7. **hostdb-sync test**: Both v1 and v2 FerretDB binaries use the same `ferretdb` hostdb engine name. The hostdb-sync test uses the combined `FERRETDB_VERSION_MAP` to verify all versions against the single `ferretdb` entry in hostdb releases.json.

See [plans/FERRETDB.md](../plans/FERRETDB.md) for full implementation details including hostdb build process.

## Weaviate

- **AI-native vector database**: REST API + gRPC, uses classes/collections instead of databases
- **Dual ports**: HTTP (default 8080) + gRPC (HTTP port + 1)
- **Health endpoint**: `/v1/.well-known/ready`
- **Schema endpoint**: `/v1/schema` (list classes), `/v1/schema/{class}` (class info)
- **No --version flag**: Weaviate binary doesn't support `--version` (as of v1.35.x, tracked in [weaviate/weaviate#6571](https://github.com/weaviate/weaviate/issues/6571)). Binary verification only checks file existence, not version output. Same pattern as CouchDB.
- **Configuration via environment variables**: Uses env vars (not config file) for settings: `PERSISTENCE_DATA_PATH`, `QUERY_DEFAULTS_LIMIT`, `AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED`, `DEFAULT_VECTORIZER_MODULE`, custom `GRPC_PORT`
- **Internal cluster ports**: Weaviate binds 4 internal ports (gossip 7946, data 7947, raft 8300, raft RPC 8301) that **must be unique per container**. SpinDB derives them from HTTP port: gossip=port+100, data=port+101, raft=port+200, raft_rpc=port+201. Also sets `CLUSTER_HOSTNAME=node-{port}` for uniqueness.
- **Backup/restore**: Weaviate filesystem backup API (`POST /v1/backups/filesystem`). Requires `ENABLE_MODULES=backup-filesystem` env var. Backups are **directories** (not single files). The backup directory name **must match** the internal backup ID in `backup_config.json` — `restore.ts` reads this file to use the correct name. When restoring to a different node, `node_mapping` is required in the restore API body. **Windows**: Backup fails with "Access is denied" due to LSM file locking — backup/restore tests are skipped on Windows (same pattern as Meilisearch).
- **Connection scheme**: `http://` (e.g., `http://127.0.0.1:8080`)
- **No CLI shell**: REST API only. `spindb connect` opens web dashboard. `spindb run` N/A.
- **Dashboard URL**: Root path `/` (opens in browser)
- **API key auth**: Optional via `AUTHENTICATION_APIKEY_ENABLED`, `AUTHENTICATION_APIKEY_ALLOWED_KEYS`, `AUTHENTICATION_APIKEY_USERS` env vars
- **Default port**: 8080 (auto-increments on conflict)
- **Version**: 1.35.7 (semver, major=1), BSD-3-Clause license
- **Platforms**: All 5 (macOS ARM/x64, Linux ARM/x64, Windows x64)
- **Emoji**: 🔮, **Alias**: `wv`

## InfluxDB

- **REST API time-series database**: InfluxDB 3.x is a complete Rust rewrite, optimized for high-performance time-series workloads
- **Binary**: `influxdb3` (single binary serves as both server and CLI client)
- **Console**: `influxdb3 query` subcommand provides interactive SQL console (one-shot, wrapped in a prompt loop)
- **Script support**: `.lp` files write data via line protocol, `.sql` files execute queries via REST API
- **Default port**: 8086 (HTTP)
- **Health endpoint**: `/health`
- **Query endpoint**: `POST /api/v3/query_sql` with JSON body `{"q": "SELECT ..."}`
- **Write endpoint**: `POST /api/v3/write_lp?db=<name>` with line protocol body
- **No authentication**: No auth by default for local development
- **Implicit database creation**: Databases are created automatically on first write (no explicit CREATE DATABASE needed)
- **Connection scheme**: `http://` (e.g., `http://127.0.0.1:8086`)
- **Backup/restore**: JSON export via query API
- **Version**: 3.8.0 (semver, major=3), Apache-2.0 AND MIT license
- **Platforms**: macOS ARM/x64, Linux ARM/x64, Windows x64 (all 5 platforms)
- **Emoji**: 📈, **Alias**: `influx`

## Web UI Engines

Engines with built-in web UIs use `openInBrowser()` in `cli/commands/menu/shell-handlers.ts`:
- **DuckDB**: `http://localhost:4213` (built-in UI extension, launched via `duckdb <file> -ui`)
- **Qdrant**: `http://localhost:{port}/dashboard` (Web UI downloaded separately)
- **Meilisearch**: `http://localhost:{port}/` (built-in)
- **ClickHouse**: `http://localhost:8123/play` (built-in Play UI)
- **CouchDB**: `http://localhost:{port}/_utils` (built-in Fauxton)
- **QuestDB**: `http://localhost:{http_port}/` (default 9000, or PG port + 188)
- **Weaviate**: `http://localhost:{port}/` (REST API info display)

Platform commands: `open` (macOS), `xdg-open` (Linux), `cmd /c start` (Windows).

### pgweb (PostgreSQL web panel)

[pgweb](https://github.com/sosedoff/pgweb) is an optional standalone Go binary (MIT license) that provides a web-based database browser for PostgreSQL-compatible engines. Available in the console menu for **PostgreSQL**, **CockroachDB**, and **FerretDB**.

- **On-demand**: Downloaded from GitHub releases on first use, not bundled with SpinDB
- **No schema changes**: Read/write access via standard PostgreSQL protocol, never modifies database internals
- **Lifecycle**: Spawned as a detached background process per container. Stopped via the "Stop pgweb" menu option or automatically when the database engine stops.
- **Port**: Dynamically allocated starting at 8081
- **PID/port tracking**: `{containerDir}/pgweb.pid` and `{containerDir}/pgweb.port`
- **Platforms**: macOS ARM/x64, Linux ARM/x64, Windows x64
- **Version**: 0.17.0 (pinned)

### dblab (visual TUI)

[dblab](https://github.com/danvergara/dblab) is an optional standalone Go binary (MIT license) that provides a visual terminal UI with table browsing, query editor, and scrollable results. Available in the console menu for **PostgreSQL**, **MySQL**, **MariaDB**, **CockroachDB**, **SQLite**, and **QuestDB**.

- **On-demand**: Downloaded from GitHub releases on first use, not bundled with SpinDB
- **Interactive TUI**: Spawned with `stdio: 'inherit'` (foreground, not detached like pgweb)
- **Drivers**: `postgres` (PostgreSQL, CockroachDB, QuestDB), `mysql` (MySQL, MariaDB), `sqlite3` (SQLite)
- **Connection**: Flag-based (`--host`, `--port`, `--user`, `--db`, `--driver`) to avoid MySQL `tcp()` URL issues
- **Platforms**: macOS ARM/x64, Linux ARM/x64, Windows x64 (tar.gz archives)
- **Version**: 0.34.2 (pinned)
- **CLI flags**: `spindb connect --dblab` or `spindb connect --install-dblab`

## Database Create/Rename/Drop Support

### Engines with native rename
- **PostgreSQL**: Uses `ALTER DATABASE "old" RENAME TO "new"` (atomic, instant, since PG 7.4)
- **ClickHouse**: Uses `RENAME DATABASE "old" TO "new"` (atomic, instant)
- **CockroachDB**: Uses `ALTER DATABASE "old" RENAME TO "new"` (atomic, instant)
- **Meilisearch**: Uses `PATCH /indexes/{uid}` with `{"uid": "new"}` (atomic, since v1.18.0)

### Engines using backup/restore rename strategy
MySQL, MariaDB, MongoDB, FerretDB, SurrealDB, TypeDB, InfluxDB, CouchDB,
Qdrant, Weaviate — rename creates a safety backup at
`~/.spindb/backups/rename/{container}-{db}-rename-{timestamp}.{ext}`, creates the new
database, restores data, then drops the old one. If the drop fails, the data is safe in
the new database and a warning is shown.

### Engines that don't support database operations
- **SQLite/DuckDB**: File-based. The file IS the database.
- **Redis/Valkey**: Fixed numbered databases (0-15).
- **QuestDB**: Single-database model (`qdb`).
- **TigerBeetle**: Single ledger per container.
