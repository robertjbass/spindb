# CLAUDE.md - SpinDB Project Context

## Related Docs

- [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) — Authoritative guide for adding new engines
- [ARCHITECTURE.md](ARCHITECTURE.md) — Design, layers, data flow
- [STYLEGUIDE.md](STYLEGUIDE.md) — Coding conventions
- [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md) — Per-engine implementation details
- [docs/KEYBOARD_SHORTCUTS.md](docs/KEYBOARD_SHORTCUTS.md) — Custom keyboard shortcut guide
- Other: [TODO.md](TODO.md), [CHANGELOG.md](CHANGELOG.md), [TEST_COVERAGE.md](TEST_COVERAGE.md), [TESTING_STRATEGY.md](TESTING_STRATEGY.md)

## Overview

SpinDB is a CLI tool for running local databases without Docker. Downloads pre-built binaries from the Layerbase registry (`registry.layerbase.host`), with GitHub ([hostdb](https://github.com/robertjbass/hostdb)) as a fallback (controlled by `ENABLE_GITHUB_FALLBACK` in `core/hostdb-client.ts`). 19 engines: PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB, Weaviate.

**Stack**: Node.js 18+, TypeScript, tsx (no build step), pnpm, Commander.js, Inquirer.js, Chalk, Ora, ESM

## Project Structure

```
cli/commands/menu/    # Interactive menu handlers
core/                 # Business logic (container-manager, process-manager, config-manager, credential-manager, dependency-manager)
config/               # engines.json (registry), engine-defaults.ts, backup-formats.ts
engines/{engine}/     # Each engine: index.ts, backup.ts, restore.ts, version-maps.ts, binary-manager.ts, etc.
engines/base-engine.ts
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

### Critical: When Adding/Modifying Engines

1. **Version maps** (`engines/{engine}/version-maps.ts`) MUST match [hostdb databases.json](https://github.com/robertjbass/hostdb/blob/main/databases.json) exactly. Mismatch = broken downloads or missing versions.

2. **KNOWN_BINARY_TOOLS** in `core/dependency-manager.ts` — all engine tools MUST be listed here. Missing entries cause `findBinary()` to skip config lookup and silently fall back to PATH.

3. **ENGINE_PREFIXES** in `cli/helpers.ts` — new engine prefix MUST be added. Missing = `hasAnyInstalledEngines()` returns false even when binaries exist.

4. **Type enum** — `Engine` enum, `ALL_ENGINES` array (in `types/index.ts`), and `config/engines.json` MUST be updated together.

5. See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for the full 20+ file checklist.

### Version Lookups (hostdb-releases factory pattern)

All engines use the factory in `core/hostdb-releases-factory.ts` (`createHostdbReleases()`) for version lookups. Each engine's `hostdb-releases.ts` is a ~25-line file that passes engine-specific config to the factory. See `engines/redis/hostdb-releases.ts` as the canonical template.

The factory reads `databases.json` (via `core/hostdb-metadata.ts`) as the authoritative version source, with a three-tier fallback: **databases.json → locally installed binaries → hardcoded version map**. Do NOT write custom fetch/cache/fallback logic in engine files — use the factory.

**hostdb data files** (fetched from `registry.layerbase.host`, fallback to GitHub raw):
- `databases.json` — version listings, platform support, CLI tools per engine (used by factory for version lookups)
- `downloads.json` — package manager install commands for tools
- `releases.json` — legacy flat version list (still used by `tests/integration/hostdb-sync.test.ts` for validation, and by binary download URL resolution in `core/hostdb-client.ts`)

### Binary Sources

Primary: Layerbase registry (`registry.layerbase.host`). Fallback: GitHub hostdb releases (toggled by `ENABLE_GITHUB_FALLBACK` in `core/hostdb-client.ts`). All download/fetch logic is centralized in `core/hostdb-client.ts` (`fetchWithRegistryFallback()`, `fetchHostdbReleases()`, `getReleasesUrls()`).

Exceptions: PostgreSQL/Windows uses EDB-sourced binaries uploaded to hostdb (same download path as other platforms). ClickHouse is macOS/Linux only. FerretDB v2 is macOS/Linux only; v1 supports all platforms including Windows.

### hostdb Engine Names vs SpinDB Engines

Most SpinDB engines map 1:1 to hostdb engine names. FerretDB v1 and v2 both use the single `ferretdb` hostdb engine name. The `tests/integration/hostdb-sync.test.ts` test verifies the combined `FERRETDB_VERSION_MAP` against the `ferretdb` entry in hostdb releases.json.

## Common Tasks

### Dev Commands

**IMPORTANT:** Use `pnpm start` during development, not `spindb`.

```bash
pnpm start                    # Interactive menu
pnpm start create mydb        # Direct command
```

### Tests

```bash
pnpm test:unit                # Unit tests (1200+)
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

**Binary `--version` verification:** `BaseBinaryManager.verify()` runs `binary --version` after download. Some engines don't support this flag — CouchDB (Erlang app, tries to start) and Weaviate (some releases lack `--version` support). These engines override `verify()` in their `binary-manager.ts` to just check binary existence instead. See `engines/couchdb/binary-manager.ts` and `engines/weaviate/binary-manager.ts`. Consult hostdb's `databases.json` for currently supported Weaviate versions rather than embedding specific version numbers.

**Weaviate internal cluster ports:** Weaviate binds 4 internal ports (gossip 7946, data 7947, raft 8300, raft RPC 8301) that MUST be unique per container. SpinDB derives them from the HTTP port: gossip=port+100, data=port+101, raft=port+200, raft_rpc=port+201. Also sets `CLUSTER_HOSTNAME=node-{port}`. Without unique ports, multiple containers silently conflict or fail to start.

**Weaviate backup/restore:** Requires `ENABLE_MODULES=backup-filesystem` env var. Backups are directories (not single files). The directory name MUST match the internal backup ID in `backup_config.json` — `restore.ts` reads this file to use the correct name. When restoring to a container with a different `CLUSTER_HOSTNAME`, the restore API requires a `node_mapping` body parameter. See `engines/weaviate/README.md`.

**Dynamic library errors (MariaDB, Redis, Valkey):** hostdb binaries for these engines are dynamically linked against Homebrew's OpenSSL (`/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib`). On Macs without `brew install openssl@3`, they fail with `dyld: Library not loaded` errors. `core/library-env.ts` provides two utilities: `getLibraryEnv(binPath)` returns `DYLD_FALLBACK_LIBRARY_PATH` (macOS) or `LD_LIBRARY_PATH` (Linux) pointing to `{binPath}/lib` — spread into spawn env options. `detectLibraryError(output, engineName)` scans stderr/logs for dyld, GLIBC, and shared-library patterns, returning an actionable error message or null. When adding new engines with dynamically-linked binaries, use these utilities in `start()` and `initDataDir()` spawn calls. See `engines/redis/index.ts` for the canonical integration pattern.

**Commander.js:** Use `await program.parseAsync()`, not `program.parse()` — the latter returns immediately without waiting for async actions.

**FerretDB v1 vs v2:** FerretDB is a single engine (`Engine.FerretDB`) with version-branched behavior via `isV1(version)` in `engines/ferretdb/version-maps.ts`. Key differences:
- **Backend:** v1 uses plain PostgreSQL (shared with standalone PG containers). v2 uses postgresql-documentdb (separate binary).
- **Platforms:** v1 supports all 5 platforms including Windows. v2 is macOS/Linux only.
- **Cascade delete:** v1 does NOT delete shared PostgreSQL binaries on engine delete. v2 cleans up postgresql-documentdb.
- **Auth:** v1 has auth disabled by default (no `--no-auth` flag). v2 requires `--no-auth`.
- **SSL:** v1 needs `?sslmode=disable` on PostgreSQL URL. v2 omits it.
- **DB creation:** v1 falls back to `postgres --single` if psql is unavailable. v2 uses psql.
- See `docs/ENGINE_NOTES.md` FerretDB section for the full list.

## Code Style

**Logging:** Use `logDebug()` from `core/error-handler.ts` for internal warnings/debug. Never `console.warn`/`console.log` — pollutes stdout and breaks `--json` mode.

**JSON output (`--json` flag):** Guard human-readable output with `if (!options.json)`. Errors output JSON then `process.exit(1)`. Skip spinners and prompts in JSON mode.

**Commits:** Conventional commits (`feat:`, `fix:`, `chore:`). Never mention AI tools as co-authors.

**Publishing:** npm via GitHub Actions OIDC. Bump version, update CHANGELOG.md, merge to main.
