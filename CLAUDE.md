# CLAUDE.md - Project Context for Claude Code

## Related Documentation

| File | Purpose |
|------|---------|
| [STYLEGUIDE.md](STYLEGUIDE.md) | Coding conventions and style guidelines |
| [FEATURE.md](FEATURE.md) | **Authoritative guide** for adding new database engines |
| [ARCHITECTURE.md](ARCHITECTURE.md) | High-level design, layers, data flow |
| [MIGRATION.md](MIGRATION.md) | Historical guide for migrating engines to hostdb |
| [ENGINES.md](ENGINES.md) | Supported engines overview |
| [TODO.md](TODO.md) | Roadmap and backlog |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Project Overview

SpinDB is a CLI tool for running local databases without Docker. It's a lightweight alternative to DBngin and Postgres.app, downloading database binaries directly from [hostdb](https://github.com/robertjbass/hostdb). Supports PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, MongoDB, Redis, Valkey, ClickHouse, Qdrant, and Meilisearch.

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

Engines extend `BaseEngine` abstract class. See [FEATURE.md](FEATURE.md) for full method list.

**Server-based engines** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch):
- Data in `~/.spindb/containers/{engine}/{name}/`
- Port management, start/stop lifecycle

**File-based engines** (SQLite, DuckDB):
- Data in user project directories (CWD), not `~/.spindb/`
- No server process - `start()`/`stop()` are no-ops
- Status determined by file existence, not process state
- Registry in `~/.spindb/config.json` tracks files by name
- Use `spindb attach <path>` / `spindb detach <name>` to manage registry

**REST API engines** (Qdrant, Meilisearch):
- Server-based but interact via HTTP REST API instead of CLI tools
- `spindb run` is not applicable (no CLI shell)
- `spindb connect` opens the web dashboard in browser
- Backup/restore uses snapshot endpoints via REST API
- Docker E2E tests use `curl` for connectivity and data operations

**Engines with built-in web UIs**:
- **Qdrant**: Dashboard at `http://localhost:{port}/dashboard`
- **Meilisearch**: Dashboard at `http://localhost:{port}/`
- **ClickHouse**: Play UI at `http://localhost:8123/play`

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

### Binary Manager Base Classes

When adding a new engine, choose the appropriate binary manager base class:

| Base Class | Location | Used By | Use Case |
|------------|----------|---------|----------|
| `BaseBinaryManager` | `core/base-binary-manager.ts` | Redis, Valkey, Qdrant, Meilisearch | Key-value/vector/search stores with `bin/` layout |
| `BaseServerBinaryManager` | `core/base-server-binary-manager.ts` | PostgreSQL, MySQL, MariaDB, ClickHouse | SQL servers needing version verification |
| `BaseDocumentBinaryManager` | `core/base-document-binary-manager.ts` | MongoDB, FerretDB | Document DBs with macOS tar recovery |
| `BaseEmbeddedBinaryManager` | `core/base-embedded-binary-manager.ts` | SQLite, DuckDB | File-based DBs with flat archive layout |

**Decision tree:**
1. Is it a file-based/embedded database (no server process)? → `BaseEmbeddedBinaryManager`
2. Is it a SQL server needing `--version` verification? → `BaseServerBinaryManager`
3. Is it a document-oriented database? → `BaseDocumentBinaryManager`
4. Is it a key-value store or vector database? → `BaseBinaryManager`

**Note:** PostgreSQL uses `BaseServerBinaryManager` with a custom `verify()` override for its version output format. EDB binaries for Windows are uploaded to hostdb, so all platforms use the same download path.

See [FEATURE.md](FEATURE.md) for detailed implementation guidance and code examples.

### Engine Aliases

Engines can be referenced by aliases in CLI commands:
- `postgresql`, `postgres`, `pg` → PostgreSQL
- `mongodb`, `mongo` → MongoDB
- `sqlite`, `lite` → SQLite
- `qdrant`, `qd` → Qdrant
- `meilisearch`, `meili`, `ms` → Meilisearch

### Supported Versions & Query Languages

| Engine | Versions | Query Language | Notes |
|--------|----------|----------------|-------|
| PostgreSQL 🐘 | 14, 15, 16, 17, 18 | SQL | |
| MySQL 🐬 | 8.0, 8.4, 9 | SQL | |
| MariaDB 🦭 | 10.11, 11.4, 11.8 | SQL | |
| MongoDB 🍃 | 7.0, 8.0, 8.2 | JavaScript | Uses mongosh |
| Redis 🔴 | 7, 8 | Redis commands | Databases 0-15 (numbered) |
| Valkey 🔷 | 8, 9 | Redis commands | Uses `redis://` scheme for compatibility |
| ClickHouse 🏠 | 25.12 | SQL | XML configs, HTTP port 8123 |
| SQLite 🗄️ | 3 | SQL | File-based |
| DuckDB 🦆 | 1.4.3 | SQL | File-based, OLAP |
| Qdrant 🧭 | 1 | REST API | Vector search, HTTP port 6333 |
| Meilisearch 🔍 | 1.33.1 | REST API | Full-text search, HTTP port 7700 |

### Binary Sources

All engines download binaries from [hostdb](https://github.com/robertjbass/hostdb) except:
- **PostgreSQL on Windows**: Uses [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries) binaries. File IDs in `engines/postgresql/edb-binary-urls.ts`.
- **ClickHouse**: macOS/Linux only (no Windows support in hostdb)

### FerretDB (Composite Engine)

FerretDB is a MongoDB-compatible proxy that requires **two binaries** from hostdb:

1. **ferretdb** - Stateless proxy (MongoDB wire protocol → PostgreSQL SQL)
2. **postgresql-documentdb** - PostgreSQL 17 with DocumentDB extension

**Architecture:**
```
MongoDB Client (:27017) → FerretDB → PostgreSQL+DocumentDB (:54320+)
```

**Key constraints:**
- **FerretDB v2 only** - Requires DocumentDB extension (v1 not supported)
- **No Windows** - postgresql-documentdb can't be built for Windows (PostGIS/rum blockers)
- **Two ports per container** - External (27017 for MongoDB) + internal (54320+ for PostgreSQL backend)

**hostdb releases:**
- [postgresql-documentdb-17-0.107.0](https://github.com/robertjbass/hostdb/releases/tag/postgresql-documentdb-17-0.107.0) - linux-x64, linux-arm64, darwin-x64, darwin-arm64
- [ferretdb-2.7.0](https://github.com/robertjbass/hostdb/releases/tag/ferretdb-2.7.0) - All platforms including win32-x64

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
| Redis | `text` (.redis) | `rdb` (.rdb) | `rdb` |
| Valkey | `text` (.valkey) | `rdb` (.rdb) | `rdb` |
| ClickHouse | `sql` (.sql) | _(none)_ | `sql` |
| Qdrant | `snapshot` (.snapshot) | _(none)_ | `snapshot` |
| Meilisearch | `snapshot` (.snapshot) | _(none)_ | `snapshot` |

See [FEATURE.md](FEATURE.md) for complete documentation including Redis merge vs replace behavior.

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
  engine: 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | 'duckdb' | 'mongodb' | 'redis' | 'valkey' | 'clickhouse' | 'qdrant' | 'meilisearch'
  version: string
  port: number              // 0 for file-based engines
  database: string          // Primary database name
  databases?: string[]      // All databases (PostgreSQL, MySQL)
  created: string           // ISO timestamp
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string       // Source container if cloned
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
- REST API engines (Qdrant, Meilisearch) use `curl` instead of `spindb run` for connectivity/data tests
- Qdrant/Meilisearch backup/restore tests are skipped in Docker E2E (covered by integration tests)
- See `tests/docker/run-e2e.sh` for engine-specific handling

**Test Port Allocation**: Integration tests use reserved ports to avoid conflicts:
- PostgreSQL: 5454-5456 (not 5432)
- MySQL: 3333-3335 (not 3306)
- Redis: 6399-6401 (not 6379)

**Node 22 Worker Thread Bug**: Tests use `--experimental-test-isolation=none` due to macOS serialization bug. Don't remove this flag.

### Adding a New Engine

See [FEATURE.md](FEATURE.md) for complete guide. Quick checklist:
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
PostgreSQL: 5432 | MySQL: 3306 | MongoDB: 27017 | Redis/Valkey: 6379 | ClickHouse: 9000 | Qdrant: 6333 | Meilisearch: 7700

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
3. **Meilisearch Windows backup/restore** - Snapshot creation fails due to upstream Meilisearch bug (page size alignment)
4. **Qdrant & Meilisearch** - Use REST API instead of CLI shell; `spindb run` is not applicable

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
