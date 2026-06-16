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
- **Remote/linked** (`spindb link`): linked databases use `status: 'linked'` plus the `remote` field in `ContainerConfig`. `remote.origin` is now first-class: `'external'` for third-party/manual remotes and `'layerbase-cloud'` for Layerbase-managed cloud links. `provider` remains display metadata, and `providerId` is the stable provider-side identifier when available. Credentials are stored via credential-manager with username `'remote'`. Supports `connect`, `url`, `info`, `list`, `delete`, `query`. Does NOT support `backup`, `run`, `restore`, `export`, `clone`, `start`, `stop`, `logs` (these block with clear error messages). See `core/remote-container.ts` for utilities. Query support loads credentials, parses the connection string, and passes `host`/`password`/`username`/`ssl` to engine `executeQuery` via `QueryOptions`.
- **REST API** (Qdrant, Meilisearch, CouchDB, InfluxDB, LibSQL): server-based but HTTP API only, `spindb run` N/A, `spindb connect` opens web dashboard (LibSQL shows curl examples)

Engines extend `BaseEngine`. Use `assertExhaustive(engine)` in switch statements.

**`spindb deploy` (antiquated):** The `deploy` command exists but is not used by layerbase-cloud or layerbase-desktop. Cloud deployments are handled by layerbase-cloud's own infrastructure (Docker containers running spindb on Hetzner), not by `spindb deploy`. The command may be worth re-evaluating for users who want to deploy local databases to external (non-Layerbase) cloud services, but it is not part of any current workflow.

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

**Database branching (`spindb branch`):** Neon/Vercel-style copy-on-write forks, local, for every engine. A branch duplicates a container's data dir via a filesystem reflink/clonefile (`core/cow-copy.ts`: `cp -cR` on macOS/APFS, `cp -R --reflink=always` on Linux Btrfs/XFS-reflink/ZFS, full `fs.cp` fallback on ext4/NTFS). `core/branch-manager.ts` orchestrates the lifecycle: a running source is auto stop→snapshot→restart'ed for a consistent copy; file-based engines (SQLite/DuckDB) clone the backing file and register a new entry. Lineage lives on `ContainerConfig.branchParent`/`branchedAt` (and `SQLite/DuckDBRegistryEntry` for file-based). `clone` and `branch` share `containerManager.copyContainerData({ strategy: 'copy' | 'cow', lineage, port? })`; the per-engine `prepareBranchedDataDir()` hook (in `base-engine.ts`) fixes identity baked into a copied data dir (ClickHouse regenerates `config.xml`; FerretDB clears the inherited `backendPort` so start() reallocates a free one; Weaviate self-heals RAFT on start; others no-op). The `--json` output mirrors `clone`/`create` (`{ success, source, name, port, method, branchParent, connectionString, started, warning? }`) so layerbase-desktop/cloud parse it the same way. **Git-driven branching** (`core/git-branch-sync.ts`): `spindb branch init --base <c>` writes `.spindb/branch.json` (`baseContainer`/`engine`/`stablePort`/`mainBranch`) + installs a chain-safe `post-checkout` hook; switching git branches runs `branch sync`, which swaps the matching DB branch onto the **stable port** (one live at a time; git→container mapping is deterministic — `main`→base, else `<base>__<sanitized>`). Subcommands: `init`/`sync`/`status`/`prune`/`hooks install|uninstall`. Server engines only. **Not yet:** time-travel/PITR, merge. Linked/remote containers cannot be branched. Interactive menu: a top-level **Branches** tree view (drill into any node to manage it), branch-aware **Delete** (cascade prompt), and a **Git branching** view (status/sync/prune/hooks) shown when the repo is configured; the tree renderer is shared via `cli/ui/branch-tree.ts`. Downstream integration playbook for desktop/cloud: [docs/BRANCHING-INTEGRATION.md](docs/BRANCHING-INTEGRATION.md). See [docs/BRANCHING.md](docs/BRANCHING.md).

### Critical: When Adding/Modifying Engines

1. **Version maps** (`engines/{engine}/version-maps.ts`) are **thin wrappers** over the `hostdb` npm package — they import `resolveVersion`, `getSupportedMajorVersions`, `listVersions` from hostdb and rebuild the legacy `<ENGINE>_VERSION_MAP` + `SUPPORTED_MAJOR_VERSIONS` exports at module-load time. To bump a version, bump `hostdb` in `package.json`. Do NOT edit MAP entries by hand. See `engines/sqlite/version-maps.ts` as the simplest template, `engines/ferretdb/version-maps.ts` for the most complex (dual-engine: `ferretdb` + `postgresql-documentdb`).

2. **KNOWN_BINARY_TOOLS** in `core/dependency-manager.ts` — all engine tools MUST be listed here. Missing entries cause `findBinary()` to skip config lookup and silently fall back to PATH.

3. **ENGINE_PREFIXES** in `cli/helpers.ts` — new engine prefix MUST be added. Missing = `hasAnyInstalledEngines()` returns false even when binaries exist.

4. **Type enum** — `Engine` enum, `ALL_ENGINES` array (in `types/index.ts`), and `config/engines.json` MUST be updated together.

5. See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for the full 20+ file checklist.

### Version Lookups (hostdb-releases factory pattern)

All engines use the factory in `core/hostdb-releases-factory.ts` (`createHostdbReleases()`) for version lookups. Each engine's `hostdb-releases.ts` is a ~25-line file that passes engine-specific config to the factory. See `engines/redis/hostdb-releases.ts` as the canonical template.

The factory reads `databases.json` (via `core/hostdb-metadata.ts`) as the authoritative version source, with a three-tier fallback: **databases.json → locally installed binaries → hardcoded version map**. Do NOT write custom fetch/cache/fallback logic in engine files — use the factory.

**hostdb data files** are bundled inside the `hostdb` npm package. `core/hostdb-metadata.ts` reads them via `hostdb`'s `loadDatabasesJson()` / `loadDownloadsJson()` — no network call at runtime. The 5-minute cache + `registry.layerbase.host` / GitHub Raw fallback only kicks in if the bundled load throws (corrupt install, etc.). What's bundled:
- `databases.json` — version listings, platform support, CLI tools per engine (used by factory for version lookups, defaults block, deprecation flags)
- `downloads.json` — package manager install commands for tools
- `releases.json` — flat version list with R2 URLs + sha256s (used by `getReleaseInfo()` in hostdb's resolver, by `core/hostdb-client.ts` for binary downloads, and by `tests/integration/hostdb-sync.test.ts` as the bundled-vs-live drift check)

### hostdb npm Package & Pinning Strategy

`hostdb` is the single source of truth for which versions exist, how to resolve shorthand inputs (`'17'` → `'17.10.0'`), and where to download binaries. Spindb's `package.json` should pin **exactly** — not `^` or `~` — because:

- A patch-level hostdb release can add NEW VERSIONS (e.g., `hostdb@0.31.1` adds PostgreSQL 17.11.0). With `^0.31.0`, an end-user `pnpm install spindb@0.49.0` could pick up `hostdb@0.31.5` with versions spindb's tests never validated against.
- The `tests/integration/hostdb-sync.test.ts` drift check passes against a specific hostdb snapshot. Allowing the snapshot to change under your feet defeats the test.
- Spindb's `cli/ui/prompts.ts` displays version lists derived from hostdb. Users expect the same spindb version to show the same options.

**Correct pin format:** `"hostdb": "0.31.0"` (no caret, no tilde). Bumping hostdb is an explicit spindb release.

**Bump-hostdb workflow:**
1. New hostdb published to npm (registry shows new version).
2. Update `spindb/package.json`: change `hostdb` to exact new version.
3. `pnpm install` regenerates lockfile.
4. `pnpm test:hostdb-sync` confirms bundled snapshot matches live registry.
5. `pnpm test:unit` passes (version maps auto-rebuild from new snapshot).
6. Commit: `chore(deps): bump hostdb 0.31.0 → 0.32.0` describing new versions / deprecations.
7. Standard feature → dev → main PR flow.

### Container version pinning (eager resolution + auto-migrate)

Two layered guarantees prevent silent version drift on the user's data:

1. **At create time** (`cli/commands/create.ts`): the major/major-minor shorthand the user passes (`spindb create postgresql 18`) is resolved to a full version through `dbEngine.resolveFullVersion()` BEFORE `containerManager.create()` writes container.json. New containers always persist `version: '18.4.0'`, never `'18'`.

2. **At start time** (`cli/commands/start.ts`): if a container.json still has shorthand (legacy from an older spindb), `isShorthandVersion()` from `core/version-utils.ts` detects it. Spindb resolves through hostdb, writes the full version back to disk, prints a one-line `uiInfo` that the container is now pinned to `<full>`. From that point on the container is drift-immune. Skipped for file-based engines (SQLite/DuckDB don't pin per data file) and remote/`'unknown'` containers.

Together these mean: new containers are immune from day one; legacy containers self-heal on their next start.

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

Integration tests use reserved ports (not defaults): PostgreSQL 5454-5456, MySQL 3333-3337 (main suite 3333-3335, auth backup/restore 3336-3337), Redis 6399-6401. `tests/integration/helpers.ts` is the source of truth for the reserved ranges.

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

**Never use pnpm to install global packages in a Dockerfile.** pnpm 10+ refuses `pnpm add -g` until `pnpm setup` has written `PNPM_HOME` into a shell profile, but Dockerfile `RUN` doesn't source profiles mid-step — so adding `pnpm setup && pnpm add -g X` in the same `RUN` doesn't actually fix anything. pnpm 11.x also has `@pnpm/exe` install bugs in clean containers. For a single global package, **always use `npm install -g X` in Dockerfiles**. This applies to `core/docker-exporter.ts` (the exported user container) and any future Docker work. The full context lives in `tests/docker/Dockerfile` — that one's safe because it pins pnpm 9 via `corepack` and uses `pnpm link --global`, not `add -g`. End-user behavior (`spindb update`) handles this by falling back to npm when pnpm errors with "global bin directory not in PATH" (see `core/update-manager.ts`).


**PostgreSQL client tools are bundled-only:** `pg_dump`, `pg_restore`, `psql`, and `pg_basebackup` for a specific major version MUST be resolved through `core/pg-binary-resolver.ts` (`getBundledBinaryPath`, `findCompatibleVersion`) which only looks under `~/.spindb/bin/postgresql-<version>-<platform>-<arch>/bin/`. Never probe Homebrew (`/opt/homebrew/opt/postgresql@X`), APT (`/usr/lib/postgresql/X`), or any other system package manager. If a bundled binary is missing, surface `spindb engines download postgresql <major>` — do not tell users to `brew install postgresql@X`. This was historically violated in `core/homebrew-version-manager.ts` (removed); the version-mismatch path during `spindb pull` was silently requiring Homebrew's `postgresql@18` even when spindb's own pg 18 was already on disk. The regression test in `tests/unit/pg-binary-resolver.test.ts` enforces this.

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

**Restore has two modes (the destructive default vs `--into-existing`):** the default `spindb restore` DROPS + recreates the target database (the drop lives in `cli/commands/restore.ts`, NOT the per-engine `restore()`, which is mostly additive). `--into-existing` restores INTO the existing database without dropping it - it skips the CLI drop, the recreate, AND the drop-on-failure rollback (a failed in-place restore must never drop the caller's data), and passes object-level clean so the result REPLACES the backed-up objects. Two semantics to keep in mind: (1) it is "overlay the backup," not "reset to exactly the backup" - objects created AFTER the backup (a table/collection not in it) survive; (2) it is gated to an `INTO_EXISTING_ENGINES` allowlist (wire engines only: pg/mysql/mariadb/mongo/ferret/cockroach/clickhouse/questdb) so an engine whose restore can't replace-in-place errors instead of silently merging. Add an engine to the allowlist ONLY with clean-restore support + a real-engine integration round-trip test. **Mongo/Ferret backups are interchangeable** (both produce `mongodump` archives; either restores into the other) - guarded by `tests/integration/mongo-ferret-interop.test.ts`. The uncompressed mongodump archive magic is `6d e2 99 81` (= `0x8199e26d`); restore must NOT add `--gzip` for it (the `unknown`-format fallback no longer does - it once caused `gzip: invalid header` on every `archive-plain` restore).

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

**Qdrant snapshot restore on Windows is not stable yet:** Qdrant 1.16.x full snapshot restore via startup-time recovery still panics on Win x64 with `Too many parts in snapshot mapping`. Keep Windows coverage for create/start/query, but treat clone/auth-backed snapshot restore as a known gap until the restore path is reworked or upstream behavior changes.

**Dynamic library errors (MariaDB, Redis, Valkey):** hostdb binaries for these engines are dynamically linked against Homebrew's OpenSSL (`/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib`). On Macs without `brew install openssl@3`, they fail with `dyld: Library not loaded` errors. `core/library-env.ts` provides two utilities: `getLibraryEnv(binPath)` returns `DYLD_FALLBACK_LIBRARY_PATH` (macOS) or `LD_LIBRARY_PATH` (Linux) pointing to `{binPath}/lib` — spread into spawn env options. `detectLibraryError(output, engineName)` scans stderr/logs for dyld, GLIBC, and shared-library patterns, returning an actionable error message or null. When adding new engines with dynamically-linked binaries, use these utilities in `start()` and `initDataDir()` spawn calls. See `engines/redis/index.ts` for the canonical integration pattern.

**Commander.js:** Use `await program.parseAsync()`, not `program.parse()` — the latter returns immediately without waiting for async actions.

**Interactive menu redraws wipe ad-hoc console output:** `handleList()` clears and redraws the screen, so transient warnings or status messages for menu actions must be passed through the redraw path (for example via `inlineMessage`) instead of being printed with `console.log()` immediately before calling `handleList()` again. If a TUI message "flashes" and disappears, inspect the redraw flow before changing the action logic.

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

**Branch workflow:** `dev` is the staging branch. **All feature branches MUST be cut off `dev`**, not `main`. Merge feature → `dev` first, then open a PR from `dev` → `main`. **Do NOT merge `dev` → `main` with any failing CI checks** — wait for everything to go green. Transient/flaky test failures occasionally occur; if a failure looks transient (network blip, port collision, GitHub Actions runner hiccup), re-run that specific check before assuming a real regression. Real test failures must be fixed, not bypassed.

**Publishing:** npm via GitHub Actions OIDC. Bump version, update CHANGELOG.md, merge `dev` → `main` once CI is fully green. Merge to `main` triggers the OIDC publish job.

## Planned Improvements

### 1. Normalize `executeQuery` output across all engines

**Current state:** Each engine's `executeQuery` returns a different shape. SQL engines return `{ columns, rows }`, MongoDB returns raw mongosh JSON, HTTP engines (CouchDB, Qdrant, Meilisearch, Weaviate) return raw API responses, Redis returns plain text/arrays.

**Target:** All engines return `{ columns: string[], rows: Record<string, unknown>[], rowCount: number }`. Define edge cases: Redis scalar results → single-column row, Qdrant vector results → flattened payload, MongoDB documents → rows with `_id` column.

**Impact:** Layerbase Cloud currently normalizes in `src/api/databases.ts` `handleQuery`. Layerbase Desktop would need the same normalization. Moving it into SpinDB means all consumers get consistent output.

### 2. Accept credentials at `spindb create` time

**Current state:** `spindb create` + `spindb start` are separate steps. Some engines (SurrealDB, InfluxDB, Weaviate, MongoDB, QuestDB) need config files (credential files, admin tokens, auth env) written BEFORE the first `start`. Layerbase Cloud's `setup-database.sh` fills this gap via `SETUP_FIRST_ENGINES`.

**Target:** `spindb create --username X --password Y` writes all engine-specific config files during create (admin-token.json for InfluxDB, weaviate.env for Weaviate, `--user/--pass` persistence for SurrealDB, admin user for MongoDB). Then `spindb start` reads the config and works correctly from the first call.

**Impact:** Eliminates `SETUP_FIRST_ENGINES` in Layerbase Cloud. Simplifies `setup-database.sh` to just `spindb create --username X --password Y --bind 127.0.0.1` + health check.

### 3. (Deferred / FUTURE option) Native pgwire proxy for file-based engines - "Model B"

**Current state:** File-based engines (SQLite, DuckDB) have no wire protocol. To serve them to remote clients, Layerbase Cloud runs external proxies in front of the file: pgsqlite (Rust) for SQLite and a duckgres fork (Go) for DuckDB. spindb has no proxy concept - its SQLite/DuckDB start/stop/status are no-ops on a bare file. A local spindb/desktop user just opens the file directly.

**Target (not scheduled):** A native, pure-TS spindb pgwire proxy for file-based engines - `pg-gateway` plus Node's native SQLite/DuckDB bindings - that exposes a local file DB over the PostgreSQL wire protocol. This would let Layerbase Cloud drop both external binaries (including the maintained duckgres fork) and give desktop a "serve my local file DB over Postgres wire" feature.

**Status:** Recorded as a deliberate FUTURE option from the 2026-06-15 C-033 spindb-convergence decision (`~/dev/layerbase-architecture/tracker.md`, `~/dev/layerbase-cloud/plans/active/spindb-convergence-c033.md`). The decision there was the opposite for now: the proxy/pooler lifecycle is **intentionally kept in Layerbase Cloud** (moving it would force spindb to bundle foreign Go/Rust binaries, violating "spindb ships only database binaries"), and the near-term fix for the fragile restore-restart dance is a cloud-internal supervisor module, not a spindb change. Revisit Model B only as a separate, larger product bet.

## Recent Fixes (0.47.3 → 0.47.13)

Key fixes from the E2E stabilization session:
- **0.47.4:** CouchDB skip admin auth when no saved credentials, ClickHouse 240s timeout
- **0.47.5/6:** DuckDB binary lookup + file path in cloud containers
- **0.47.7:** Weaviate RAFT cleanup on bind change, SurrealDB skip --user/--pass on restart
- **0.47.8/9:** Weaviate RAFT cluster identity + 120s timeout
- **0.47.10:** SurrealDB reads saved credentials from credential file
- **0.47.12:** `--namespace` flag for `spindb query`, type-safe `QueryOptions`
- **0.47.13:** MongoDB `waitForReady` falls back to TCP when auth rejects mongosh
