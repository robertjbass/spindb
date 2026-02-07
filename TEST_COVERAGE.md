# Test Coverage Gaps

Tracks features that lack automated test coverage. Use this to prioritize future test work.

For CI platform coverage, see [TESTING_STRATEGY.md](TESTING_STRATEGY.md).

## Coverage Summary

| Category | Tested | Gaps | Confidence if CI passes |
|----------|--------|------|-------------------------|
| Engine lifecycle (create/start/stop/delete) | All 16 engines | None | High |
| Backup & restore (local) | All engines | None | High |
| Clone & rename | All engines | None | High |
| Query execution (run/executeQuery) | All engines | None | High |
| User management (users create) | 13 of 16 engines (excludes SQLite, DuckDB, QuestDB) | N/A (excluded engines have no user management) | High |
| Binary management | All engines | None | High |
| Doctor | Unit + CLI E2E | None | High |
| JSON output (--json) | 442-line suite | None | High |
| Validation & parsing | 1039 unit tests | None | High |
| Pull (remote sync) | Unit only | No E2E | Low |
| Restore --from-url | None | Full gap | None |
| Export docker | CI job (`test-docker-export`) | None | High |
| Which (find container) | None | Full gap | None |
| Logs | None | Full gap | None |
| Databases subcommands | JSON errors only | No functional tests | Low |
| Attach / detach | JSON errors only | No functional tests | Low |
| Edit --set-config | None | Full gap | None |
| Connect with alt tools | None | Full gap | None |
| Deps check/install | None | Full gap | None |
| Config subcommands | Unit only | No CLI E2E | Low |

## Detailed Gaps

### High Risk (complex features, engine-specific logic)

#### `spindb restore --from-url`
- **What it does:** Dumps a remote database via connection string, then restores locally. Each engine has its own `dumpFromConnectionString()` implementation.
- **Risk:** Engine-specific remote dump logic (HTTP API for REST engines, CLI tools for SQL engines, connection string parsing). Could break per-engine without detection.
- **Suggested tests:**
  - Integration: For each engine, start two containers, dump from one via connection string, restore to the other
  - Unit: Connection string parsing for each engine's URL format

#### `spindb pull --from`
- **What it does:** Remote sync with automatic backup, optional post-script, clone mode.
- **Current coverage:** Unit tests for PullManager (timestamp generation, URL redaction, dry run, validation). No test actually pulls from a real database.
- **Risk:** The orchestration (backup original -> dump remote -> restore -> run post-script -> sync registry) has many failure points.
- **Suggested tests:**
  - Integration: Pull between two local containers of the same engine
  - Test `--as` clone mode, `--post-script`, `--no-backup`

### Medium Risk (simpler features, but no coverage)

#### `spindb which`
- **What it does:** Finds container by port or connection URL.
- **Risk:** Port lookup and URL-to-engine matching could silently break. Used in scripting workflows.
- **Suggested tests:**
  - Unit: URL parsing and engine detection
  - CLI E2E: Create container, look it up by port and URL

#### `spindb databases` subcommands
- **What it does:** list, add, remove, sync, set-default, refresh.
- **Current coverage:** JSON error output validation only.
- **Risk:** Registry operations (add/remove/sync) could corrupt container config. `refresh` queries live databases.
- **Suggested tests:**
  - Integration: Create container, add/remove databases, verify config updates
  - Integration: `refresh` with a running container, verify sync

#### `spindb attach` / `spindb detach`
- **What it does:** Register/unregister SQLite and DuckDB files in the SpinDB registry.
- **Current coverage:** JSON error output only.
- **Risk:** Could leave orphaned registry entries or fail to track files.
- **Suggested tests:**
  - Integration: Create SQLite file, attach, verify in list, detach, verify removed

#### `spindb edit --set-config`
- **What it does:** Modifies database config (e.g., PostgreSQL's `max_connections`).
- **Risk:** Could write invalid config that prevents database from starting.
- **Suggested tests:**
  - Integration: Set a PostgreSQL config, restart, verify it took effect

### Low Risk (thin wrappers, simple logic)

#### `spindb logs`
- **What it does:** Read/tail/follow log files.
- **Risk:** Low -- mostly file I/O. But `-f` (follow) and `--editor` have edge cases.
- **Suggested tests:**
  - CLI E2E: Start container, verify `spindb logs` returns output

#### `spindb connect` with alternative tools
- **What it does:** `--pgcli`, `--mycli`, `--litecli`, `--iredis` flags.
- **Risk:** Low -- just changes which binary is spawned. Fails obviously if tool missing.
- **Note:** Hard to test in CI without installing these tools.

#### `spindb deps check/install`
- **What it does:** Check for required tools, offer to install missing ones.
- **Current coverage:** `dependency-manager.ts` has unit tests. CLI command has none.
- **Risk:** Low -- mostly UI presentation of dependency-manager results.

#### `spindb config` subcommands
- **What it does:** show, detect, set, unset, path, update-check.
- **Current coverage:** Unit tests for ConfigManager class. JSON output validation.
- **Risk:** Low for read operations. `set`/`unset` could corrupt config.
- **Suggested tests:**
  - CLI E2E: `config show`, `config set`, `config unset` round-trip

## What's Well Covered

These features have solid test coverage and don't need additional work:

- **Engine lifecycle** (create, start, stop, delete, list, info) -- integration tests for all 16 engines
- **Backup & restore** (local files, all formats) -- integration tests per engine
- **Clone** -- integration tests per engine
- **Rename & port change** -- integration tests per engine
- **Query execution** (run, executeQuery) -- integration tests per engine
- **User management** (users create with idempotent re-create) -- integration tests per engine
- **Binary download/extract/verify** -- Docker E2E + integration tests
- **Port conflict handling** -- integration tests per engine
- **Doctor** -- unit tests, CLI E2E, JSON output
- **JSON output mode** -- dedicated 442-line test suite covering all commands
- **Validation** (username, database name, SQL injection prevention) -- unit tests
- **Config management** (load, staleness, binary paths) -- unit tests
- **Credential management** (save, load, list) -- unit tests
- **Export docker** -- CI job (`test-docker-export`): create, export, docker build, run, verify data

## Cross-Platform Coverage

See [TESTING_STRATEGY.md](TESTING_STRATEGY.md) for CI platform matrix. All engine integration tests run on 5 platform-arch combos:
- linux-x64 (ubuntu-22.04, ubuntu-24.04)
- linux-arm64 (Docker QEMU)
- darwin-x64 (macos-15-intel)
- darwin-arm64 (macos-14)
- win32-x64 (windows-latest)

Exceptions: ClickHouse and FerretDB skip Windows (no binaries available).
