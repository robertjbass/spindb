# CLAUDE.md - SpinDB Project Context

## Related Docs

- [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) — Authoritative guide for adding new engines
- [ARCHITECTURE.md](ARCHITECTURE.md) — Design, layers, data flow
- [STYLEGUIDE.md](STYLEGUIDE.md) — Coding conventions
- [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md) — Per-engine implementation details
- [docs/KEYBOARD_SHORTCUTS.md](docs/KEYBOARD_SHORTCUTS.md) — Custom keyboard shortcut guide
- Other: [TODO.md](TODO.md), [CHANGELOG.md](CHANGELOG.md), [TEST_COVERAGE.md](TEST_COVERAGE.md), [TESTING_STRATEGY.md](TESTING_STRATEGY.md)

## Overview

SpinDB is a CLI tool for running local databases without Docker. Downloads binaries from [hostdb](https://github.com/robertjbass/hostdb). 18 engines: PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB.

**Stack**: Node.js 18+, TypeScript, tsx (no build step), pnpm, Commander.js, Inquirer.js, Chalk, Ora, ESM

## Project Structure

```
cli/commands/menu/    # Interactive menu handlers
core/                 # Business logic (container-manager, process-manager, config-manager, credential-manager, dependency-manager)
config/               # engines.json (registry), engine-defaults.ts, backup-formats.ts
engines/{engine}/     # Each engine: index.ts, backup.ts, restore.ts, version-maps.ts, binary-manager.ts, etc.
engines/base-engine.ts
services/supabase/    # Supabase service layer (attaches to PostgreSQL containers)
types/index.ts        # Engine enum, ALL_ENGINES, BinaryTool type
tests/unit/           # Unit tests
tests/integration/    # Integration tests (reserved ports)
tests/fixtures/       # Test data and seed files
```

## Architecture

**Engine categories:**
- **Server-based** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB): data in `~/.spindb/containers/{engine}/{name}/`, port management, start/stop lifecycle
- **File-based** (SQLite, DuckDB): data in CWD, no server process, `start()`/`stop()` are no-ops, tracked via registry in `~/.spindb/config.json`
- **REST API** (Qdrant, Meilisearch, CouchDB, InfluxDB): server-based but HTTP API only, `spindb run` N/A, `spindb connect` opens web dashboard

Engines extend `BaseEngine`. Use `assertExhaustive(engine)` in switch statements.

**Supabase service layer** (not an engine): Optional enhancement for PostgreSQL containers. Adds GoTrue (auth), PostgREST (REST API), and an API proxy. Managed via `spindb supabase enable/disable/start/stop/status/info`. Config stored in `container.json` under `supabase` key. Services auto-start/stop with PostgreSQL. JWT secrets regenerated on clone.

### Critical: When Adding/Modifying Engines

1. **Version maps** (`engines/{engine}/version-maps.ts`) MUST match [hostdb releases.json](https://github.com/robertjbass/hostdb/blob/main/releases.json) exactly. Mismatch = broken downloads or missing versions.

2. **KNOWN_BINARY_TOOLS** in `core/dependency-manager.ts` — all engine tools MUST be listed here. Missing entries cause `findBinary()` to skip config lookup and silently fall back to PATH.

3. **ENGINE_PREFIXES** in `cli/helpers.ts` — new engine prefix MUST be added. Missing = `hasAnyInstalledEngines()` returns false even when binaries exist.

4. **Type enum** — `Engine` enum, `ALL_ENGINES` array (in `types/index.ts`), and `config/engines.json` MUST be updated together.

5. See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for the full 20+ file checklist.

### Binary Sources

All engines from hostdb except: PostgreSQL/Windows uses EDB binaries (`engines/postgresql/edb-binary-urls.ts`). ClickHouse is macOS/Linux only. FerretDB v2 is macOS/Linux only; v1 supports all platforms including Windows.

## Common Tasks

### Dev Commands

**IMPORTANT:** Use `pnpm start` during development, not `spindb`.

```bash
pnpm start                    # Interactive menu
pnpm start create mydb        # Direct command
```

### Tests

```bash
pnpm test:unit                # Unit tests (740+)
pnpm test:engine postgres     # Single engine integration (aliases: pg, postgresql)
pnpm test:engine              # All integration tests
pnpm test:docker              # Docker Linux E2E
```

Integration tests use reserved ports (not defaults): PostgreSQL 5454-5456, MySQL 3333-3335, Redis 6399-6401.

Tests use `--experimental-test-isolation=none` due to Node 22 macOS worker thread bug — don't remove.

### Before Completing Any Task

```bash
pnpm format        # Prettier
pnpm lint          # TypeScript + ESLint
pnpm test:unit     # Unit tests
```

If modifying an engine, also run `pnpm test:engine <engine>`.

### After Adding Any Feature

Update: CLAUDE.md, README.md, TODO.md, CHANGELOG.md, and add tests.

## Development Gotchas

**Spawning background server processes:** MUST use `stdio: ['ignore', 'ignore', 'ignore']` for detached processes. Using `'pipe'` keeps file descriptors open, preventing Node.js exit even after `proc.unref()`. Causes `spindb start` to hang in Docker/CI. See CockroachDB/SurrealDB engines.

**Shell script / JRE engines (QuestDB pattern):** Shell scripts that fork Java processes give useless PIDs. After health check, find real PID via `platformService.findProcessByPort(port)` and write to PID file. Stop also uses port lookup first, PID file as fallback. See `engines/questdb/index.ts`.

**Commander.js:** Use `await program.parseAsync()`, not `program.parse()` — the latter returns immediately without waiting for async actions.

## Code Style

**Logging:** Use `logDebug()` from `core/error-handler.ts` for internal warnings/debug. Never `console.warn`/`console.log` — pollutes stdout and breaks `--json` mode.

**JSON output (`--json` flag):** Guard human-readable output with `if (!options.json)`. Errors output JSON then `process.exit(1)`. Skip spinners and prompts in JSON mode.

**Commits:** Conventional commits (`feat:`, `fix:`, `chore:`). Never mention AI tools as co-authors.

**Publishing:** npm via GitHub Actions OIDC. Bump version, update CHANGELOG.md, merge to main.
