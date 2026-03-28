# CLAUDE.md - SpinDB Project Context

## Related Docs

- [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) — Authoritative guide for adding new engines
- [ARCHITECTURE.md](ARCHITECTURE.md) — Design, layers, data flow
- [STYLEGUIDE.md](STYLEGUIDE.md) — Coding conventions
- [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md) — Per-engine implementation details
- [docs/KEYBOARD_SHORTCUTS.md](docs/KEYBOARD_SHORTCUTS.md) — Custom keyboard shortcut guide
- Other: [TODO.md](TODO.md), [CHANGELOG.md](CHANGELOG.md), [TEST_COVERAGE.md](TEST_COVERAGE.md), [TESTING_STRATEGY.md](TESTING_STRATEGY.md)
- **Ecosystem docs:** `~/dev/layerbase-architecture/` — Shared architecture, infrastructure inventory, cross-project rules, and agent configs.
- **Ecosystem invariants:** `~/dev/layerbase-architecture/INVARIANTS.md` — Non-negotiable rules (scripting-first, thin desktop wrapper, platform-agnostic cloud, binary ownership). Read before making architectural changes.

## Ecosystem

SpinDB is the backbone of the Layerbase platform. **hostdb** builds database binaries and publishes them to `registry.layerbase.host` — spindb downloads them. **layerbase-cloud** (`~/dev/layerbase-cloud`) runs spindb inside Docker containers on Hetzner to provide managed databases with connection strings. **layerbase-desktop** (`~/dev/layerbase-desktop`) is an Electron GUI that calls spindb via IPC — it must never contain database logic that isn't in spindb. **layerbase** (`~/dev/layerbase`) is the Next.js web app at layerbase.com for billing, licensing, and the cloud dashboard. Changes to spindb's CLI output or flags are breaking changes for layerbase-desktop.

## Overview

SpinDB is a CLI tool for running local databases without Docker. Downloads pre-built binaries from the Layerbase registry (`registry.layerbase.host`), with GitHub ([hostdb](https://github.com/robertjbass/hostdb)) as a fallback (controlled by `ENABLE_GITHUB_FALLBACK` in `core/hostdb-client.ts`). 21 engines: PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB, Weaviate, TigerBeetle, LibSQL.

**Stack**: Node.js 18+, TypeScript, tsx (no build step), pnpm, Commander.js, Inquirer.js, Chalk, Ora, ESM

## Project Structure

```
cli/commands/menu/    # Interactive menu handlers
core/                 # Business logic (container-manager, process-manager, config-manager, credential-manager, dependency-manager, database-capabilities)
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
- **Server-based** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB, LibSQL): data in `~/.spindb/containers/{engine}/{name}/`, port management, start/stop lifecycle
- **File-based** (SQLite, DuckDB): data in CWD, no server process, `start()`/`stop()` are no-ops, tracked via registry in `~/.spindb/config.json`
- **Remote/linked** (`spindb link`): external databases linked via connection string, `status: 'linked'`, uses `remote` field in ContainerConfig, credentials stored via credential-manager with username `'remote'`. Supports `connect`, `url`, `info`, `list`, `delete`, `query`. Does NOT support `backup`, `run`, `restore`, `export`, `clone`, `start`, `stop`, `logs` (these block with clear error messages). See `core/remote-container.ts` for utilities. Query support loads credentials, parses the connection string, and passes `host`/`password`/`username`/`ssl` to engine `executeQuery` via `QueryOptions`.
- **REST API** (Qdrant, Meilisearch, CouchDB, InfluxDB, LibSQL): server-based but HTTP API only, `spindb run` N/A, `spindb connect` opens web dashboard (LibSQL shows curl examples)

Engines extend `BaseEngine`. Use `assertExhaustive(engine)` in switch statements.

**Bind address (`--bind` flag):** `spindb start --bind <address>` sets `bindAddress` in `ContainerConfig`, persisted to `config.json`. All server engines read `container.bindAddress ?? '127.0.0.1'` (QuestDB defaults to `0.0.0.0`). Config-file engines (Redis, Valkey, CouchDB, Qdrant) patch existing configs on restart rather than regenerating them, preserving user modifications like credentials and API keys. ClickHouse patches `<listen_host>` in config.xml. TypeDB regenerates config.yml on every start (passes bindAddress via initDataDir options).

**Authentication (`--auth` / `--no-auth` flags):** `spindb start --auth` sets `authEnabled: true` in `ContainerConfig`, persisted to `config.json`. `spindb start --no-auth` sets it to `false`. Only supported for MongoDB and FerretDB; warns and ignores for other engines. MongoDB: passes `--auth` to mongod when enabled. FerretDB v2: omits `--no-auth` flag when enabled (SCRAM authentication enforced). Default for both is auth disabled (backwards-compatible).

**LibSQL JWT authentication:** LibSQL uses Ed25519 JWT tokens for authentication (same pattern as Meilisearch API keys). `createUser()` generates an Ed25519 key pair, signs a JWT, writes the public key to the container directory (`jwt-key.pem`), restarts sqld with `--auth-jwt-key-file`, and stores the JWT via credential-manager. Not controlled by `--auth`/`--no-auth` flags.

**Deprecated version strategy:** Deprecated versions are hidden from discovery but fully supported at runtime. The principle: **don't advertise, but don't break.** Specifically:
- **Version picker** (`promptVersion()` in `cli/ui/prompts.ts`): Hides major versions where all versions are deprecated (per `databases.json`). `spindb create --show-deprecated` reveals them. Individual deprecated versions within non-deprecated majors show with `[deprecated]` tag.
- **Direct CLI usage** (`--db-version`): Bypasses the filter entirely — users can always create containers with deprecated versions.
- **Existing containers**: `spindb list`, `spindb start`, `spindb info`, etc. work normally regardless of deprecation status. No warnings, no filtering.
- **Installed binaries**: `spindb engines list` shows all installed binaries, deprecated or not.
- **Downloads**: `spindb engines download <engine> <version>` works for deprecated versions — no version picker involved.
- Deprecation data comes from hostdb's `databases.json` (`deprecated: true` on version entries). Fetched at runtime by `getDeprecatedVersions()` in `core/hostdb-metadata.ts`.

**Database capabilities** (`core/database-capabilities.ts`): Static capability map for all 21 engines. Controls which engines support `databases create`, `databases rename`, and `databases drop`. PostgreSQL, ClickHouse, CockroachDB, and Meilisearch have native rename; 10 other engines use backup/restore; 7 engines (SQLite, DuckDB, Redis, Valkey, QuestDB, TigerBeetle, LibSQL) are unsupported with clear error messages. When adding a new engine, update `getDatabaseCapabilities()`.

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

Exceptions: PostgreSQL/Windows uses EDB-sourced binaries uploaded to hostdb (same download path as other platforms). ClickHouse is macOS/Linux only. LibSQL is macOS/Linux only. FerretDB v2 is macOS/Linux only; v1 supports all platforms including Windows.

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

**SurrealDB auth nuance:** `surreal import` still needs root-level permissions. Namespace-scoped users can query and export, but the focused restore path only passed once the saved default credential file used root creds with `authLevel=root`. Keep that distinction in mind:
- server start: bootstrap with stable root creds
- client query/export/import: load `.env.spindb` and pass `--auth-level`
- restore/import: do not assume namespace/database users are allowed to import

**SurrealDB CLI JSON output is noisy:** `surreal sql --json` can emit prompt text before or after the JSON payload (for example `surrealdb_namespace/db>`). `parseSurrealDBResult()` now extracts the first complete JSON document instead of assuming stdout is pure JSON. If Surreal query parsing regresses, inspect raw stdout before blaming auth or query semantics.

**Redis `default` user vs `--user` flag:** Managed Redis/Valkey setups that use `requirepass` often expect the implicit default user and fail when `redis-cli --user default` is passed explicitly. The fix was to omit `--user` when the resolved username is literally `default`, while still passing `--user` for explicit ACL usernames. This logic must stay aligned in both Redis query paths:
- remote connection-string query path (`dumpFromConnectionString`)
- local/linked query execution path (`executeQuery`)

**When debugging Redis/Valkey query auth, test both paths:** a change can fix remote URL queries and still break local container queries, or vice versa. The cloud incident on March 26-27, 2026 only became clear after checking both the cloud-managed local container path and the remote URL path.

**Spawning background server processes:** MUST use `stdio: ['ignore', 'ignore', 'ignore']` for detached processes. Using `'pipe'` keeps file descriptors open, preventing Node.js exit even after `proc.unref()`. Causes `spindb start` to hang in Docker/CI. All 19 server engines now follow this rule (FerretDB was the last to be fixed in 0.43.0).

**LibSQL JWT auth via Ed25519:** LibSQL uses JWT tokens signed with Ed25519 keys for authentication. `createUser()` generates an Ed25519 key pair, signs a JWT with the private key, writes the public key to the container directory as `jwt-key.pem`, restarts sqld with `--auth-jwt-key-file`, and stores the JWT token via credential-manager. The same pattern as Meilisearch API keys — credential is a token, not a username/password pair.

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
- **Auth:** v1 has auth disabled by default (no `--no-auth` flag). v2 defaults to `--no-auth` (SCRAM disabled). `spindb start --auth` omits `--no-auth` to enable SCRAM; `spindb start --no-auth` restores the default. Persisted in `ContainerConfig.authEnabled`.
- **SSL:** v1 needs `?sslmode=disable` on PostgreSQL URL. v2 omits it.
- **DB creation:** v1 falls back to `postgres --single` if psql is unavailable. v2 uses psql.
- See `docs/ENGINE_NOTES.md` FerretDB section for the full list.

## Code Style

**Logging:** Use `logDebug()` from `core/error-handler.ts` for internal warnings/debug. Never `console.warn`/`console.log` — pollutes stdout and breaks `--json` mode.

**JSON output (`--json` flag):** Guard human-readable output with `if (!options.json)`. Errors output JSON then `process.exit(1)`. Skip spinners and prompts in JSON mode.

**Commits:** Conventional commits (`feat:`, `fix:`, `chore:`). Never mention AI tools as co-authors.

**Publishing:** npm via GitHub Actions OIDC. Bump version, update CHANGELOG.md, merge to main.
