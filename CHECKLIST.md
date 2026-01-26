# New Engine Implementation Checklist

A companion to [FEATURE.md](FEATURE.md) providing a step-by-step checklist for adding a new database engine to SpinDB. Check items off as you complete them.

**Reference Implementation:** Use [engines/cockroachdb/](engines/cockroachdb/) as a modern example.

---

## Table of Contents

1. [Pre-Implementation Research](#pre-implementation-research)
2. [Core Engine Files](#core-engine-files)
3. [Type System Updates](#type-system-updates)
4. [Configuration Files](#configuration-files)
5. [Core Manager Updates](#core-manager-updates)
6. [CLI Updates](#cli-updates)
7. [Menu Handler Updates](#menu-handler-updates)
8. [Test Infrastructure](#test-infrastructure)
9. [CI/CD Configuration](#cicd-configuration)
10. [Docker E2E Tests](#docker-e2e-tests)
11. [Documentation Updates](#documentation-updates)
12. [Final Verification](#final-verification)

---

## Pre-Implementation Research

Before writing code, gather this information:

- [ ] **Engine type**: Server-based, file-based, REST API, or composite?
- [ ] **Default port**: What port does it use? (e.g., PostgreSQL: 5432, CockroachDB: 26257)
- [ ] **Secondary ports**: Does it use additional ports? (e.g., HTTP admin UI, gRPC)
- [ ] **Connection scheme**: What URL scheme? (e.g., `postgresql://`, `redis://`, `http://`)
- [ ] **Default user/database**: What are the defaults? (e.g., CockroachDB: `root`/`defaultdb`)
- [ ] **CLI tools**: What binaries does it provide? (e.g., `cockroach`, `psql`, `redis-cli`)
- [ ] **Version format**: Standard semver or custom? (e.g., ClickHouse uses YY.MM)
- [ ] **Backup methods**: What backup formats are supported?
- [ ] **hostdb availability**: Check [hostdb releases](https://github.com/robertjbass/hostdb/releases) for binary availability
- [ ] **Platform support**: Which platforms have binaries? (macOS ARM/Intel, Linux x64/ARM, Windows)

---

## Core Engine Files

Create directory `engines/{engine}/` with these files:

### Required Files (8)

- [ ] `index.ts` - Main engine class extending `BaseEngine`
  - [ ] Set `name`, `displayName`, `defaultPort`, `supportedVersions` properties
  - [ ] Implement all abstract methods from `BaseEngine`
  - [ ] Export singleton instance: `export const {engine}Engine = new {Engine}Engine()`

- [ ] `backup.ts` - Backup creation wrapper
  - [ ] Implement backup function using engine's CLI tools
  - [ ] Support all backup formats defined in `config/backup-formats.ts`

- [ ] `restore.ts` - Backup detection and restore logic
  - [ ] Implement `detectBackupFormat()` - read only minimal bytes (not entire file!)
  - [ ] Implement restore function with streaming (not `readFile()`)
  - [ ] Implement `parseConnectionString()` for remote dump support

- [ ] `version-validator.ts` - Version parsing and compatibility
  - [ ] `parseVersion()` - parse version strings
  - [ ] `isVersionSupported()` - check against supported versions
  - [ ] `getMajorVersion()` - extract major version
  - [ ] `compareVersions()` - compare two versions

- [ ] `version-maps.ts` - Major version to full version mapping
  - [ ] Must match [hostdb releases.json](https://github.com/robertjbass/hostdb/blob/main/releases.json) exactly
  - [ ] Export `{ENGINE}_VERSION_MAP`, `SUPPORTED_MAJOR_VERSIONS`, `FALLBACK_VERSION_MAP`

- [ ] `binary-urls.ts` - hostdb download URL construction
  - [ ] `getBinaryUrl(version, platform, arch)` function

- [ ] `binary-manager.ts` - Download, extraction, verification
  - [ ] Choose correct base class (see FEATURE.md "Binary Management" section)
  - [ ] Implement `verify()` if engine has custom version output format
  - [ ] Handle platform-specific extraction (Windows .zip vs .tar.gz)

- [ ] `hostdb-releases.ts` - Fetch versions from releases.json
  - [ ] `fetchAvailableVersions()` with fallback to version-maps.ts

### Optional Files

- [ ] `cli-utils.ts` - Shared CLI utilities (if needed)

---

## Type System Updates

### types/index.ts

- [ ] Add to `Engine` enum:
  ```ts
  {Engine} = '{engine}',
  ```

- [ ] Add to `ALL_ENGINES` array:
  ```ts
  Engine.{Engine},
  ```

- [ ] Add binary tools to `BinaryTool` type:
  ```ts
  | '{engine}'  // or '{engine}-server', '{engine}-cli', etc.
  ```

- [ ] Add backup format type if engine has unique formats:
  ```ts
  export type {Engine}Format = 'sql' | 'custom'  // adjust as needed
  ```

---

## Configuration Files

### config/engine-defaults.ts

- [ ] Add engine defaults (see `EngineDefaults` type for required fields):
  ```ts
  {engine}: {
    defaultVersion: '25',
    defaultPort: 26257,
    portRange: { start: 26257, end: 26357 },
    latestVersion: '25',
    superuser: 'root',
    connectionScheme: 'postgresql',  // or engine-specific scheme
    logFileName: '{engine}.log',
    pidFileName: '{engine}.pid',
    dataSubdir: 'data',
    clientTools: ['{engine}'],
    maxConnections: 0,  // 0 if not applicable
  },
  ```
  Note: `supportedVersions` belongs in `config/engines.json`, not here.

### config/engines.json

- [ ] Add engine entry with all required fields:
  - `displayName`, `icon`, `status`, `binarySource`
  - `supportedVersions`, `defaultVersion`, `defaultPort`
  - `runtime`, `queryLanguage`, `connectionScheme`
  - `superuser`, `clientTools`, `licensing`, `notes`

### config/backup-formats.ts

- [ ] Add backup format configuration:
  ```ts
  {engine}: {
    formats: {
      sql: { extension: '.sql', label: '.sql', description: '...', spinnerLabel: 'SQL' },
      // Add secondary format if applicable
    },
    supportsFormatChoice: true,  // or false if single format
    defaultFormat: 'sql',
  },
  ```

### config/os-dependencies.ts (if applicable)

- [ ] Add system package fallback dependencies

---

## Core Manager Updates

### core/dependency-manager.ts

- [ ] Add binary tools to `KNOWN_BINARY_TOOLS` array:
  ```ts
  '{engine}',  // or individual tools like '{engine}-server', '{engine}-cli'
  ```
  **Critical:** Without this, `findBinary()` cannot find your tools!

### core/config-manager.ts

- [ ] Add tools constant:
  ```ts
  const {ENGINE}_TOOLS: BinaryTool[] = ['{engine}']
  ```

- [ ] Add to `ALL_TOOLS` array:
  ```ts
  ...{ENGINE}_TOOLS,
  ```

- [ ] Add to `ENGINE_BINARY_MAP`:
  ```ts
  [Engine.{Engine}]: {ENGINE}_TOOLS,
  ```

- [ ] Add to `initialize()` return type and implementation

- [ ] Export the tools constant

### engines/index.ts

- [ ] Import engine:
  ```ts
  import { {engine}Engine } from './{engine}'
  ```

- [ ] Add to engines record:
  ```ts
  {engine}: {engine}Engine,
  ```

- [ ] Add aliases if applicable:
  ```ts
  alias: {engine}Engine,  // e.g., 'crdb' for 'cockroachdb'
  ```

### engines/base-engine.ts

- [ ] Add client path getter if engine has CLI tool:
  ```ts
  async get{Engine}Path(_version?: string): Promise<string> {
    throw new Error('{engine} not found')
  }
  ```

---

## CLI Updates

### cli/constants.ts

- [ ] Add engine icon to `ENGINE_ICONS`:
  ```ts
  {engine}: '...',  // Choose appropriate emoji
  ```

- [ ] Add icon width to `ENGINE_ICON_WIDTHS`:
  ```ts
  {engine}: 2,  // Test this! Some emojis render narrow (width 1)
  ```

**Important:** After adding, run `spindb` and navigate to "Create new container" to verify alignment. If your engine's name appears too close to the icon (no space), change width to `1`.

### cli/helpers.ts

- [ ] Add `Installed{Engine}Engine` type

- [ ] Add `getInstalled{Engine}Engines()` detection function

- [ ] Add engine prefix to `ENGINE_PREFIXES` array:
  ```ts
  '{engine}-',
  ```
  **Critical:** Without this, `hasAnyInstalledEngines()` won't detect your engine!

- [ ] Update `InstalledEngine` union type to include your type

- [ ] Update `getInstalledEngines()` to call your detection function

### cli/commands/create.ts

- [ ] Update `--engine` option help text to include new engine

- [ ] Add to `detectLocationType()` for connection string inference (if applicable)

### cli/commands/engines.ts

- [ ] Import binary manager

- [ ] Add download case in the download subcommand

- [ ] Update error message to include engine

- [ ] Add to `listEngines()` display

---

## Menu Handler Updates

### cli/commands/menu/container-handlers.ts

- [ ] Skip database name prompt if engine uses numbered DBs (like Redis 0-15)
- [ ] Hide "Run SQL file" option if REST API engine (no CLI shell)

### cli/commands/menu/shell-handlers.ts

- [ ] Add shell option selection for your engine
- [ ] Add to `isNonSqlEngine` check if applicable
- [ ] Add `launchShell()` case for your engine
- [ ] For REST API engines: open web dashboard instead of CLI shell

### cli/commands/menu/sql-handlers.ts

- [ ] Add engine to `getScriptType()` function:
  - SQL engines → `'SQL'`
  - Document/search engines → `'Script'`
  - Key-value engines → `'Command'`

### cli/commands/menu/backup-handlers.ts

- [ ] Add connection string validation in `handleRestore()`
- [ ] Add connection string validation in `handleRestoreForContainer()`

### cli/commands/menu/engine-handlers.ts

- [ ] Add type import for your installed engine type
- [ ] Add to `allEnginesSorted` array for "Manage engines" menu

---

## Test Infrastructure

### Test Fixtures

- [ ] Create `tests/fixtures/{engine}/seeds/` directory
- [ ] Create seed file:
  - SQL engines: `sample-db.sql` with 5 test_user records
  - Key-value engines: `sample-db.{ext}` with 6 keys
  - REST API engines: `README.md` documenting the API approach

### tests/integration/helpers.ts

- [ ] Add to `TEST_PORTS`:
  ```ts
  {engine}: { base: XXXXX, clone: XXXXX, renamed: XXXXX },
  ```
  Use ports that won't conflict with other engines!

- [ ] Add to `executeSQL()` function

- [ ] Add to `waitForReady()` function

- [ ] Add to `getConnectionString()` function

- [ ] Add engine-specific helper functions (e.g., `getRowCount()`)

- [ ] Add to `runScriptFile()` function

- [ ] Add to `runScriptSQL()` function

### tests/integration/{engine}.test.ts

- [ ] Create integration test file with minimum 14 tests:
  - [ ] should create container without starting (--no-start)
  - [ ] should start the container
  - [ ] should seed the database with test data using runScript
  - [ ] should clone via backup and restore to new container
  - [ ] should verify cloned data matches source
  - [ ] should stop and delete the cloned container
  - [ ] should modify data using runScript inline command
  - [ ] should stop, rename container, and change port
  - [ ] should verify data persists after rename
  - [ ] should handle port conflict gracefully
  - [ ] should show warning when starting already running container
  - [ ] should handle stopping already stopped container gracefully
  - [ ] should delete container with --force
  - [ ] should have no test containers remaining

### scripts/test-engine.ts

- [ ] Add to `ENGINE_TEST_FILES`:
  ```ts
  {engine}: '{engine}.test.ts',
  ```

- [ ] Add to `ENGINE_ALIASES`:
  ```ts
  alias: '{engine}',  // e.g., 'crdb': 'cockroachdb'
  ```

- [ ] Add to `TEST_ORDER` array

- [ ] Update help text to include engine and aliases

### Unit Tests

- [ ] Create `tests/unit/{engine}-version-validator.test.ts`
- [ ] Create `tests/unit/{engine}-restore.test.ts`
- [ ] Update `tests/unit/config-manager.test.ts` with engine tools

---

## CI/CD Configuration

### .github/workflows/ci.yml

- [ ] Add binary cache step:
  ```yaml
  - name: Cache {Engine} binaries
    uses: actions/cache@v4
    with:
      path: ~/.spindb/bin
      key: spindb-{engine}-{version}-${{ runner.os }}-${{ runner.arch }}
  ```

- [ ] Add integration test job `test-{engine}` with 5-platform matrix:
  - ubuntu-22.04
  - ubuntu-24.04
  - macos-15 (Intel)
  - macos-14 (ARM)
  - windows-latest (if supported)

- [ ] Add download step: `pnpm start engines download {engine} {version}`

- [ ] Add test step: `pnpm test:engine {engine}`

- [ ] Add failure debug step to show logs

- [ ] Add `test-{engine}` to `ci-success` job `needs` array

- [ ] Add result check in `ci-success` job script:
  ```bash
  if [ "${{ needs.test-{engine}.result }}" != "success" ]; then
    echo "{Engine} tests failed"
    exit 1
  fi
  ```

---

## Docker E2E Tests

### tests/docker/Dockerfile

- [ ] Add engine to comments listing downloaded engines

- [ ] Add any required library dependencies

### tests/docker/run-e2e.sh

- [ ] Add to `VALID_ENGINES` array

- [ ] Add to `EXPECTED_COUNTS` array (number of records in seed file)

- [ ] Add to `BACKUP_FORMATS` array (primary|secondary formats)

- [ ] Add case in `get_backup_extension()` function

- [ ] Add case in `insert_seed_data()` function

- [ ] Add case in `get_data_count()` function

- [ ] Add case in `create_backup()` function

- [ ] Add case in `create_restore_target()` function

- [ ] Add case in `restore_backup()` function

- [ ] Add case in `verify_restored_data()` function

- [ ] Add connectivity test case in main engine loop

- [ ] Add engine test execution at bottom of file

- [ ] For file-based engines: Update start/stop skip conditions

- [ ] For REST API engines: Add curl-based tests

---

## Documentation Updates

### README.md

- [ ] Update engine count (e.g., "13 different database engines" → "14 different database engines")
- [ ] Add engine to `--engine` option list in examples
- [ ] Add row to Platform Coverage table
- [ ] Update "X combinations" count
- [ ] Add row to Supported Databases table
- [ ] Add to Engine Categories list
- [ ] Update comparison matrix engine count
- [ ] Add row to Durability table
- [ ] Add Engine-Specific Details section
- [ ] Add row to Enhanced CLI Tools table
- [ ] Add Backup & Restore section for engine
- [ ] Add to Connection String Formats table
- [ ] Remove from Roadmap if it was listed as planned

### ENGINES.md

- [ ] Add to Supported engines table
- [ ] Remove from Planned section (if applicable)
- [ ] Add Engine Details section with full documentation
- [ ] Add to Backup Format Summary table
- [ ] Add to Enhanced CLI Tools table
- [ ] Add to Engine Emojis table

### ARCHITECTURE.md

- [ ] Update description to include engine
- [ ] Update architecture diagram
- [ ] Add to Engine Types list
- [ ] Add to Engine Registry section
- [ ] Add alias to aliases section
- [ ] Add to Platform Support table
- [ ] Update Type System section
- [ ] Update ContainerConfig type

### CLAUDE.md

- [ ] Add engine alias to Engine Aliases section
- [ ] Add row to Supported Versions & Query Languages table
- [ ] Add to Port Management section (format: `EngineName: port`)

### CHANGELOG.md

- [ ] Add entry to `[Unreleased]` or current version section

### package.json

- [ ] Add engine name to `keywords` array
- [ ] Bump version (if this is a feature release)

---

## Final Verification

### Automated Checks

- [ ] `pnpm lint` passes
- [ ] `pnpm test:unit` passes (all 800+ tests)
- [ ] `pnpm test:engine {engine}` passes
- [ ] `pnpm test:docker -- {engine}` passes (if applicable)

### Manual Verification

- [ ] Run `spindb` and verify engine appears in "Create new container" menu
- [ ] Verify engine icon alignment (proper spacing after emoji)
- [ ] Create a container: `pnpm start create test-{engine} --engine {engine}`
- [ ] Start container: `pnpm start start test-{engine}`
- [ ] Connect to container: `pnpm start connect test-{engine}`
- [ ] Run a query: `pnpm start run test-{engine} -c "SELECT 1;"`
- [ ] Create backup: `pnpm start backup test-{engine}`
- [ ] Stop container: `pnpm start stop test-{engine}`
- [ ] Delete container: `pnpm start delete test-{engine} --yes`
- [ ] Verify engine appears in "Manage engines" menu
- [ ] Verify `pnpm start engines list` shows the engine

### File Count Verification

Run this to verify all files are created:

```bash
# Engine files (should be 8)
ls -la engines/{engine}/ | wc -l

# Fixture files
ls -la tests/fixtures/{engine}/seeds/

# Test files
ls -la tests/integration/{engine}.test.ts
ls -la tests/unit/{engine}-*.test.ts

# Check documentation changes
git diff --stat README.md ENGINES.md ARCHITECTURE.md CLAUDE.md CHANGELOG.md
```

---

## Common Gotchas and Edge Cases

### Emoji Width Issues

Some emojis render narrower in terminals. If your engine icon appears too close to the engine name:
- Set width to `1` in `ENGINE_ICON_WIDTHS`
- Examples: 🦭 (seal), 🪶 (feather), 🛋 (couch), 🪳 (cockroach)

### Process Spawning with --background Flag

If your engine uses a `--background` flag that forks a daemon:
- Use `stdio: ['ignore', 'ignore', 'ignore']` to prevent hanging
- The parent process exits but file descriptors are inherited by the daemon
- See `engines/cockroachdb/index.ts` for correct pattern

### Windows Executable Extensions

Always use `platformService.getExecutableExtension()`:
```ts
const ext = platformService.getExecutableExtension()  // '.exe' on Windows, '' elsewhere
const binaryPath = join(binDir, `{engine}${ext}`)
```

### Port Allocation for Multi-Port Engines

If your engine uses multiple ports (e.g., SQL + HTTP):
- Allocate consecutive ports: SQL on N, HTTP on N+1
- Document this in CLAUDE.md and FEATURE.md
- Update `findConsecutiveFreePorts()` call in tests

### Connection String Compatibility

If your engine is protocol-compatible with another (e.g., CockroachDB with PostgreSQL):
- Use the compatible scheme: `postgresql://` for CockroachDB
- Document this clearly in connection string examples

### Version Detection Without --version Flag

Some engines don't support `--version` (e.g., CouchDB is an Erlang app that starts when run):
- Override `verifyBinary()` to check file existence only
- See `engines/couchdb/binary-manager.ts` for example

### REST API Engines

For engines without CLI tools (Qdrant, Meilisearch, CouchDB):
- `spindb run` is not applicable - throw clear error
- `spindb connect` opens web dashboard in browser
- Tests use `curl` instead of CLI commands
- Create `README.md` in fixtures instead of seed file

---

## Quick Reference: Files to Modify

| File | Action |
|------|--------|
| `engines/{engine}/*.ts` | Create (8 files) |
| `engines/index.ts` | Add import and registration |
| `engines/base-engine.ts` | Add client path getter |
| `types/index.ts` | Add Engine enum, ALL_ENGINES, BinaryTool |
| `config/engine-defaults.ts` | Add defaults |
| `config/engines.json` | Add metadata |
| `config/backup-formats.ts` | Add formats |
| `core/dependency-manager.ts` | Add to KNOWN_BINARY_TOOLS |
| `core/config-manager.ts` | Add tools constant and mappings |
| `cli/constants.ts` | Add icon and width |
| `cli/helpers.ts` | Add type, detection, ENGINE_PREFIXES |
| `cli/commands/create.ts` | Add engine case for creation options |
| `cli/commands/engines.ts` | Add download and list cases |
| `cli/commands/menu/*.ts` | Update handlers (5 files) |
| `scripts/test-engine.ts` | Add engine support |
| `tests/integration/helpers.ts` | Add helper functions |
| `tests/integration/{engine}.test.ts` | Create test file |
| `tests/unit/{engine}-version-validator.test.ts` | Create version validator tests |
| `tests/unit/{engine}-restore.test.ts` | Create restore tests |
| `tests/unit/config-manager.test.ts` | Update with engine tools |
| `tests/fixtures/{engine}/seeds/*` | Create seed file |
| `tests/docker/run-e2e.sh` | Add E2E tests |
| `tests/docker/Dockerfile` | Add engine binaries and dependencies |
| `.github/workflows/ci.yml` | Add CI job |
| `README.md` | Update documentation |
| `ENGINES.md` | Add engine details |
| `ARCHITECTURE.md` | Update architecture |
| `CLAUDE.md` | Update project docs |
| `CHANGELOG.md` | Add entry |
| `package.json` | Add keyword, bump version |

Total: ~35 files modified or created

---

## See Also

- [FEATURE.md](FEATURE.md) - Detailed implementation guide with code examples
- [engines/cockroachdb/](engines/cockroachdb/) - Recent reference implementation
- [engines/valkey/](engines/valkey/) - Another good reference for Redis-like engines
- [plans/FERRETDB.md](plans/FERRETDB.md) - Guide for composite engines
