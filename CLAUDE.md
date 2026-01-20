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

SpinDB is a CLI tool for running local databases without Docker. It's a lightweight alternative to DBngin and Postgres.app, downloading database binaries directly from [hostdb](https://github.com/robertjbass/hostdb). Supports PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, MongoDB, Redis, Valkey, and ClickHouse.

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

**Server-based engines** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse):
- Data in `~/.spindb/containers/{engine}/{name}/`
- Port management, start/stop lifecycle

**File-based engines** (SQLite, DuckDB):
- Data in user project directories (CWD), not `~/.spindb/`
- No server process - `start()`/`stop()` are no-ops
- Status determined by file existence, not process state
- Registry in `~/.spindb/config.json` tracks files by name
- Use `spindb attach <path>` / `spindb detach <name>` to manage registry

### Binary Manager Base Classes

When adding a new engine, choose the appropriate binary manager base class:

| Base Class | Location | Used By | Use Case |
|------------|----------|---------|----------|
| `BaseBinaryManager` | `core/base-binary-manager.ts` | Redis, Valkey | Key-value stores with `bin/` layout |
| `BaseServerBinaryManager` | `core/base-server-binary-manager.ts` | MySQL, MariaDB | SQL servers needing version verification |
| `BaseEmbeddedBinaryManager` | `core/base-embedded-binary-manager.ts` | SQLite, DuckDB | File-based DBs with flat archive layout |

**Decision tree:**
1. Is it a file-based/embedded database (no server process)? → `BaseEmbeddedBinaryManager`
2. Is it a SQL server needing `--version` verification? → `BaseServerBinaryManager`
3. Is it a key-value or document store? → `BaseBinaryManager`

**Note:** PostgreSQL, MongoDB, and ClickHouse have custom binary managers due to unique requirements (EDB binaries, mongosh, XML configs).

See [FEATURE.md](FEATURE.md) for detailed implementation guidance and code examples.

### Engine Aliases

Engines can be referenced by aliases in CLI commands:
- `postgresql`, `postgres`, `pg` → PostgreSQL
- `mongodb`, `mongo` → MongoDB
- `sqlite`, `lite` → SQLite

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

### Binary Sources

All engines download binaries from [hostdb](https://github.com/robertjbass/hostdb) except:
- **PostgreSQL on Windows**: Uses [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries) binaries. File IDs in `engines/postgresql/edb-binary-urls.ts`.
- **ClickHouse**: macOS/Linux only (no Windows support in hostdb)

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

### Type-Safe Engine Handling

```ts
// types/index.ts - ALL THREE must be updated together
export enum Engine { PostgreSQL = 'postgresql', MySQL = 'mysql', /* ... */ }
export const ALL_ENGINES = [Engine.PostgreSQL, Engine.MySQL, /* ... */] as const
// config/engines.json - runtime validation
```

Use `assertExhaustive(engine)` in switch statements for compile-time exhaustiveness checking.

### Backup & Restore Formats

Examples: PostgreSQL (`.sql`, `.dump`), Redis/Valkey (`.redis`/`.valkey`, `.rdb`), SQLite/DuckDB (`.sql`, binary copy)

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
  engine: 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | 'duckdb' | 'mongodb' | 'redis' | 'valkey' | 'clickhouse'
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
```

### Running Tests

```bash
pnpm test:unit      # Unit only
pnpm test:pg        # PostgreSQL integration
pnpm test:mysql     # MySQL integration
pnpm test:duckdb    # DuckDB integration
pnpm test:docker    # Docker Linux E2E (all engines)
pnpm test:docker -- clickhouse  # Single engine
```

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
4. Add CI cache step in `.github/workflows/ci.yml`

### After Adding Any Feature

Update: CLAUDE.md, README.md, TODO.md, CHANGELOG.md, and add tests.

## Implementation Details

### Port Management
PostgreSQL: 5432 | MySQL: 3306 | MongoDB: 27017 | Redis/Valkey: 6379 | ClickHouse: 9000

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
2. **ClickHouse Windows** - Not supported (no hostdb binaries)
3. **Redis/Valkey** - No `dumpFromConnectionString()` support
4. **Large backups** - Redis text restore reads entire file into memory

## Publishing

npm via GitHub Actions with OIDC. Bump version in `package.json`, update CHANGELOG.md, merge to main.

## Code Style

ESM imports, `async/await`, Ora spinners, conventional commits (`feat:`, `fix:`, `chore:`).

### Logging

- **User-facing output**: Use Ora spinners and Chalk for CLI feedback
- **Internal warnings/debug**: Use `logDebug()` from `core/error-handler.ts`, never `console.warn` or `console.log`
- **Rationale**: `console.warn` pollutes stdout/stderr and breaks JSON output modes. `logDebug()` respects the `--debug` flag and writes to the debug log file only.
