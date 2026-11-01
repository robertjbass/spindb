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
- **Query server (QuickJS)**: `validate_doc_update` and map functions run in an external JavaScript query server, so any write to `_users` needs one that actually starts. SpinDB points `COUCHDB_QUERY_SERVER_JAVASCRIPT` at the bundled QuickJS server, `<binDir>/lib/couch_quickjs-<version>/priv/couchjs_mainjs` (CoffeeScript slot: `couchjs_coffee`), resolved by `resolveCouchDBQueryServer()` in `engines/couchdb/index.ts`. The directory is GLOBBED, not interpolated from the container version, because the bundled `couch_quickjs` version need not match. QuickJS is self-contained; the older `bin/couchjs` is not shipped on macOS and is linked against an absent `libmozjs-78.so.0` on Linux, and pointing at it bare (no `share/server/main.js`) made every `_users` write a 500. When no QuickJS build exists, spindb sets neither variable and lets the launcher's own default apply.
- **Logging**: the generated `local.ini` sets `[log] writer = file`. CouchDB's default writer is stderr, and spindb spawns the server with stderr set to `ignore`, so without it the `file` setting is inert and the log is empty. `patchCouchDBConfig()` adds the line to older containers on their next start.

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
- v1 has auth disabled by default (no `--no-auth` flag). v2 defaults to `--no-auth` (SCRAM disabled). Use `spindb start --auth` to enable SCRAM on v2; `spindb start --no-auth` to restore the default. Persisted in `ContainerConfig.authEnabled`.
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
- `--no-auth` - v2 only: disables SCRAM authentication (default). Omitted when `container.authEnabled === true` (set via `spindb start --auth`)
- `--debug-addr=127.0.0.1:${port + 10000}` - Unique debug HTTP port per container (default 8088 causes conflicts)
- `--listen-addr=127.0.0.1:${port}` - MongoDB wire protocol port
- `--postgresql-url=postgres://postgres@127.0.0.1:${backendPort}/ferretdb` - Backend connection (v1 appends `?sslmode=disable`)

**Known issues & gotchas:**
1. **Authentication**: FerretDB 2.x enables SCRAM by default. `--setup-username`/`--setup-password` flags do NOT exist. SpinDB defaults to `--no-auth` for local dev. Use `spindb start --auth` to enable SCRAM (persisted). v1 has auth disabled by default (flag doesn't exist).
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

## LibSQL

- **SQLite fork by Turso**: LibSQL (sqld) runs SQLite as a server with an HTTP API (Hrana protocol), enabling network access to SQLite databases
- **Binary**: `sqld` (single binary, server only)
- **Default port**: 8080 (HTTP API)
- **Health endpoint**: `/health`
- **Connection scheme**: `http://` (e.g., `http://127.0.0.1:8080`)
- **Single database**: Each instance serves a single database ('main'). No database creation/rename/drop.
- **Platforms**: macOS ARM/x64, Linux ARM/x64 only (no Windows). Use WSL on Windows.
- **REST API only**: No CLI shell. `spindb connect` shows curl examples for the HTTP API. `spindb run` is not available.
- **JWT authentication via Ed25519**: `createUser()` generates an Ed25519 key pair, signs a JWT with the private key, writes the public key to the container directory as `jwt-key.pem`, restarts sqld with `--auth-jwt-key-file jwt-key.pem`. The JWT token is stored via credential-manager (same pattern as Meilisearch API keys). Not controlled by `--auth`/`--no-auth` flags.
- **Backup formats**: Binary (file copy of the SQLite database file) and SQL (HTTP API dump via `/v1/dump`). Binary is the default format.
- **Query execution**: Uses the Hrana HTTP API (`POST /v2/pipeline`) with JSON body containing SQL statements. Supports `spindb query` for structured output.
- **layerbase-cloud notes**: `setup-database.sh` generates an Ed25519 key pair, creates a JWT, and passes the public key to sqld via `--auth-jwt-key-file`. The JWT is used as the bearer token for API requests.
- **Emoji**: 📚, **Alias**: `lsql`

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
- **LibSQL**: Single database per instance ('main').

---

## Agent Implementation Notes

Engine rules moved verbatim from the former `CLAUDE.md` (now [AGENTS.md](../AGENTS.md)). Read the matching subsection before touching that engine or path.

### PostgreSQL client tools are bundled-only

**PostgreSQL client tools are bundled-only:** `pg_dump`, `pg_restore`, `psql`, and `pg_basebackup` for a specific major version MUST be resolved through `core/pg-binary-resolver.ts` (`getBundledBinaryPath`, `findCompatibleVersion`) which only looks under `~/.spindb/bin/postgresql-<version>-<platform>-<arch>/bin/`. Never probe Homebrew (`/opt/homebrew/opt/postgresql@X`), APT (`/usr/lib/postgresql/X`), or any other system package manager. If a bundled binary is missing, surface `spindb engines download postgresql <major>` - do not tell users to `brew install postgresql@X`. This was historically violated in `core/homebrew-version-manager.ts` (removed); the version-mismatch path during `spindb pull` was silently requiring Homebrew's `postgresql@18` even when spindb's own pg 18 was already on disk. The regression test in `tests/unit/pg-binary-resolver.test.ts` enforces this.

### MySQL family: data directory, remote dumps and definers

**A MySQL-family start cross-checks the data directory before spawning the server.** `start()` picks the server binary from `container.json`'s `version` alone, and mariadbd/mysqld will open whatever data directory they are pointed at - a NEWER major upgrades it in place on first boot, and MariaDB has no cross-major downgrade, so a wrong `version` is a one-way trip. Both servers record the last server version that opened a data directory in a one-line file at its root (`data/mariadb_upgrade_info` on MariaDB 11+, `data/mysql_upgrade_info` on MariaDB 10.x and MySQL 5.7 and older; MySQL 8+ keeps that state in the data dictionary and writes no file). `core/mysql-family-datadir-version.ts` reads it and refuses the start when the two name different major.minor lines. Rules if you touch it: a newer PATCH on the same line must stay allowed (11.8.8 data under 11.8.9), a missing or unparsable file must start exactly as before, and a bare-major `version` compares majors only so an unknowable minor cannot produce a false refusal. It is a pure guard with no repair path on purpose: spindb cannot move a data directory across release lines, so the message points at backup plus restore into a new container.

**A remote dump follows the SOURCE server, and for the MySQL family that means flavor as well as version.** `spindb restore --from-url` / `pull` / `create` pick their dump tool from the server on the other end of the connection string, not from the container being restored into. PostgreSQL has done this since `validateDumpCompatibility` (`engines/postgresql/version-validator.ts`), which swaps in a `pg_dump` that can read the remote major. MySQL and MariaDB share a wire protocol AND the `mysql://` scheme, so the URL does not say which server answers: `core/server-handshake.ts` (engine-agnostic, never writes to the socket, so it works against a TLS-required server) reads the greeting and classifies it, a MariaDB source is dumped with `mariadb-dump`, and the dump is converted for the MySQL target by `engines/mysql/dump-normalize.ts` (uca1400 collations -> MySQL `0900`, `NO_AUTO_CREATE_USER` stripped from `SET sql_mode`). This is NOT a MySQL special case to copy from - any engine family whose client tools are not interchangeable belongs on the same path. Which installed binary serves a given version is `core/mysql-family-binary-resolver.ts`, the MySQL-family twin of `core/pg-binary-resolver.ts`; `configManager.getBinaryPath(tool)` keeps ONE path per tool name with no version dimension, so it must never be the first thing a version-sensitive path asks.

**Remote MySQL-family object owners:** `core/mysql-import-definers.ts` rewrites explicit `DEFINER=user@host` clauses in remote MySQL/MariaDB dumps to `CURRENT_USER` before restoration. Both engines call it from `dumpFromConnectionString`; local backups and restore streams retain their owners. Preserve literal bytes, version-comment wrappers, and `SQL SECURITY` semantics. Counts travel as `remoteSource.rewrites.definersRewritten`; temporary output is registered for signal cleanup. The real-engine drill is `tests/integration/mysql-import-definers.test.ts` (explicit disposable binary root).

**A remote dump is compressed on the wire, a local backup is not, and the temp dump survives nothing.** The MySQL and MariaDB remote-dump argument builders pass protocol compression (`--compression-algorithms=zlib` for `mysqldump`, `--compress` for `mariadb-dump`) because a dump taken from a connection string crosses the internet, where row data compresses roughly 68x. Do NOT copy those flags into the local `backup()` path: over loopback it only burns CPU. Two constraints to keep: `mysqldump`'s deprecated `-C, --compress` must never come back (it warns on stderr, which the restore paths parse), and `mariadb-dump --compress` is passed ONLY for a source the greeting identifies as MariaDB, because against a MySQL server whose auth plugin the client cannot load it hangs forever instead of reporting the error. Separately, the temp dump that the `--from-url` flow writes is registered with `core/temp-dump-cleanup.ts`, which removes it and kills the dump client on SIGTERM/SIGINT/SIGHUP, then exits 128 + the signal. Any new code that writes a temp dump must register it there; a `finally` block alone is skipped by a signal, which is how a 450 MB partial dump was left inside a customer's container.

### Local credentials and auth-backed backup/restore

**Redis/Valkey local query auth:** `spindb query` for local server containers does **not** use ad-hoc env vars from the caller. In `cli/commands/query.ts`, the local-server path loads credentials from `credential-manager.loadCredentials(containerName, engineName, getDefaultUsername(engineName))`. For Redis/Valkey, that means the filename stays `.env.spindb`, but the file contents can still be `DB_USER=default` and `DB_PASSWORD=...`. If cloud or desktop query auth breaks, inspect the saved credential file path and contents before changing CLI flags.

**Local backup/restore auth uses the same default credential file:** As of March 28, 2026, PostgreSQL, MySQL, MariaDB, MongoDB, FerretDB, Redis, Valkey, CouchDB, and SurrealDB local backup/restore paths load server credentials from `loadCredentials(containerName, engine, getDefaultUsername(engine))`. That feeds the engine-native auth mechanism instead of assuming localhost trust:
- PostgreSQL: `PGPASSWORD` for `pg_dump` / `psql` / `pg_restore`
- MySQL / MariaDB: `MYSQL_PWD` for dump, restore, readiness, shutdown, and local admin commands
- MongoDB: `--uri mongodb://...?...authSource=...` for `mongodump`, `mongorestore`, and local `mongosh` query/admin paths
- FerretDB: local `mongosh`, `mongodump`, and `mongorestore` now go through the MongoDB wire protocol with saved `.env.spindb` credentials; legacy PostgreSQL `.dump` / `.sql` restores are still supported as a fallback
- Redis / Valkey: `REDISCLI_AUTH` for backup, text restore, readiness, and graceful shutdown
- CouchDB: saved admin credentials for REST backup/restore and local admin API calls
- SurrealDB: local query/backup/restore commands load `.env.spindb`, infer `authLevel` from the saved `DB_URL`, and pass `--auth-level` to `surreal sql` / `export` / `import`; server startup still uses stable bootstrap root creds instead of replaying saved client creds
If a password-protected local backup or restart fails, inspect `.env.spindb` before changing engine flags.

**Focused auth-backed backup/restore coverage now exists for the main password-protected engines:** PostgreSQL, MySQL, MariaDB, MongoDB, FerretDB, Redis, Valkey, CouchDB, and SurrealDB now have focused integration coverage that:
- enables real local auth
- writes `.env.spindb`
- restarts the container through the normal engine lifecycle
- verifies backup and restore against an auth-enabled target
The focused March 28, 2026 auth sweep passed sequentially for all of the engines above. MariaDB still has unrelated broader-suite initialization flakiness on this machine, so treat that as a test-harness/platform issue rather than an auth backup/restore gap.

**The auth-backed backup/restore sweep was extended on March 29, 2026 to the remaining major auth-sensitive server engines:** ClickHouse, QuestDB, TypeDB, InfluxDB, Meilisearch, Weaviate, Qdrant, and LibSQL now have explicit auth-aware local backup/restore verification rather than relying on anonymous localhost assumptions. Verification status:
- ClickHouse and Qdrant have focused auth-backed integration coverage in addition to their broader engine suites
- QuestDB, TypeDB, InfluxDB, Meilisearch, Weaviate, and LibSQL now also have focused integration coverage for local auth-enabled backup/restore
- InfluxDB local auth is now driven by a persisted `admin-token.json` file passed to `influxdb3 serve --admin-token-file`; the token file must contain JSON (`{"token":"...","name":"..."}`), not raw text
- Meilisearch local auth is now driven by a persisted `master.key` file passed to `meilisearch --master-key`; `createUser()` currently configures that master key directly for local auth-backed backup/restore
- Qdrant restore is special: restore writes a pending storage-snapshot marker and `start()` must consume it with `--storage-snapshot`; copying snapshot files alone is not deterministic enough once auth-backed restore is in play

**CockroachDB local development now runs in secure mode:** local containers generate per-container Cockroach certs, start with `--certs-dir`, use root client-cert auth for internal admin flows, and return TLS connection strings for created users. Focused integration coverage now proves password-auth backup/restore against secure local CockroachDB. SQLite, DuckDB, and TigerBeetle remain explicit "not applicable" cases for username/password local backup semantics unless product scope changes.

**SurrealDB auth nuance:** `surreal import` still needs root-level permissions. Namespace-scoped users can query and export, but the focused restore path only passed once the saved default credential file used root creds with `authLevel=root`. Keep that distinction in mind:
- server start: bootstrap with stable root creds
- client query/export/import: load `.env.spindb` and pass `--auth-level`
- restore/import: do not assume namespace/database users are allowed to import

**SurrealDB CLI JSON output is noisy:** `surreal sql --json` can emit prompt text before or after the JSON payload (for example `surrealdb_namespace/db>`). `parseSurrealDBResult()` now extracts the first complete JSON document instead of assuming stdout is pure JSON. If Surreal query parsing regresses, inspect raw stdout before blaming auth or query semantics.

### Restore outcomes and restore modes

**A restore that could not create every object is a SUCCESS with a `status`, not a failure.** `pg_restore` keeps going past an object it cannot create, so a dump referencing a missing extension or role can fail every dependent `CREATE TABLE`, skip every `COPY` into those tables, and still exit zero (this cost a customer 19 tables in a Supabase migration). `engines/postgresql/restore-diagnostics.ts` parses what the tool said and `core/restore-outcome.ts` (`classifyRestoreOutcome`) turns it into ONE verdict shared by `cli/commands/restore.ts`, `cli/commands/create.ts`, the menu restore handlers and `core/backup-restore.ts` - never re-derive it at a call site. The contract: `success: true` and exit 0 for a partial restore (the database exists and holds what landed; a rollback would throw that away), with `status: 'completed_with_errors'` plus `restoreErrorCount` / `restoreErrors` / `restoreWarningCount` / `restoreIgnoredErrors` / `restoreErrorsTruncated` in `--json`. A `FATAL`, or a non-zero exit with no object errors to explain it, is a real failure that throws and rolls back. `--pre-sql <file>` is the fix path (create the extension/roles first); it is gated to the engines whose `runScript` honors `quiet`, because `--json` owns stdout. Never let a restore path print to STDOUT in `--json` mode, and never use `(error as Error).message` in these commands - use `describeThrown` (`core/error-handler.ts`), or a non-Error rejection serializes to `{}`.

**Restore has two modes (the destructive default vs `--into-existing`):** the default `spindb restore` DROPS + recreates the target database (the drop lives in `cli/commands/restore.ts`, NOT the per-engine `restore()`, which is mostly additive). On PostgreSQL the drop clears the target database's sessions - that lives INSIDE the engine's `dropDatabase`, so every caller inherits it and a restore over a database someone is still connected to no longer fails with `database "<name>" is being accessed by other users`. On 13+ it is `DROP DATABASE ... WITH (FORCE)` (`engines/postgresql/drop-database-sql.ts` holds the version gate and the pure SQL builders), which terminates inside the same statement and so cannot lose the reconnect race a separate terminate-then-drop leaves open for a pooler; pre-13 keeps the two-step plus one retry. A drop that fails anyway stops the restore before anything is destroyed and reports the server's own text, with `phase: 'drop-target'` in `--json`. `--into-existing` restores INTO the existing database without dropping it - it skips the CLI drop, the recreate, AND the drop-on-failure rollback (a failed in-place restore must never drop the caller's data), and passes object-level clean so the result REPLACES the backed-up objects. Two semantics to keep in mind: (1) it is "overlay the backup," not "reset to exactly the backup" - objects created AFTER the backup (a table/collection not in it) survive; (2) it is gated to an `INTO_EXISTING_ENGINES` allowlist (wire engines only: pg/mysql/mariadb/mongo/ferret/cockroach/clickhouse/questdb) so an engine whose restore can't replace-in-place errors instead of silently merging. Add an engine to the allowlist ONLY with clean-restore support + a real-engine integration round-trip test. **Mongo/Ferret backups are interchangeable** (both produce `mongodump` archives; either restores into the other) - guarded by `tests/integration/mongo-ferret-interop.test.ts`. The uncompressed mongodump archive magic is `6d e2 99 81` (= `0x8199e26d`); restore must NOT add `--gzip` for it (the `unknown`-format fallback no longer does - it once caused `gzip: invalid header` on every `archive-plain` restore).

### Redis and Valkey auth

**Redis `default` user vs `--user` flag:** Managed Redis/Valkey setups that use `requirepass` often expect the implicit default user and fail when `redis-cli --user default` is passed explicitly. The fix was to omit `--user` when the resolved username is literally `default`, while still passing `--user` for explicit ACL usernames. This logic must stay aligned in both Redis query paths:
- remote connection-string query path (`dumpFromConnectionString`)
- local/linked query execution path (`executeQuery`)

**Heroku's legacy `h` username is not an ACL user:** the classic Redis add-on minted URLs shaped like `rediss://h:<password>@host:port`, where `h` is a dummy placeholder (modern Heroku Key-Value URLs leave the username empty). `AUTH h <password>` fails with `WRONGPASS` on those servers, and `redis-cli --user h` fails the same way. Both auth paths now handle it: `buildRespAuthArgs()` in `engines/redis/resp-client.ts` sends the one-argument `AUTH`, and `shouldPassRedisCliUsername()` in `engines/redis/cli-common.ts` omits `--user`. They share one source of truth, the exported `IMPLICIT_RESP_USERNAMES` set (`default` and `h`) in `resp-client.ts`, so a placeholder added to that set covers both paths at once. Matching is exact, never trimmed or lowercased, so a real ACL user like `hasura` is unaffected. `engines/redis/index.ts` re-exports the `cli-common.ts` helper rather than defining a second copy; keep it that way.

**When debugging Redis/Valkey query auth, test both paths:** a change can fix remote URL queries and still break local container queries, or vice versa. The cloud incident on March 26-27, 2026 only became clear after checking both the cloud-managed local container path and the remote URL path.

### Process, binary and platform quirks

**LibSQL JWT auth via Ed25519:** LibSQL uses JWT tokens signed with Ed25519 keys for authentication. `createUser()` generates an Ed25519 key pair, signs a JWT with the private key, writes the public key to the container directory as `jwt-key.pem`, restarts sqld with `--auth-jwt-key-file`, and stores the JWT token via credential-manager. The same pattern as Meilisearch API keys - credential is a token, not a username/password pair.

**Shell script / JRE engines (QuestDB pattern):** Shell scripts that fork Java processes give useless PIDs. After health check, find real PID via `platformService.findProcessByPort(port)` and write to PID file. Stop also uses port lookup first, PID file as fallback. See `engines/questdb/index.ts`.

**Binary `--version` verification:** `BaseBinaryManager.verify()` runs `binary --version` after download. Some engines don't support this flag - CouchDB (Erlang app, tries to start) and Weaviate (some releases lack `--version` support). These engines override `verify()` in their `binary-manager.ts` to just check binary existence instead. See `engines/couchdb/binary-manager.ts` and `engines/weaviate/binary-manager.ts`. Consult hostdb's `databases.json` for currently supported Weaviate versions rather than embedding specific version numbers.

**Weaviate internal cluster ports:** Weaviate binds 4 internal ports (gossip 7946, data 7947, raft 8300, raft RPC 8301) that MUST be unique per container. SpinDB derives them from the HTTP port: gossip=port+100, data=port+101, raft=port+200, raft_rpc=port+201. Also sets `CLUSTER_HOSTNAME=node-{port}`. Without unique ports, multiple containers silently conflict or fail to start.

**Weaviate backup/restore:** Requires `ENABLE_MODULES=backup-filesystem` env var. Backups are directories (not single files). The directory name MUST match the internal backup ID in `backup_config.json` - `restore.ts` reads this file to use the correct name. When restoring to a container with a different `CLUSTER_HOSTNAME`, the restore API requires a `node_mapping` body parameter. See `engines/weaviate/README.md`.

**Qdrant snapshot restore on Windows is not stable yet:** Qdrant 1.16.x full snapshot restore via startup-time recovery still panics on Win x64 with `Too many parts in snapshot mapping`. Keep Windows coverage for create/start/query, but treat clone/auth-backed snapshot restore as a known gap until the restore path is reworked or upstream behavior changes.

**Dynamic library errors (MariaDB, Redis, Valkey):** hostdb binaries for these engines are dynamically linked against Homebrew's OpenSSL (`/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib`). On Macs without `brew install openssl@3`, they fail with `dyld: Library not loaded` errors. `core/library-env.ts` provides two utilities: `getLibraryEnv(binPath)` returns `DYLD_FALLBACK_LIBRARY_PATH` (macOS) or `LD_LIBRARY_PATH` (Linux) pointing to `{binPath}/lib` - spread into spawn env options. `detectLibraryError(output, engineName)` scans stderr/logs for dyld, GLIBC, and shared-library patterns, returning an actionable error message or null. When adding new engines with dynamically-linked binaries, use these utilities in `start()` and `initDataDir()` spawn calls. See `engines/redis/index.ts` for the canonical integration pattern.

### FerretDB v1 vs v2

**FerretDB v1 vs v2:** FerretDB is a single engine (`Engine.FerretDB`) with version-branched behavior via `isV1(version)` in `engines/ferretdb/version-maps.ts`. Key differences:
- **Backend:** v1 uses plain PostgreSQL (shared with standalone PG containers). v2 uses postgresql-documentdb (separate binary).
- **Platforms:** v1 supports all 5 platforms including Windows. v2 is macOS/Linux only.
- **Cascade delete:** v1 does NOT delete shared PostgreSQL binaries on engine delete. v2 cleans up postgresql-documentdb.
- **Auth:** v1 has auth disabled by default (no `--no-auth` flag). v2 defaults to `--no-auth` (SCRAM disabled). `spindb start --auth` omits `--no-auth` to enable SCRAM; `spindb start --no-auth` restores the default. Persisted in `ContainerConfig.authEnabled`.
- **SSL:** v1 needs `?sslmode=disable` on PostgreSQL URL. v2 omits it.
- **DB creation:** v1 falls back to `postgres --single` if psql is unavailable. v2 uses psql.
- See `docs/ENGINE_NOTES.md` FerretDB section for the full list.

### PostgreSQL scheduled jobs (pg_cron)

`engines/postgresql/cron-config.ts` acts only after the user explicitly includes
pg_cron in the effective preload list. Artifact availability alone never enables
it. pg_cron ships inside the standard hostdb builds (Linux x64); support is a
capability check on the binary (`hasPgCron`), never a version-name check. The
`-cron.N` revisions (`isCronBuildRevision`) are a compatibility shim only: never
offered, never healed onto, and a container already pinned to one stays on it.
Healing an opted-in container (`isPostgresCronOptedIn`) only picks binaries with
pg_cron. `spindb engines download postgresql <v> --refresh` re-fetches a version
hostdb rebuilt in place (cache is by directory; refused while a database on
that version runs; local stores only: never on a store shared with other
containers/hosts, since it renames and deletes the directory under them).
Self-heal for an opted-in container falls back from its pinned version to the
major default only on `BinaryVersionNotFoundError` (registry 404 / not built
for the platform); any other download failure is rethrown with the pin kept. Do not create extension catalogs on start/wake. Never persist a merged preload
on ordinary starts: this shadows future postgresql.conf edits. The sole recovery
exception removes pg_cron from the effective list when its artifact is missing,
then persists launch_active_jobs=off; keep all other libraries and catalog data.
An opted-in, supported cluster gets `.spindb-pg-cron.json` in its data directory
for Cloud's bounded history maintenance; remove that marker when not opted in. Branch/copy preparation
persists cron.launch_active_jobs=off. Restore preparation pauses without a restart
(ALTER SYSTEM + pg_reload_conf, a PGC_SIGHUP setting), confirms the pause and ends
in-flight pg_cron workers, and keeps restored definitions paused. Temporary starts use --no-scheduled-jobs, a
process-only override. Cloud must carry it through setup restarts. The opt-in
real-binary tests are tests/integration/postgresql-cron.test.ts and
postgresql-cron-cli.test.ts. Release through hostdb first; do not pin unpublished
artifacts or package versions.

### Standalone DocumentDB

See `engines/documentdb/README.md`. The official native gateway and backend are one
versioned HostDB bundle. Linux x64/ARM64 and macOS 14+ ARM64, loopback gateway with mandatory
authentication, private peer-authenticated PostgreSQL socket. Do not reuse the
FerretDB backend mapping or infer a runtime pin for existing data. Candidate
qualification may explicitly link a HostDB checkout; published dependencies must
remain exact pins and follow the normal HostDB-first release cascade.

### History: E2E stabilization fixes (0.47.3 to 0.47.13)

Key fixes from the E2E stabilization session:
- **0.47.4:** CouchDB skip admin auth when no saved credentials, ClickHouse 240s timeout
- **0.47.5/6:** DuckDB binary lookup + file path in cloud containers
- **0.47.7:** Weaviate RAFT cleanup on bind change, SurrealDB skip --user/--pass on restart
- **0.47.8/9:** Weaviate RAFT cluster identity + 120s timeout
- **0.47.10:** SurrealDB reads saved credentials from credential file
- **0.47.12:** `--namespace` flag for `spindb query`, type-safe `QueryOptions`
- **0.47.13:** MongoDB `waitForReady` falls back to TCP when auth rejects mongosh
