# CLAUDE.md - Project Context for Claude Code

## Related Documentation

| File | Purpose |
|------|---------|
| [STYLEGUIDE.md](STYLEGUIDE.md) | Coding conventions and style guidelines |
| [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) | **Authoritative guide & checklist** for adding new database engines |
| [ARCHITECTURE.md](ARCHITECTURE.md) | High-level design, layers, data flow |
| [MIGRATION.md](MIGRATION.md) | Historical guide for migrating engines to hostdb |
| [ENGINES.md](ENGINES.md) | Supported engines overview |
| [TODO.md](TODO.md) | Roadmap and backlog |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Project Overview

SpinDB is a CLI tool for running local databases without Docker. It's a lightweight alternative to DBngin and Postgres.app, downloading database binaries directly from [hostdb](https://github.com/robertjbass/hostdb). Supports PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, and QuestDB.

**Target audience:** Individual developers who want simple local databases with consumer-grade UX.

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Execution**: `tsx` for direct TypeScript execution (no build step)
- **Package Manager**: pnpm (strictly - not npm/yarn)
- **CLI Framework**: Commander.js
- **Interactive UI**: Inquirer.js (prompts), Chalk (colors), Ora (spinners)
- **Module System**: ESM (`"type": "module"`)

## Project Structure

```
cli/                    # CLI commands and UI
  commands/             # CLI commands (create, start, stop, etc.)
    menu/               # Interactive menu handlers
  ui/                   # Prompts, spinners, theme
core/                   # Core business logic
  container-manager.ts  # Container CRUD
  process-manager.ts    # Process start/stop
  config-manager.ts     # ~/.spindb/config.json
  dependency-manager.ts # Tool detection/installation (see KNOWN_BINARY_TOOLS)
config/                 # Configuration files
  engines.json          # Engines registry (source of truth)
  engine-defaults.ts    # Default ports, versions
engines/                # Database engine implementations
  base-engine.ts        # Abstract base class
  {engine}/             # Each engine: index.ts, backup.ts, restore.ts, version-maps.ts
types/index.ts          # TypeScript types (Engine enum, BinaryTool type)
tests/
  unit/                 # Unit tests
  integration/          # Integration tests (use reserved ports, see below)
  fixtures/             # Test data
```

## Key Architecture

### Multi-Engine Support

Engines extend `BaseEngine` abstract class. See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for full method list.

**Server-based engines** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB):
- Data in `~/.spindb/containers/{engine}/{name}/`
- Port management, start/stop lifecycle

**File-based engines** (SQLite, DuckDB):
- Data in user project directories (CWD), not `~/.spindb/`
- No server process - `start()`/`stop()` are no-ops
- Status determined by file existence, not process state
- Registry in `~/.spindb/config.json` tracks files by name
- Use `spindb attach <path>` / `spindb detach <name>` to manage registry

**REST API engines** (Qdrant, Meilisearch, CouchDB):
- Server-based but interact via HTTP REST API instead of CLI tools
- `spindb run` is not applicable (no CLI shell)
- `spindb connect` opens the web dashboard in browser
- Backup/restore uses REST API endpoints (snapshots for Qdrant/Meilisearch, `_all_docs`/`_bulk_docs` for CouchDB)
- Docker E2E tests use `curl` for connectivity and data operations

**Engines with built-in web UIs**:
- **Qdrant**: Dashboard at `http://localhost:{port}/dashboard`
- **Meilisearch**: Dashboard at `http://localhost:{port}/`
- **ClickHouse**: Play UI at `http://localhost:8123/play`
- **CouchDB**: Fauxton dashboard at `http://localhost:{port}/_utils`
- **QuestDB**: Web Console at `http://localhost:{http_port}/` (default port 9000, or PG port + 188)

For these engines, the "Connect/Shell" menu option opens the web UI in the system's default browser using `openInBrowser()` in `cli/commands/menu/shell-handlers.ts`. Use platform-specific commands: `open` (macOS), `xdg-open` (Linux), `cmd /c start` (Windows).

### Engine-Specific Implementation Notes

**Meilisearch:**
- **Snapshots directory placement**: MUST be a sibling of the data directory, not inside it. Meilisearch fails with "failed to infer the version of the database" if `--snapshot-dir` points inside `--db-path`. Directory structure: `container/data/` and `container/snapshots/` (not `container/data/snapshots/`).
- **Index naming**: Uses "indexes" instead of databases. Index UIDs only allow alphanumeric characters and underscores. Container names with dashes are auto-converted (e.g., `my-app` → index `my_app`).
- **Health endpoint**: `/health` (returns `{"status":"available"}`)
- **No secondary port**: Unlike Qdrant (HTTP + gRPC), Meilisearch only uses HTTP port
- **Dashboard URL**: Root path `/` (not `/dashboard` like Qdrant)

**Qdrant:**
- **Dual ports**: HTTP (default 6333) + gRPC (default 6334, typically HTTP+1)
- **Health endpoint**: `/healthz`
- **Dashboard URL**: `/dashboard`
- **Config file**: Uses YAML config (`config.yaml`) for settings

**MongoDB & FerretDB:**
- **Implicit database creation**: MongoDB/FerretDB don't create databases until you first write data. To force immediate creation (so the database appears in tools like TablePlus), `createDatabase()` creates a temp collection `_spindb_init` and immediately drops it. This leaves the database visible with no marker clutter.
- **Connection via mongosh**: Both engines use MongoDB's `mongosh` shell for connections and script execution
- **Database validation**: Database names must be alphanumeric + underscores (same as SQL engines)

**CouchDB:**
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

**SurrealDB:**
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

**QuestDB:**
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
- **PID handling**: QuestDB's shell script forks and exits immediately - the spawned shell's PID is useless. QuestDB also doesn't create its own PID file. Solution: find the actual Java process by port after startup using `platformService.findProcessByPort()` and write that PID to our PID file. See "Shell Script / JRE Engines" gotcha below.
- **Multi-port conflicts**: When running multiple QuestDB containers, must configure ALL ports uniquely via environment variables: `QDB_HTTP_BIND_TO`, `QDB_HTTP_MIN_NET_BIND_TO`, `QDB_PG_NET_BIND_TO`, `QDB_LINE_TCP_NET_BIND_TO`. The HTTP Min Server (health/metrics) defaults to port 9003 for all instances and will cause conflicts if not configured.
- **Backup timestamp column**: QuestDB tables have a designated timestamp column that can have any name. Don't assume `timestamp` - query `tables()` for `designatedTimestamp` column name.

### Binary Manager Base Classes

When adding a new engine, choose the appropriate binary manager base class:

| Base Class | Location | Used By | Use Case |
|------------|----------|---------|----------|
| `BaseBinaryManager` | `core/base-binary-manager.ts` | Redis, Valkey, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB | Key-value/vector/search/document/time-series stores with `bin/` layout |
| `BaseServerBinaryManager` | `core/base-server-binary-manager.ts` | PostgreSQL, MySQL, MariaDB, ClickHouse | SQL servers needing version verification |
| `BaseDocumentBinaryManager` | `core/base-document-binary-manager.ts` | MongoDB, FerretDB | Document DBs with macOS tar recovery |
| `BaseEmbeddedBinaryManager` | `core/base-embedded-binary-manager.ts` | SQLite, DuckDB | File-based DBs with flat archive layout |

**Decision tree:**
1. Is it a file-based/embedded database (no server process)? → `BaseEmbeddedBinaryManager`
2. Is it a SQL server needing `--version` verification? → `BaseServerBinaryManager`
3. Is it a document-oriented database? → `BaseDocumentBinaryManager`
4. Is it a key-value store or vector database? → `BaseBinaryManager`

**Note:** PostgreSQL uses `BaseServerBinaryManager` with a custom `verify()` override for its version output format. EDB binaries for Windows are uploaded to hostdb, so all platforms use the same download path.

See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for detailed implementation guidance and code examples.

### Engine Aliases

Engines can be referenced by aliases in CLI commands:
- `postgresql`, `postgres`, `pg` → PostgreSQL
- `mongodb`, `mongo` → MongoDB
- `ferretdb`, `ferret` → FerretDB
- `sqlite`, `lite` → SQLite
- `qdrant`, `qd` → Qdrant
- `meilisearch`, `meili`, `ms` → Meilisearch
- `couchdb`, `couch` → CouchDB
- `cockroachdb`, `crdb` → CockroachDB
- `surrealdb`, `surreal` → SurrealDB
- `questdb`, `quest` → QuestDB

### Supported Versions & Query Languages

| Engine | Versions | Query Language | Notes |
|--------|----------|----------------|-------|
| PostgreSQL 🐘 | 14, 15, 16, 17, 18 | SQL | |
| MySQL 🐬 | 8.0, 8.4, 9 | SQL | |
| MariaDB 🦭 | 10.11, 11.4, 11.8 | SQL | |
| MongoDB 🍃 | 7.0, 8.0, 8.2 | JavaScript | Uses mongosh |
| FerretDB 🦔 | 2 | JavaScript | MongoDB-compatible, PostgreSQL backend |
| Redis 🔴 | 7, 8 | Redis commands | Databases 0-15 (numbered) |
| Valkey 🔷 | 8, 9 | Redis commands | Uses `redis://` scheme for compatibility |
| ClickHouse 🏠 | 25.12 | SQL | XML configs, HTTP port 8123 |
| SQLite 🗄️ | 3 | SQL | File-based |
| DuckDB 🦆 | 1.4.3 | SQL | File-based, OLAP |
| Qdrant 🧭 | 1 | REST API | Vector search, HTTP port 6333 |
| Meilisearch 🔍 | 1.33.1 | REST API | Full-text search, HTTP port 7700 |
| CouchDB 🛋️ | 3 | REST API | Document database, HTTP port 5984 |
| CockroachDB 🪳 | 25 | SQL | Distributed SQL, PostgreSQL-compatible |
| SurrealDB 🌀 | 2 | SurrealQL | Multi-model, HTTP port 8000 |
| QuestDB ⏱️ | 9 | SQL | Time-series, PG wire protocol port 8812 |

### Binary Sources

All engines download binaries from [hostdb](https://github.com/robertjbass/hostdb) except:
- **PostgreSQL on Windows**: Uses [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries) binaries. File IDs in `engines/postgresql/edb-binary-urls.ts`.
- **ClickHouse**: macOS/Linux only (no Windows support in hostdb)
- **FerretDB**: macOS/Linux only (postgresql-documentdb has Windows startup issues)

### FerretDB (Composite Engine)

FerretDB is a MongoDB-compatible proxy that requires **two binaries** from hostdb:

1. **ferretdb** - Stateless proxy (MongoDB wire protocol → PostgreSQL SQL)
2. **postgresql-documentdb** - PostgreSQL 17 with DocumentDB extension

**Architecture:**

```text
MongoDB Client (:27017) → FerretDB → PostgreSQL+DocumentDB (:54320+)
```

**Key constraints:**
- **FerretDB v2 only** - Requires DocumentDB extension (v1 not supported)
- **Two ports per container** - External (27017 for MongoDB) + internal (54320+ for PostgreSQL backend)
- **Three ports total** - MongoDB (27017), PostgreSQL backend (54320+), and debug HTTP handler (37017+)

**FerretDB-specific flags (in `engines/ferretdb/index.ts`):**
- `--no-auth` - Disables SCRAM authentication for local development (FerretDB 2.x enables auth by default)
- `--debug-addr=127.0.0.1:${port + 10000}` - Unique debug HTTP port per container (default 8088 causes conflicts)
- `--listen-addr=127.0.0.1:${port}` - MongoDB wire protocol port
- `--postgresql-url=postgres://postgres@127.0.0.1:${backendPort}/ferretdb` - Backend connection

**Known issues & gotchas:**
1. **Authentication**: FerretDB 2.x enables SCRAM authentication by default. The `--setup-username` and `--setup-password` flags do NOT exist despite documentation suggestions. Use `--no-auth` instead for local development.
2. **Debug port conflicts**: Running multiple FerretDB containers fails if all use default debug port 8088. Solution: `--debug-addr=127.0.0.1:${port + 10000}` (e.g., MongoDB port 27017 → debug port 37017).
3. **Backup/restore limitations**: pg_dump/pg_restore between FerretDB containers has issues because DocumentDB creates internal metadata tables (e.g., `job`) that conflict during restore. The restore may partially fail with "duplicate key value violates unique constraint" errors. **Workaround**: Use `custom` format with `--clean --if-exists`, but some data loss may occur. For production cloning, consider mongodump/mongorestore on the MongoDB protocol side.
4. **Connection strings**: No authentication needed with `--no-auth`: `mongodb://127.0.0.1:${port}/${db}`

**hostdb releases:**
- [postgresql-documentdb-17-0.107.0](https://github.com/robertjbass/hostdb/releases/tag/postgresql-documentdb-17-0.107.0) - linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64
- [ferretdb-2.7.0](https://github.com/robertjbass/hostdb/releases/tag/ferretdb-2.7.0) - All platforms including win32-x64

**Note on FerretDB platform support:** While the FerretDB proxy binary is available on all platforms, the full FerretDB stack requires both binaries (ferretdb + postgresql-documentdb). SpinDB automatically downloads both binaries for supported platforms. Check the postgresql-documentdb release for the actual platforms where FerretDB can run.

**postgresql-documentdb bundle contents:**
The hostdb binary is a complete PostgreSQL 17 installation with:
- PostgreSQL server and client tools (psql, pg_dump, pg_restore)
- DocumentDB extension (MongoDB-compatible storage for FerretDB v2)
- PostGIS extension (built from source, not Homebrew)
- pgvector extension
- All required dylibs bundled and path-rewritten for relocatability

**Why custom PostgreSQL build?** Homebrew PostgreSQL has hardcoded paths (`/opt/homebrew/lib/...`) that break on other machines. The hostdb build:
1. Builds PostgreSQL from source with relative paths
2. Builds PostGIS from source against that PostgreSQL
3. Bundles all Homebrew dependencies (OpenSSL, ICU, GEOS, PROJ, etc.)
4. Rewrites dylib paths to use `@loader_path` for macOS relocatability
5. Re-signs all binaries (macOS requires code signing after modification)

See [plans/FERRETDB.md](plans/FERRETDB.md) for implementation details.

**Platform Philosophy:** Originally, engines were only added if binaries were available for all OS/architectures. This changed when ClickHouse couldn't be built for Windows on hostdb. The new approach: engines can be added even with partial platform support. **Future direction:** hostdb and SpinDB will be combined to provide better UX - dynamically showing available engines based on the user's OS and architecture rather than requiring universal availability.

### Critical: Version Maps Sync

Each engine has a `version-maps.ts` that **MUST stay in sync** with [hostdb releases.json](https://github.com/robertjbass/hostdb/blob/main/releases.json):

```ts
// engines/{engine}/version-maps.ts
export const {ENGINE}_VERSION_MAP: Record<string, string> = {
  '17': '17.7.0',  // Must match releases.json exactly
  '18': '18.1.0',
}
```

If a version is in releases.json but not in version-maps.ts, SpinDB won't offer it. If a version is in version-maps.ts but not releases.json, downloads will fail.

### Critical: KNOWN_BINARY_TOOLS

When adding tools to an engine, they **MUST** be added to `KNOWN_BINARY_TOOLS` in `core/dependency-manager.ts`:

```ts
const KNOWN_BINARY_TOOLS: readonly BinaryTool[] = [
  'psql', 'pg_dump', 'clickhouse', 'duckdb', // etc.
]
```

Missing entries cause `findBinary()` to skip config lookup and fall back to PATH search, which silently fails if the tool isn't in PATH.

### Critical: ENGINE_PREFIXES

When adding a new engine, the prefix **MUST** be added to `ENGINE_PREFIXES` in `cli/helpers.ts`:

```ts
const ENGINE_PREFIXES = [
  'postgresql-',
  'mysql-',
  'meilisearch-',
  // ... add new engine prefix here
] as const
```

This array is used by `hasAnyInstalledEngines()` to detect whether any engine binaries have been downloaded. Missing entries cause the function to return `false` even when binaries exist, which affects UI decisions (e.g., showing "Manage engines" menu option).

### Type-Safe Engine Handling

```ts
// types/index.ts - ALL THREE must be updated together
export enum Engine { PostgreSQL = 'postgresql', MySQL = 'mysql', /* ... */ }
export const ALL_ENGINES = [Engine.PostgreSQL, Engine.MySQL, /* ... */] as const
// config/engines.json - runtime validation
```

Use `assertExhaustive(engine)` in switch statements for compile-time exhaustiveness checking.

### Backup & Restore Formats

Each engine has semantic format names defined in `config/backup-formats.ts`:

| Engine | Format 1 | Format 2 | Default |
|--------|----------|----------|---------|
| PostgreSQL | `sql` (.sql) | `custom` (.dump) | `sql` |
| MySQL | `sql` (.sql) | `compressed` (.sql.gz) | `sql` |
| MariaDB | `sql` (.sql) | `compressed` (.sql.gz) | `sql` |
| SQLite | `sql` (.sql) | `binary` (.sqlite) | `binary` |
| DuckDB | `sql` (.sql) | `binary` (.duckdb) | `binary` |
| MongoDB | `bson` (directory) | `archive` (.archive) | `archive` |
| FerretDB | `sql` (.sql) | `custom` (.dump) | `sql` |
| Redis | `text` (.redis) | `rdb` (.rdb) | `rdb` |
| Valkey | `text` (.valkey) | `rdb` (.rdb) | `rdb` |
| ClickHouse | `sql` (.sql) | _(none)_ | `sql` |
| Qdrant | `snapshot` (.snapshot) | _(none)_ | `snapshot` |
| Meilisearch | `snapshot` (.snapshot) | _(none)_ | `snapshot` |
| CouchDB | `json` (.json) | _(none)_ | `json` |

See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for complete documentation including Redis merge vs replace behavior.

### File Structure

```
~/.spindb/
├── bin/                    # Downloaded engine binaries
├── containers/             # Server-based engine data only
└── config.json             # Tool paths + SQLite/DuckDB registries
```

### Container Config

```ts
type ContainerConfig = {
  name: string
  engine: 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | 'duckdb' | 'mongodb' | 'ferretdb' | 'redis' | 'valkey' | 'clickhouse' | 'qdrant' | 'meilisearch' | 'couchdb'
  version: string
  port: number              // 0 for file-based engines
  database: string          // Primary database name
  databases?: string[]      // All databases (PostgreSQL, MySQL)
  created: string           // ISO timestamp
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string       // Source container if cloned
  backendVersion?: string   // FerretDB: PostgreSQL backend version
  backendPort?: number      // FerretDB: PostgreSQL backend port
}
```

## Core Principles

- **CLI-First**: All functionality via command-line arguments. Menus are syntactic sugar.
- **Wrapper Pattern**: Functions wrap CLI tools, don't implement database logic directly.
- **Transactional**: Multi-step operations use `TransactionManager` for rollback.

## Common Tasks

### Running the CLI

**IMPORTANT:** Use `pnpm start` during development, not `spindb` (global install).

```bash
pnpm start                    # Interactive menu
pnpm start create mydb        # Direct command
pnpm start create mydb --from postgres://...  # Infer engine from connection string
```

### Additional CLI Commands

```bash
spindb attach <path>          # Register existing SQLite/DuckDB file
spindb detach <name>          # Unregister from registry (keeps file)
spindb doctor                 # System health check
spindb url <container>        # Connection string (--copy, --json flags)
spindb config show            # Display configuration
spindb config detect          # Re-detect tool paths

# Database tracking (sync after external changes like SQL renames)
spindb databases list <container>              # List tracked databases
spindb databases add <container> <database>    # Add to tracking
spindb databases remove <container> <database> # Remove from tracking
spindb databases sync <container> <old> <new>  # Sync after rename
```

### Running Tests

```bash
pnpm test:unit              # Unit tests only
pnpm test:engine            # All integration tests
pnpm test:engine postgres   # PostgreSQL integration (aliases: pg, postgresql)
pnpm test:engine mysql      # MySQL integration
pnpm test:engine mongo      # MongoDB integration (aliases: mongodb)
pnpm test:engine meilisearch # Meilisearch integration (aliases: meili, ms)
pnpm test:docker            # Docker Linux E2E (all engines)
pnpm test:docker -- clickhouse  # Single engine
pnpm test:docker -- qdrant      # Qdrant (uses curl for REST API tests)
pnpm test:docker -- meilisearch # Meilisearch (uses curl for REST API tests)
```

**Docker E2E Notes:**
- REST API engines (Qdrant, Meilisearch, CouchDB) use `curl` instead of `spindb run` for connectivity/data tests
- Qdrant/Meilisearch/CouchDB backup/restore tests are skipped in Docker E2E (covered by integration tests)
- See `tests/docker/run-e2e.sh` for engine-specific handling

**Test Port Allocation**: Integration tests use reserved ports to avoid conflicts:
- PostgreSQL: 5454-5456 (not 5432)
- MySQL: 3333-3335 (not 3306)
- Redis: 6399-6401 (not 6379)

**Node 22 Worker Thread Bug**: Tests use `--experimental-test-isolation=none` due to macOS serialization bug. Don't remove this flag.

### Adding a New Engine

See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for complete guide. Quick checklist:
1. Create `engines/{engine}/` with index.ts, backup.ts, restore.ts, version-maps.ts
2. Add to `Engine` enum, `ALL_ENGINES`, and `config/engines.json`
3. Add tools to `KNOWN_BINARY_TOOLS` in dependency-manager.ts
4. Add engine prefix to `ENGINE_PREFIXES` in cli/helpers.ts
5. Add CI cache step in `.github/workflows/ci.yml`
6. **Create fixtures** in `tests/fixtures/{engine}/seeds/` (REQUIRED for all engines)
   - SQL engines: `sample-db.sql` with 5 test_user records
   - Key-value engines: `sample-db.{ext}` with 6 keys
   - REST API engines: `README.md` documenting the API-based approach
6. Add Docker E2E test support in `tests/docker/run-e2e.sh`

### Before Completing Any Task

Always run these verification steps before considering a task complete:

```bash
pnpm lint          # TypeScript compilation + ESLint
pnpm test:unit     # Unit tests (740+ tests)
```

If modifying a specific engine, also run its integration tests:
```bash
pnpm test:engine postgres    # PostgreSQL (aliases: pg, postgresql)
pnpm test:engine mysql       # MySQL
pnpm test:engine qdrant      # Qdrant (aliases: qd)
pnpm test:engine meilisearch # Meilisearch (aliases: meili, ms)
# Run `pnpm test:engine --help` for all options
```

### After Adding Any Feature

Update: CLAUDE.md, README.md, TODO.md, CHANGELOG.md, and add tests.

## Implementation Details

### Port Management
PostgreSQL: 5432 | MySQL: 3306 | MongoDB/FerretDB: 27017 | Redis/Valkey: 6379 | ClickHouse: 9000 | Qdrant: 6333 | Meilisearch: 7700 | CouchDB: 5984 | CockroachDB: 26257 | SurrealDB: 8000

Auto-increments on conflict (e.g., 5432 → 5433).

### Version Resolution
Major versions resolve to full versions via hostdb API or `version-maps.ts` fallback.

**ClickHouse Note**: Uses YY.MM versioning (e.g., `25.12.3.21`), not semver.

### Config Cache
Tool paths cached in `~/.spindb/config.json` with 7-day staleness.

### Orphaned Container Support
Deleted engines leave container data intact. Starting prompts to re-download.

## Error Handling

**Interactive**: Log error, "Press Enter to continue"
**CLI**: Log error, exit non-zero. Include actionable fix suggestions.

## UI Conventions

Menu navigation patterns:
- Submenus have "Back" and "Back to main menu" options
- Back button: `chalk.blue('←')` Back
- Main menu: `chalk.blue('⌂')` Back to main menu

## Known Limitations

1. **Local only** - Binds to 127.0.0.1 (remote planned for v1.1)
2. **ClickHouse Windows** - Not supported (no hostdb binaries, works in WSL)
3. **FerretDB Windows** - Not supported (postgresql-documentdb startup issues, works in WSL)
4. **Meilisearch Windows backup/restore** - Snapshot creation fails due to upstream Meilisearch bug (page size alignment)
5. **Qdrant, Meilisearch & CouchDB** - Use REST API instead of CLI shell; `spindb run` is not applicable

## Development Gotchas

**Spawning background server processes:**
When spawning a detached database server process, MUST use `stdio: ['ignore', 'ignore', 'ignore']`. Using `'pipe'` for stdout/stderr keeps file descriptors open that prevent Node.js from exiting, even after calling `proc.unref()`. This causes CLI commands like `spindb start` to hang indefinitely, especially visible in Docker/CI environments where output is captured. Symptoms: command completes successfully (server starts) but never returns to shell. See CockroachDB and SurrealDB engines for correct implementation.

**Shell Script / JRE Engines (QuestDB pattern):**
Engines that use shell scripts to launch Java (JRE) processes have special PID handling requirements:

1. **Shell script PID is useless**: When you spawn `questdb.sh start`, the shell script forks the Java process and exits immediately. The PID from `proc.pid` is the shell's PID, which becomes invalid within milliseconds.

2. **Engine may not create PID file**: Some Java-based databases don't create their own PID files when started via shell scripts in daemon mode. Don't assume a PID file exists at `{dataDir}/questdb.pid` or similar.

3. **Solution - Find PID by port**: After startup, wait for the server to be ready (health check), then find the actual process by port using `platformService.findProcessByPort(port)`. Write THAT PID to the PID file:
   ```typescript
   // After waitForReady() succeeds:
   const pids = await platformService.findProcessByPort(port)
   if (pids.length > 0) {
     await writeFile(pidFile, pids[0].toString(), 'utf-8')
   }
   ```

4. **Stop also uses port lookup**: The stop method should find the process by port first (most reliable), then fall back to PID file as secondary lookup.

5. **Multi-port configuration**: JRE engines often use multiple ports (main, HTTP, metrics, etc.). Each port must be uniquely configured via environment variables to avoid conflicts when running multiple containers. QuestDB uses 4 ports: PostgreSQL wire, HTTP Web Console, HTTP Min (metrics), and ILP (InfluxDB Line Protocol).

See `engines/questdb/index.ts` for the reference implementation.

**Commander.js async actions:**
Use `await program.parseAsync()` instead of `program.parse()` in the CLI entry point. `program.parse()` returns immediately without waiting for async command actions to complete, which can cause race conditions with exit codes.

**CI failures with no logs:**
If GitHub Actions jobs fail with generic "This job failed" messages and no detailed logs (especially Windows runners), check [GitHub Status](https://www.githubstatus.com/) for infrastructure issues. Common causes: runner quota exhausted, runner provisioning failures, or transient GitHub infrastructure problems. Try re-running failed jobs before investigating code issues.

## Publishing

npm via GitHub Actions with OIDC. Bump version in `package.json`, update CHANGELOG.md, merge to main.

## Code Style

ESM imports, `async/await`, Ora spinners, conventional commits (`feat:`, `fix:`, `chore:`).

### Logging

- **User-facing output**: Use Ora spinners and Chalk for CLI feedback
- **Internal warnings/debug**: Use `logDebug()` from `core/error-handler.ts`, never `console.warn` or `console.log`
- **Rationale**: `console.warn` pollutes stdout/stderr and breaks JSON output modes. `logDebug()` respects the `--debug` flag and writes to the debug log file only.

### JSON Output Mode (`--json` flag)

Commands supporting `--json` must output **pure JSON** with no extraneous text:

- **Guard all human-readable output** with `if (!options.json)` checks
- **Errors must output JSON**: `console.log(JSON.stringify({ error: "message" }))` then `process.exit(1)`
- **Skip interactive prompts** in JSON mode - either require arguments or error with JSON
- **Suppress spinners** in JSON mode or use `options.json ? null : createSpinner(...)`
- **No banners or notifications** before JSON output

Example error handling pattern:
```ts
if (!config) {
  if (options.json) {
    console.log(JSON.stringify({ error: `Container "${name}" not found` }))
  } else {
    console.error(uiError(`Container "${name}" not found`))
  }
  process.exit(1)
}
```
