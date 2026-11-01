# AGENTS.md - SpinDB

This is the authoritative project guide for every coding agent in this repository: read it before every task. `CLAUDE.md` imports this file; if the two ever differ, this file wins.

**How this file is kept:** it holds every rule whose violation breaks something on any task, hard rules first. Area rules (one engine, one subsystem, one workflow) live verbatim in the area doc named in the map below, next to their explanation and history; this file keeps only a map row naming the doc and the area's hard invariant. A new rule is one line here plus a link; the mechanism and incident story go in the area doc.

**No AI attribution:** conventional commits (`feat:`, `fix:`, `chore:`). Never mention AI tools as co-authors.

## Hard rules (every task)

- **Logging:** Use `logDebug()` from `core/error-handler.ts` for internal warnings/debug. Never `console.warn`/`console.log` - pollutes stdout and breaks `--json` mode.
- **JSON output (`--json` flag):** Guard human-readable output with `if (!options.json)`. Errors output JSON then `process.exit(1)`. Skip spinners and prompts in JSON mode. Never call `promptConfirm` when stdin is not a TTY, it throws.
- **Commander.js:** Use `await program.parseAsync()`, not `program.parse()` - the latter returns immediately without waiting for async actions.
- **Spawning background server processes:** MUST use `stdio: ['ignore', 'ignore', 'ignore']` for detached processes. Using `'pipe'` keeps file descriptors open, preventing Node.js exit even after `proc.unref()`.
- **CLI startup is lazy on purpose; keep it that way.** A new top-level command needs a `COMMAND_ENTRIES` entry in `cli/index.ts` with its exact name and aliases; never add a static `engines/index.ts` import to `core/container-manager.ts`, `cli/commands/list.ts` or anything `list` imports (use `loadEngine()` in `engines/loader.ts`). [ARCHITECTURE.md#cli-startup-processes-and-menus](ARCHITECTURE.md#cli-startup-processes-and-menus)
- **Version data comes from hostdb only.** Do NOT edit version-map entries by hand, do NOT write custom fetch/cache/fallback logic in engine files (use the `core/hostdb-releases-factory.ts` factory), and do NOT add per-engine version-shape regexes or `${version}.0.0`-style guesses (use `core/version-resolver.ts`). [ARCHITECTURE.md#version-lookups-and-resolution](ARCHITECTURE.md#version-lookups-and-resolution)
- **Pin `hostdb` exactly** in `package.json` (`"hostdb": "0.31.0"`, no caret, no tilde). Bumping hostdb is an explicit spindb release. [ARCHITECTURE.md#hostdb-npm-package-and-pinning](ARCHITECTURE.md#hostdb-npm-package-and-pinning)
- **PostgreSQL client tools are bundled-only:** resolve `pg_dump`, `pg_restore`, `psql`, `pg_basebackup` through `core/pg-binary-resolver.ts`; never probe Homebrew, APT or any system package manager, never tell users to `brew install postgresql@X`. [docs/ENGINE_NOTES.md#postgresql-client-tools-are-bundled-only](docs/ENGINE_NOTES.md#postgresql-client-tools-are-bundled-only)
- **Never use pnpm to install global packages in a Dockerfile**; always `npm install -g X`. [ARCHITECTURE.md#docker-never-pnpm-for-global-installs](ARCHITECTURE.md#docker-never-pnpm-for-global-installs)
- **Use `pnpm start` during development, not `spindb`.**
- **Changes to spindb's CLI output or flags are breaking changes for layerbase-desktop** (and may affect layerbase-cli; see Ecosystem).

## Delivery workflow

**Branch workflow:** `dev` is the staging branch. **All feature branches MUST be cut off `dev`**, not `main`. Merge feature -> `dev` first, then open a PR from `dev` -> `main`.

**Who merges:** agents may open feature PRs to `dev` and merge them once CI is green, per the normal flow; spindb releases (`dev -> main`, which publish to npm) are merged by Bob: open the release PR and stop.

**A release PR is ready only when every CI check is green** - never ask for a `dev` -> `main` merge with any failing check. Transient/flaky test failures occasionally occur; if a failure looks transient (network blip, port collision, GitHub Actions runner hiccup), re-run that specific check before assuming a real regression. Real test failures must be fixed, not bypassed.

**Publishing:** npm via GitHub Actions OIDC. Bump version, update CHANGELOG.md, then open the `dev` -> `main` release PR once CI is fully green; merge to `main` (by Bob) triggers the OIDC publish job. Before publishing a new version, always run `pnpm prep` locally to re-generate `config/version.ts`. Every new version should have a corresponding `CHANGELOG.md` entry too before being published.

**Every new feature or user-facing behavior change bumps the spindb version in the same PR** (minor for features, patch for fixes) with a `CHANGELOG.md` entry. After that version ships to npm, bump it in layerbase-cloud (`ARG SPINDB_VERSION` in `images/Dockerfile.base`) AND layerbase-desktop (the `spindb` dependency in its `package.json`, with a desktop CHANGELOG entry and patch bump); see `~/dev/layerbase-cloud/deploy/ENGINE-VERSION-UPDATE-RUNBOOK.md`.

### Before completing any task

```bash
pnpm format        # Prettier
pnpm lint          # TypeScript + ESLint
pnpm test:unit     # Unit tests
```

If modifying an engine, also run `pnpm test:engine <engine>`.

### After adding any feature

Update: AGENTS.md (only for a new every-task rule or map row; area detail goes in its area doc), README.md, TODO.md, CHANGELOG.md, and add tests. If the CLI surface changed (new command, flag, or output field), also update CHEATSHEET.md - it is the complete command reference the README defers to, and it silently goes stale otherwise.

## Ecosystem

SpinDB is the backbone of the Layerbase platform. **hostdb** builds database binaries and publishes them to `registry.layerbase.host` - spindb downloads them. **layerbase-cloud** (`~/dev/layerbase-cloud`) runs spindb inside Docker containers on Hetzner to provide managed databases with connection strings. **layerbase-desktop** (`~/dev/layerbase-desktop`) is an Electron GUI that calls spindb via IPC - it must never contain database logic that isn't in spindb. **layerbase** (`~/dev/layerbase`) is the Next.js web app at layerbase.com for billing, licensing, and the cloud dashboard. **layerbase-cli** (`~/dev/layerbase-cli`) is the branded `layerbase`/`lbase` npm CLI that forwards every non-layerbase command verbatim to the local spindb install. Changes to spindb's CLI output or flags are breaking changes for layerbase-desktop.

**When updating spindb, check whether `~/dev/layerbase-cli` needs a matching docs update.** layerbase-cli's README/help present spindb's command surface as their own (`lbase create / ls / start / backup / branch ...`), and `scripts/check-spindb-collisions.ts` there validates layerbase's registered verbs against `spindb --help`. New spindb flags forward transparently, but a NEW top-level spindb command (or renamed/removed one) can collide with a layerbase verb or make its docs stale - review layerbase-cli's AGENTS.md/CLAUDE.md/README after any spindb CLI surface change.

- **Ecosystem docs:** `~/dev/layerbase-cloud/` - Shared architecture, infrastructure inventory, cross-project rules, and agent configs.
- **Ecosystem invariants:** `~/dev/layerbase-cloud/INVARIANTS.md` - Non-negotiable rules (scripting-first, thin desktop wrapper, platform-agnostic cloud, binary ownership). Read before making architectural changes.

## Project management

- Work is tracked on the [Ecosystem tracker](https://github.com/orgs/Layerbase-LLC/projects/1); the tracker issue for a piece of work is its plan of record. Search open and closed issues before filing a new one.
- CLI concerns go in the PUBLIC `Layerbase-LLC/layerbase-cli` repo, limited to what a CLI user could see (commands, behavior, error output); server names, internal endpoints, infrastructure details and incident notes go in a private `Layerbase-LLC/layerbase-cloud` issue. No customer data or secrets.
- Detailed plans live in `~/dev/layerbase-cloud/plans/` (start at `plans/README.md`).

## Overview

SpinDB is a CLI tool for running local databases without Docker. Downloads pre-built binaries from the Layerbase registry (`registry.layerbase.host`), with GitHub ([hostdb](https://github.com/robertjbass/hostdb)) as a fallback (controlled by `ENABLE_GITHUB_FALLBACK` in `core/hostdb-client.ts`). 22 engines: DocumentDB, PostgreSQL, MySQL, MariaDB, SQLite, DuckDB, MongoDB, FerretDB, Redis, Valkey, ClickHouse, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, QuestDB, TypeDB, InfluxDB, Weaviate, TigerBeetle, LibSQL.

**Stack**: Node.js 18+, TypeScript, tsx (no build step), pnpm, Commander.js, Inquirer.js, Chalk, Ora, ESM

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

### Dev commands and tests

```bash
pnpm start                    # Interactive menu
pnpm start create mydb        # Direct command
pnpm test:unit                # Unit tests (1200+)
pnpm test:engine postgres     # Single engine integration (aliases: pg, postgresql)
pnpm test:engine              # All integration tests
pnpm test:docker              # Docker Linux E2E
```

Integration tests use reserved ports (not defaults): PostgreSQL 5454-5456, MySQL 3333-3337 (main suite 3333-3335, auth backup/restore 3336-3337), Redis 6399-6401. `tests/integration/helpers.ts` is the source of truth for the reserved ranges.

Tests use `--experimental-test-isolation=none` due to Node 22 macOS worker thread bug - don't remove.

## Critical: When Adding/Modifying Engines

Engines extend `BaseEngine`. Use `assertExhaustive(engine)` in switch statements.

1. **Version maps** (`engines/{engine}/version-maps.ts`) are **thin wrappers** over the `hostdb` npm package - they import `resolveVersion`, `getSupportedMajorVersions`, `listVersions` from hostdb and rebuild the legacy `<ENGINE>_VERSION_MAP` + `SUPPORTED_MAJOR_VERSIONS` exports at module-load time. To bump a version, bump `hostdb` in `package.json`. Do NOT edit MAP entries by hand. See `engines/sqlite/version-maps.ts` as the simplest template, `engines/ferretdb/version-maps.ts` for the most complex (dual-engine: `ferretdb` + `postgresql-documentdb`).

2. **KNOWN_BINARY_TOOLS** in `core/dependency-manager.ts` - all engine tools MUST be listed here. Missing entries cause `findBinary()` to skip config lookup and silently fall back to PATH.

3. **ENGINE_PREFIXES** in `cli/helpers.ts` - new engine prefix MUST be added. Missing = `hasAnyInstalledEngines()` returns false even when binaries exist.

4. **Type enum** - `Engine` enum, `ALL_ENGINES` array (in `types/index.ts`), and `config/engines.json` MUST be updated together.

5. **Database capabilities** - update `getDatabaseCapabilities()` in `core/database-capabilities.ts`.

6. See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for the full 20+ file checklist.

## Area doc map

Read the linked section before touching the area. The summary is the area's hard invariant, not the whole rule.

| Area | Doc | Hard invariant |
| --- | --- | --- |
| Engine categories, linked/remote containers | [ARCHITECTURE.md](ARCHITECTURE.md#engine-categories-and-remote-containers) | Linked containers block `backup`/`run`/`restore`/`export`/`clone`/`start`/`stop`/`logs` with clear errors. |
| `spindb deploy` | [ARCHITECTURE.md](ARCHITECTURE.md#spindb-deploy-antiquated) | Antiquated: not used by cloud or desktop. |
| `--bind`, `--auth`, LibSQL JWT | [ARCHITECTURE.md](ARCHITECTURE.md#bind-address-and-auth-flags) | Config-file engines patch existing configs on restart, never regenerate them (TypeDB excepted). |
| Deprecated versions, version picker | [ARCHITECTURE.md](ARCHITECTURE.md#deprecated-version-strategy) | Don't advertise, but don't break. |
| Database capabilities, `databaseExists` | [ARCHITECTURE.md](ARCHITECTURE.md#database-capabilities) | Never treat `'unknown'` as absent; keep `getListingHiddenDatabases()` in sync with `listDatabases()` exclusions. |
| Branching (`spindb branch`, git sync) | [ARCHITECTURE.md](ARCHITECTURE.md#database-branching), [docs/BRANCHING.md](docs/BRANCHING.md), [docs/BRANCHING-INTEGRATION.md](docs/BRANCHING-INTEGRATION.md) | File-based clones must be WAL-complete; `--json` mirrors `clone`/`create`. |
| Version lookups, hostdb data files | [ARCHITECTURE.md](ARCHITECTURE.md#version-lookups-and-resolution) | Factory + `resolveEngineVersion` only; no per-engine logic. |
| hostdb pin and bump workflow | [ARCHITECTURE.md](ARCHITECTURE.md#hostdb-npm-package-and-pinning) | Exact pin; read the `Docker Linux ARM64` job by name on every bump. |
| Container version pinning, DuckDB file pins | [ARCHITECTURE.md](ARCHITECTURE.md#container-version-pinning) | Persist the full version at create; a missing pinned binary fails instead of substituting. |
| Binary sources, hostdb engine names | [ARCHITECTURE.md](ARCHITECTURE.md#binary-sources-and-hostdb-engine-names) | All download logic stays in `core/hostdb-client.ts`. |
| CLI startup, `spindb start` binaries, processes, menu redraws | [ARCHITECTURE.md](ARCHITECTURE.md#cli-startup-processes-and-menus) | Start downloads the EXACT pinned version; no engine branches in the CLI; menu messages go through the redraw path. |
| Docker work | [ARCHITECTURE.md](ARCHITECTURE.md#docker-never-pnpm-for-global-installs) | `npm install -g`, never `pnpm add -g`. |
| PostgreSQL client tools | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md#postgresql-client-tools-are-bundled-only) | Bundled-only. |
| MySQL family start, remote dumps, definers, compression | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md#mysql-family-data-directory-remote-dumps-and-definers) | Refuse a start across major.minor lines; dump with the SOURCE server's tool; register every temp dump with `core/temp-dump-cleanup.ts`; no wire compression on local backups. |
| Local credentials, auth-backed backup/restore (all engines) | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md#local-credentials-and-auth-backed-backuprestore) | Local paths load `.env.spindb` via `loadCredentials`; inspect it before changing engine flags. |
| Restore outcomes, `--into-existing` | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md#restore-outcomes-and-restore-modes) | One verdict from `classifyRestoreOutcome`; partial restore is success with `status`; never print to stdout in `--json`; `--into-existing` never drops data; allowlist only with a real-engine round-trip test. |
| Redis/Valkey auth | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md#redis-and-valkey-auth) | `IMPLICIT_RESP_USERNAMES` is the one source of truth; test both remote and local query paths. |
| LibSQL, QuestDB, binary verify, Weaviate, Qdrant, dynamic libraries | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md#process-binary-and-platform-quirks) | Weaviate internal ports MUST be unique per container; dynamically linked engines use `core/library-env.ts`. |
| FerretDB v1/v2 | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md#ferretdb-v1-vs-v2) | v1 never deletes shared PostgreSQL binaries. |
| PostgreSQL pg_cron | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md#postgresql-scheduled-jobs-pg_cron) | Only after explicit opt-in; capability check, never a version-name check; never persist a merged preload on ordinary starts. |
| Standalone DocumentDB | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md#standalone-documentdb), `engines/documentdb/README.md` | Never reuse the FerretDB backend mapping; exact pins, HostDB-first cascade. |
| Other per-engine details | [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md) | |
| Adding an engine | [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) | Authoritative guide. |
| Design, layers, data flow | [ARCHITECTURE.md](ARCHITECTURE.md) | |
| Coding conventions | [STYLEGUIDE.md](STYLEGUIDE.md) | |
| Command reference | [CHEATSHEET.md](CHEATSHEET.md) | Update on every CLI surface change. |
| Keyboard shortcuts | [docs/KEYBOARD_SHORTCUTS.md](docs/KEYBOARD_SHORTCUTS.md) | |
| Planned improvements, backlog | [TODO.md](TODO.md) | |
| Other | [CHANGELOG.md](CHANGELOG.md), [TEST_COVERAGE.md](TEST_COVERAGE.md), [TESTING_STRATEGY.md](TESTING_STRATEGY.md) | |
