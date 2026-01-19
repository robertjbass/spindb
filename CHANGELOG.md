# Changelog

All notable changes to SpinDB will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.19.3] - 2026-01-19

### Changed
- **README rewrite** - Completely rewrote README.md with stronger value proposition positioning SpinDB as a universal database management tool:
  - New tagline: "One CLI for all your local databases"
  - Added "What is SpinDB?" section defining three core capabilities: database package manager, unified API, and native client
  - Prominent platform coverage table showing 9 engines × 5 platforms = 45 combinations
  - Reframed "Why SpinDB?" to focus on unique strengths rather than defending against Docker
  - Better structure: Quick Start → Why → Commands → Engines → Advanced
  - Stronger examples showing multi-engine/multi-version workflows
  - Emphasizes universality: one consistent API across SQL, NoSQL, key-value, and analytics engines
  - Comprehensive comparison matrix with Docker, DBngin, Postgres.app, and XAMPP
  - Improved organization while preserving all technical depth

## [0.19.2] - 2026-01-18

### Fixed
- **DuckDB engine inference** - Removed `.db` extension from DuckDB file detection. This extension is commonly used by SQLite, so inferring DuckDB was causing misidentification. Now only `.duckdb` and `.ddb` trigger DuckDB inference.
- **DuckDB engines display** - Fixed `spindb engines list` showing DuckDB as "system-installed" even when downloaded from hostdb. Now correctly displays platform, architecture, and size like other engines.
- **DuckDB container rename** - Fixed rename leaving orphaned container directories. Now properly moves the directory before updating the registry (matching SQLite behavior).
- **DuckDB registry race conditions** - Added file-based locking for registry mutations to prevent corruption when multiple processes access the registry concurrently.
- **DuckDB SQL dump escaping** - Fixed potential SQL injection in table names by properly escaping embedded double quotes during backup.
- **ClickHouse multiquery support** - Added `--multiquery` flag to ClickHouse client for running scripts with multiple statements.
- **ClickHouse test reliability** - Improved `waitForMutationsComplete` to distinguish transient errors (connection refused, network issues) from unexpected errors, reducing flaky test failures.
- **DuckDB test isolation** - Fixed tests using shared directory that could cause conflicts. Each test run now uses a unique timestamped directory.

### Changed
- **DuckDB version display** - Updated CLAUDE.md to show full version "1.4.3" instead of just "1" in the Supported Versions table.
- **DuckDB version validation** - `compareVersions()` now throws `TypeError` for invalid version strings instead of silently returning 0. Renamed `getSupportedVersions()` to `getSupportedMajorVersions()` for clarity.
- **Logging guidelines** - Added logging section to CLAUDE.md: use `logDebug()` from `core/error-handler.ts` instead of `console.warn`/`console.log` to avoid polluting stdout/stderr and breaking JSON output modes.
- **FEATURE.md audit** - Fixed incomplete engine lists (added MariaDB, ClickHouse), clarified file counts, fixed incorrect `paths.binaries` reference, added ClickHouse to reference implementations table.
- **FerretDB planning** - Expanded FERRETDB.md with Windows support decision, detailed platform support table, hostdb build guide, and stretch goals section.

## [0.19.2] - 2026-01-18

### Added
- **MIGRATION.md** - Historical guide for migrating engines from system binaries to hostdb, extracted from CLAUDE.md for reference.

### Changed
- **Docker E2E single-engine testing** - Run Docker tests for a single engine with `pnpm test:docker -- {engine}` for faster debugging cycles.
- **CLAUDE.md refactored** - Reduced from 1043 to 271 lines (74% reduction). Added Related Documentation table, Supported Versions table with query languages, Container Config type, critical patterns (KNOWN_BINARY_TOOLS, version-maps sync), engine aliases, test port allocation, and platform philosophy. Moved migration guide to MIGRATION.md.
- **Platform philosophy documented** - Engines no longer require universal OS/architecture support. Future: hostdb and SpinDB will merge to dynamically show available engines per platform.

## [0.19.1] - 2026-01-18

### Changed
- **Faster menu startup** - Parallelized async operations in the interactive menu for faster startup:
  - Container list and engine checks now run concurrently
  - All 9 engine detection checks (PostgreSQL, MySQL, MariaDB, etc.) now run in parallel
  - Container status checks (`isRunning`) now run in parallel instead of sequentially

## [0.19.0] - 2026-01-18

### Added
- **DuckDB engine support** - Full container lifecycle for DuckDB, the embedded OLAP database
  - Downloadable binaries for all platforms (macOS Intel/ARM, Linux x64/ARM, Windows)
  - File-based database (like SQLite) - no server process, no port management
  - Version 1 supported (1.4.3 from hostdb)
  - Uses `duckdb://` connection scheme
  - Backup formats: `.sql` (SQL dump), `.duckdb` (binary copy)
  - Full integration with SpinDB registry for tracking database files
  - MIT licensed

### Fixed
- **Binary extraction for flat archives** - DuckDB hostdb archive has flat structure (binary at root, no `bin/` subdirectory). Updated binary managers for both DuckDB and SQLite to detect flat archives and create the `bin/` subdirectory during extraction for consistent structure across all engines.
- **Container manager registry handling** - Added DuckDB registry support to container-manager.ts for `getConfig`, `exists`, `list`, `rename`, and `delete` operations. File-based databases (SQLite, DuckDB) use registries instead of container directories.
- **MySQL CI cache version mismatch** - CI was caching MySQL version 9 but engines.json default is 8.0.40, causing Docker tests to re-download MySQL every run. Fixed by aligning CI cache key to `mysql-8.0`.
- **ClickHouse binary not found after download** - `KNOWN_BINARY_TOOLS` in dependency-manager.ts was missing 'clickhouse' and several other tools. This caused `findBinary()` to skip the config lookup and fall back to PATH search only. Fixed by adding all missing tools: clickhouse, postgres, pg_ctl, initdb, mariadb tools, and sqlite tools.
- **DuckDB "not running" error** - The `spindb run` command only checked for SQLite as a file-based database, causing DuckDB containers to fail with "not running" error. Fixed by adding DuckDB to the file-based engine check.

### Changed
- **Test reliability for file-based databases** - SQLite and DuckDB integration tests now verify they're using downloaded binaries (`source: 'bundled'`), not system binaries (`source: 'system'`). Tests fail fast with clear instructions if system binaries are configured, ensuring extraction bugs are caught.
- **Docker E2E tests** - Added ClickHouse and DuckDB to the Docker test suite (`pnpm test:docker`). Updated FEATURE.md with clearer guidance on adding new engines to Docker tests, including file-based engine handling.

## [0.18.1] - 2026-01-18

### Fixed
- **ClickHouse engine** - Fixed unstable tests
  - Added timeout to connection attempts
  - Added retry logic for connection attempts


## [0.18.0] - 2026-01-17

### Added
- **ClickHouse engine support** - Full container lifecycle for ClickHouse, the column-oriented OLAP database
  - Downloadable binaries for macOS and Linux (Intel/ARM) from hostdb
  - Note: Windows not supported (hostdb doesn't provide Windows binaries)
  - Version 25.12 supported (YY.MM format versioning)
  - Uses unified `clickhouse` binary with subcommands (server, client)
  - Default port 9000 (native TCP), HTTP port 8123
  - Uses SQL query language (ClickHouse SQL dialect)
  - XML configuration files (config.xml, users.xml)
  - Backup format: `.sql` (DDL + INSERT statements)
  - Full integration tests across macOS and Linux CI
  - Apache-2.0 licensed

## [0.17.3] - 2026-01-16

### Fixed
- **`pnpx spindb` now works correctly** - Fixed "tsx loader not found" error when running via pnpx
  - Root cause: pnpm's content-addressable store places dependencies in different paths than npm/yarn
  - Changed from hardcoded `node_modules/tsx/` path lookup to Node's module resolution via `createRequire`
  - Now works with npm, pnpm, yarn, and any node_modules structure

## [0.17.2] - 2026-01-14

### Fixed
- **Windows Redis and Valkey CI tests** - Fixed servers failing to start on Windows with "Connection refused" errors
  - Root cause: MSYS2/Cygwin-built binaries expect paths in `/cygdrive/c/...` format, not `C:\...`
  - Added `toCygwinPath()` helper to convert Windows paths for Redis and Valkey config files
  - Added Promise-based spawn with proper error handling (following MySQL's working pattern)
  - Added diagnostic output capturing stderr/stdout and log file content on failure

### Changed
- **Valkey port conflict test** - Aligned with Redis test behavior (verifies container creation without attempting conflicting start)
- **CI workflow** - Added Valkey to commented-out Linux ARM64 test section for future enablement
- **FEATURE.md** - Added documentation notes:
  - Updating ARM64 tests when adding new engines
  - Adding engine keyword to package.json for npm discoverability

## [0.17.1] - 2026-01-14

### Changed
- **CI workflow improvements**
  - Add `hostdb-sync` to ci-status job dependencies array
  - Add `hostdb-sync` result check to final status validation
  - Update feature branch trigger to valkey branch
  - Update TODO comment formatting for dev branch push

### Fixed
- **Documentation updates**
  - Add file-based engine edge cases table to FEATURE.md (start/stop/port/status behavior differences)
  - Various code quality improvements from CodeRabbit review suggestions

## [0.17.0] - 2026-01-14

### Added
- **Valkey engine support** - Full container lifecycle for Valkey, the Redis fork with BSD-3 licensing
  - Downloadable binaries for all platforms (macOS Intel/ARM, Linux x64/ARM, Windows)
  - Multi-version support: Run Valkey 8 and 9 simultaneously
  - Supported versions: 8, 9 (synced with hostdb releases.json)
  - Tools bundled: valkey-server, valkey-cli
  - Default port 6379 (same as Redis, auto-increments if occupied)
  - Uses `redis://` connection scheme for client compatibility
  - Backup formats: `.valkey` (text commands) and `.rdb` (RDB snapshot)
  - Full integration tests across macOS, Linux, and Windows CI
  - Support for `iredis` enhanced CLI (Redis-protocol compatible)
- **MongoDB binary downloads from hostdb** - MongoDB now uses pre-built binaries from [hostdb](https://github.com/robertjbass/hostdb) instead of system package managers
  - Downloadable binaries for all platforms (macOS, Linux, Windows)
  - Multi-version support: Run MongoDB 7.0 and 8.0 simultaneously
  - No more dependency on Homebrew, apt, or Chocolatey for MongoDB
  - Supported versions: 7.0, 8.0, 8.2 (synced with hostdb releases.json)
  - All tools bundled: mongod, mongosh, mongodump, mongorestore
- **Redis binary downloads from hostdb** - Redis now uses pre-built binaries from [hostdb](https://github.com/robertjbass/hostdb) instead of system package managers
  - Downloadable binaries for all platforms (macOS, Linux, Windows)
  - Multi-version support: Run Redis 7 and 8 simultaneously
  - No more dependency on Homebrew, apt, or package managers for Redis
  - Supported versions: 7, 8 (synced with hostdb releases.json)
  - Tools bundled: redis-server, redis-cli
- **SQLite binary downloads from hostdb** - SQLite now uses pre-built binaries from [hostdb](https://github.com/robertjbass/hostdb) instead of system binaries
  - Downloadable binaries for all platforms (macOS Intel/ARM, Linux x64/ARM, Windows)
  - No more dependency on system-installed sqlite3
  - Supported version: 3 (synced with hostdb releases.json)
  - Tools bundled: sqlite3, sqldiff, sqlite3_analyzer, sqlite3_rsync
- **MongoDB, Redis, and SQLite in Manage Engines menu** - Can now download, list, and delete engine versions for all databases

### Changed
- **MongoDB, Redis, and SQLite now use downloaded binaries** - No longer requires system-installed binaries
  - Legacy containers created with system binaries are treated as orphaned and will prompt to download matching version
- **CI workflow** - All engine tests now use downloaded binaries from hostdb on all platforms

### Removed
- **Legacy binary detection code** - Old system binary detection code for MongoDB and Redis (available in git history if needed)

## [0.16.0] - 2026-01-09

### Added
- **MySQL binary downloads from hostdb** - MySQL now uses pre-built binaries from [hostdb](https://github.com/robertjbass/hostdb) instead of system package managers
  - Downloadable binaries for all platforms (macOS Intel/ARM, Linux x64/ARM, Windows)
  - Multi-version support: Run MySQL 8.0 on port 3306 and MySQL 9 on port 3307 simultaneously
  - No more dependency on Homebrew, apt, or Chocolatey for MySQL
  - Supported versions: 8.0, 8.4, 9 (synced with hostdb releases.json)
  - Client tools (mysql, mysqldump, mysqladmin) bundled with binaries
- **MySQL in Manage Engines menu** - Can now download, list, and delete MySQL engine versions like PostgreSQL and MariaDB
- **`getMysqlClientPath()` method in BaseEngine** - Engine-specific client path method for bundled MySQL binaries

### Changed
- **MySQL now uses downloaded binaries** - No longer requires system-installed MySQL
  - Removed Linux workaround that used MariaDB as MySQL replacement
  - All platforms now use genuine MySQL binaries from hostdb
  - Legacy containers created with system MySQL are treated as orphaned and will prompt to download matching version
- **MySQL default version** - Changed from 9.0 to 9 (matching hostdb release naming)
- **MySQL supported versions** - Updated to 8.0, 8.4, 9 (matching what's available in hostdb)
- **CI workflow** - MySQL tests now run on all platforms (Linux added) using downloaded binaries

### Removed
- **MariaDB as MySQL fallback on Linux** - No longer needed since hostdb provides MySQL binaries for Linux
- **System package manager dependency for MySQL** - No more brew install mysql or apt install mysql-server required

## [0.15.2] - 2026-01-09

### Fixed
- **MariaDB Linux/Windows CI failures** - Fixed MariaDB engine failing on Linux and Windows in GitHub Actions
  - Added `--no-defaults` to MariaDB server startup to prevent reading config files with MySQL X Protocol options (`mysqlx-bind-address`) that MariaDB doesn't support
  - Removed unsupported options (`--auth-root-authentication-method`, `--basedir`) from Windows `mariadb-install-db.exe` initialization

### Changed
- **TODO.md updated** - Added parallel CI matrix item for all 5 platform/arch combinations and fixed missing `linux-arm64` in Homebrew binary platforms

## [0.15.1] - 2026-01-09

### Fixed
- **MariaDB/MySQL binary conflict resolved** - MariaDB now registers binaries under native names (`mariadb`, `mariadb-dump`, `mariadb-admin`) instead of mysql-named binaries
  - Prevents MariaDB binaries from being used by MySQL engine (caused authentication plugin errors)
  - Each engine now has completely separate binary registrations
  - Test helpers updated to call correct client path method for each engine
- **Emoji spacing in CLI** - Fixed narrow rendering of SQLite (🪶) and MariaDB (🦭) icons by adding trailing space

### Changed
- **MariaDB versions synced with hostdb** - Now supports all versions available in hostdb releases.json:
  - 10.11 (LTS), 11.4 (LTS), 11.8 (latest)
- **PostgreSQL 14 removed** - Version 14 is no longer available in hostdb releases, removed from supported versions
  - Supported versions: 15, 16, 17, 18
- **MariaDB now appears in Manage Engines menu** - Can download, list, and delete MariaDB engine versions like PostgreSQL

### Added
- **`getMariadbClientPath()` method in BaseEngine** - Engine-specific client path method for MariaDB
- **Documentation for hostdb engine migration** - CLAUDE.md now includes comprehensive guide for migrating system-installed engines to hostdb downloadable binaries

## [0.15.0] - 2026-01-08

### Added
- **MariaDB engine support** - Full container lifecycle for MariaDB using pre-compiled binaries from [hostdb](https://github.com/robertjbass/hostdb)
  - Downloadable binaries for all platforms (macOS Intel/ARM, Linux x64/ARM, Windows)
  - Create, start, stop, delete containers
  - Backup with mariadb-dump in SQL (`.sql`) or compressed (`.sql.gz`) format
  - Restore from SQL or compressed backups
  - Clone containers
  - Run SQL files or inline SQL via `spindb run`
  - Client tools (mariadb, mariadb-dump, mariadb-admin) bundled with binaries
  - Version 11.8 supported (more versions coming as hostdb expands)
  - Default port 3307 to avoid conflict with MySQL
  - Full integration tests across macOS, Linux, and Windows CI
- New alias `maria` for MariaDB engine (e.g., `spindb create mydb -e maria`)

### Changed
- Updated documentation to reflect MariaDB as a first-class engine with downloadable binaries
- Roadmap updated: MariaDB moved from "planned" to "shipped"

## [0.14.0] - 2026-01-08

### Changed
- **PostgreSQL binary source migration** - Replaced zonky.io with [hostdb](https://github.com/robertjbass/hostdb) for macOS/Linux binaries
  - Downloads from GitHub Releases instead of Maven Central
  - Same PostgreSQL versions supported (14, 15, 16, 17, 18)
  - Windows continues to use EnterpriseDB (EDB) binaries
  - macOS binaries now include client tools (psql, pg_dump, pg_restore)
- **Engine deletion now stops running containers first** - Before deleting a PostgreSQL engine, all running containers using that version are gracefully stopped
  - Shows warning about which containers will be stopped
  - Falls back to direct process kill (SIGTERM/SIGKILL) if pg_ctl fails
  - Prompts for confirmation if any containers fail to stop

### Added
- **Orphaned container support** - PostgreSQL containers can now exist without their engine binary installed
  - Deleting an engine no longer requires deleting containers first
  - Container data is preserved in `~/.spindb/containers/`
  - Starting an orphaned container prompts to download the missing engine
  - Stopping an orphaned container uses direct process kill instead of pg_ctl
- **`killProcess()` method in ProcessManager** - Direct process termination via SIGTERM/SIGKILL for cases where pg_ctl is unavailable
  - Sends SIGTERM first for graceful shutdown
  - Waits up to 10 seconds, then sends SIGKILL if needed
  - Used as fallback when engine binary is missing

### Fixed
- **Binary extraction for nested tar.gz structures** - Some hostdb releases package binaries in a nested `postgresql/` directory
  - Extraction now detects and handles both flat (`bin/`, `lib/`, `share/` at root) and nested (`postgresql/bin/`, etc.) structures
  - Fixes "PostgreSQL binary not found" errors when downloading certain versions

### Documentation
- Updated CLAUDE.md to reflect hostdb migration and orphaned container support
- Updated code comments in `version-maps.ts`, `binary-manager.ts`, and `binary-urls.ts` to reference hostdb instead of zonky.io

## [0.13.4] - 2026-01-02

### Added
- **Version-specific binary validation for system engines** - MySQL, MongoDB, and Redis now validate that the requested version is actually installed
  - Container creation fails with helpful error if requested version is not available
  - Error message lists available versions with install commands (e.g., `brew install redis@7`)
  - Stores binary path in container config to ensure version consistency across restarts

### Changed
- **Binary path stored in container config** - System-installed engines (MySQL, MongoDB, Redis) now store the exact binary path used during creation
  - Containers use the stored binary path when starting, preventing silent fallback to different versions
  - Legacy containers without `binaryPath` fall back to version detection with clear error messages
- **Version-specific Homebrew path detection** - Added comprehensive path detection for versioned Homebrew formulas:
  - MySQL: `mysql@5.7`, `mysql@8.0`, `mysql@8.4`, `mysql@9.0`
  - MongoDB: `mongodb-community@6.0`, `mongodb-community@7.0`, `mongodb-community@8.0`
  - Redis: `redis@6.2`, `redis@7.0`, `redis@7.2`, `redis@8.0`, `redis@8.2`

### Fixed
- **Silent version fallback bug** - Previously, containers could silently use a different version than requested if the exact version wasn't installed. Now throws a clear error with available versions.
- **Homebrew formula suggestions in error messages** - Install commands now suggest correct versioned formulas:
  - Redis: `redis@7.2`, `redis@8.2` (was incorrectly suggesting `redis@7`, `redis@8`)
  - MySQL: `mysql@8.0` (was incorrectly suggesting `mysql@8.0.0`)
  - MongoDB: `mongodb-community@7.0` (was incorrectly suggesting `mongodb-community@7.0.0`)
- **Integration tests use dynamic versions** - Tests now detect installed engine versions instead of hardcoding, preventing failures when specific versions aren't installed

## [0.13.3] - 2026-01-02

### Added
- **`backups` command** - List backup files in the current directory or a specified directory
  - Detects backup format from file extension (`.sql`, `.dump`, `.sqlite`, `.archive`, `.rdb`, `.redis`, `.sql.gz`)
  - Shows filename, size, modified time, format, and engine icon
  - `--all` flag to include backups from `~/.spindb/backups`
  - `--limit` to control number of results (default: 20)
  - `--json` for machine-readable output
- **Redis text backup format (`.redis`)** - New human-readable backup format for Redis
  - Exports all keys as Redis commands that can be replayed
  - Supports strings, hashes, lists, sets, and sorted sets
  - Preserves TTLs on keys
  - Can be edited manually and restored with `spindb restore`
  - Restore pipes commands to running Redis instance (no restart required)
  - Interactive prompt for merge vs replace behavior (FLUSHDB)
  - Content-based detection: Files with Redis commands are recognized regardless of extension (e.g., `users.txt`, `data`)
- **Backup/restore in container submenu** - Access backup and restore directly from a container's menu
- **Restore from connection string in submenu** - Pull data from remote PostgreSQL, MySQL, or MongoDB databases
- **Backup directory selection** - Choose output directory (current directory or custom path) in interactive backup flow
- **Backup size estimate** - Shows estimated database size before backup starts
- **Large backup confirmation** - Warns and prompts for confirmation when restoring files >1GB
- **Auto-select single database** - Automatically selects the database when container has only one during restore
- **Centralized backup format configuration** - New `config/backup-formats.ts` provides consistent format metadata across CLI

### Changed
- **Engine-specific backup format prompts** - Interactive backup now shows appropriate formats per engine:
  - PostgreSQL: `.sql` / `.dump`
  - MySQL: `.sql` / `.sql.gz`
  - SQLite: `.sql` / `.sqlite`
  - MongoDB: `.bson` / `.archive`
  - Redis: `.redis` / `.rdb`
- **Backup/restore icon swap** - Now uses `↓` for backup (download) and `↑` for restore (upload) for intuitive visual metaphor
- **Refactored backup handlers** - Reduced code duplication with shared `performBackupFlow` function
- **Redis restore UX** - Skips "Create new database" prompt since Redis uses numbered databases (0-15)
- **Redis integration tests expanded** - New tests for text format backup/restore, merge vs replace modes, and content-based format detection

### Fixed
- **Redis text backup shell escaping** - Fixed `KEYS *` and other commands with special characters being incorrectly expanded by shell

## [0.13.2] - 2026-01-01

### Added
- **Windows CI support for Redis** - Full Redis integration tests now run on Windows
  - Direct download from GitHub releases (memurai-io/redis) instead of Chocolatey for reliability
  - Comprehensive path detection across multiple installation locations
  - Enhanced error handling with detailed diagnostics when Redis binaries aren't found

### Changed
- Redis Windows installation in CI now uses direct GitHub download approach for faster, more reliable builds

## [0.13.0] - 2026-01-01

### Added
- **Redis support** - Full container lifecycle for Redis 6, 7, and 8
  - Create, start, stop, delete containers
  - Backup with BGSAVE/RDB and restore from RDB files
  - Clone containers via backup/restore
  - Run Redis commands via files or inline via `spindb run`
  - System binary detection for `redis-server` and `redis-cli`
  - Support for `--iredis` enhanced CLI flag
  - Multi-version support via Homebrew versioned formulas (`redis@7`, `redis@6`)
  - Full macOS and Linux CI integration tests (Windows to follow)
- Redis and MongoDB added to `spindb engines` list output

### Changed
- **`run` command:** Added `-c, --command` flag for inline commands (preferred over `--sql` which is now deprecated but still works)
- **`create` command:** Changed `--version` to `--db-version` to avoid conflict with global `-v, --version` flag

## [0.12.4] - 2025-12-30

### Added
- **Redis engine specification** - Added REDIS-SPEC.md documenting the implementation plan for Redis support

## [0.12.3] - 2025-12-30

### Added
- **EXAMPLES.md** - Comprehensive command examples showing all permutations for every CLI command
- **CHEATSHEET.md** - Quick reference card with common commands and workflows

## [0.12.2] - 2025-12-30

### Fixed
- **Windows MongoDB test failures** - Test helpers now use platform-aware shell quoting (double quotes on Windows, single quotes on Unix) for `mongosh --eval` commands

### Changed
- **Simplified test scripts** - Removed redundant `--test-concurrency=1` flag from all test scripts; `--experimental-test-isolation=none` is sufficient to disable worker isolation
- **CI: Added MongoDB binary verification on Windows** - Post-install step verifies `mongod`, `mongosh`, and `mongodump` are usable before running tests

## [0.12.0] - 2025-12-30

### Added
- **MongoDB support** - Full container lifecycle for MongoDB 6.0, 7.0, and 8.0
  - Create, start, stop, delete containers
  - Backup with `mongodump` and restore with `mongorestore`
  - Clone containers
  - Run JavaScript files or inline scripts via `spindb run`
  - System binary detection for `mongod`, `mongosh`, `mongodump`, `mongorestore`
  - Full cross-platform support (macOS, Linux, Windows) with CI integration tests

## [0.11.2] - 2025-12-29

### Changed
- CI: Parallelized test execution with caching for faster builds
- CI: Updated to Node.js 22
- CI: Added `--test-concurrency=1` flag to all test scripts to prevent macOS Node 22 serialization bug

## [0.11.0] - 2025-12-29

### Highlights

**PostgreSQL 18 is now supported and is the new default version.** PostgreSQL 18 was released on September 25, 2025 and brings significant performance improvements including up to 3x faster I/O operations, virtual generated columns, and the new `uuidv7()` function.

### Added
- **PostgreSQL 18 support** - Added PostgreSQL 18.1.0 as a supported version (now the default for new containers)
- **Pre-commit hook for new PostgreSQL versions** - Automatically alerts when new PostgreSQL major versions are available on zonky.io but not yet supported by SpinDB (`scripts/check-pg-versions.ts`)
- **Unit tests for `getInstallCommand()`** - 3 new tests verifying cross-platform install command generation
- **CLI E2E tests for backup/restore/clone** - 15 new tests covering:
  - SQL backup creation and JSON output
  - Restore to new database
  - Restore with `--force` flag to replace existing database
  - Data verification after restore
  - Clone stopped container
  - Clone metadata (`clonedFrom` field)

### Changed
- Exported `getInstallCommand()` from `engines/postgresql/version-validator.ts` for testability
- Added clarifying comment for retry loop behavior in restore flow

### Fixed
- **Interactive restore "press Enter to go back" now works correctly** - Empty input at connection string and file path prompts now returns to container selection instead of exiting the wizard
- **Fixed inaccurate navigation comments** - Updated comments to accurately describe `continue` behavior (returns to container selection, not source selection)
- **Consistent use of `pressEnterToContinue()` helper** - Replaced 6 manual `inquirer.prompt` patterns with the shared helper for consistent UX

## [0.10.6] - 2025-12-29

### Changed
- **Refactored `handleRestore` from recursive to loop-driven** - Back navigation now uses `while(true)` with `continue` instead of recursive calls, eliminating stack growth
- **`dumpFromConnectionString` no longer logs warnings directly** - Warnings are now returned in the result object; CLI callers handle display (better separation of concerns)
- **Cross-platform install command generation** - `getInstallCommand` now uses `detectPackageManager()` to generate appropriate commands for apt, yum, dnf, pacman, and brew
- **Renamed `detectInstalledHomebrewPostgres` to `detectInstalledPostgres`** - Name now reflects cross-platform behavior (macOS Homebrew + Linux APT)
- **Consolidated `MISSING_DEPENDENCY` error code** - Removed redundant alias, now only uses `DEPENDENCY_MISSING`

### Fixed
- **Container creation duplicate-name loop** - Users can now cancel by pressing Enter (was previously stuck requiring Ctrl+C)
- **Added `warnings` field to `DumpResult` type** - Proper type safety for warning propagation

## [0.10.5] - 2025-12-29

### Added
- **Menu navigation improvements** - All interactive menus now have "Back" and "Back to main menu" options
  - Container creation wizard: step-by-step flow with back navigation at each step (engine, version, name, port, database)
  - Backup/restore flows: back options at container selection, source selection, and format prompts
  - Consistent navigation using `←` for back and `⌂` for main menu
- **Restore mode selection** - Interactive restore now prompts for restore mode
  - "Create new database" - Restore into a new database without affecting existing data
  - "Replace existing database" - Overwrite an existing database (with confirmation)
  - Shows existing databases in container before prompting for target name

### Changed
- Standardized menu icon from `🏠` to `⌂` for consistent terminal width

### Fixed
- TypeScript function overloads added to prompt functions for proper type inference when using `allowBack` option

## [0.10.4] - 2025-12-28

### Changed
- Updated tagline from "Local databases without the Docker baggage" to "The first npm CLI for running local databases without Docker"
- Added XAMPP to feature comparison table in README
- Added new "Platform Support vs Alternatives" comparison table showing architecture-specific support across macOS, Linux, and Windows

## [0.10.3] - 2025-12-28

### Added
- **Automatic PostgreSQL client tools installation** - SpinDB now auto-installs psql, pg_dump, pg_restore when missing from zonky.io binaries
  - macOS: Installs via Homebrew (`postgresql@17`) and registers tool paths
  - Linux: Downloads from PostgreSQL apt repository and extracts to binary directory
  - CI environments: Auto-installs without prompting (detects `CI`, `GITHUB_ACTIONS` env vars)
- **`engines download` command expanded** - Now supports MySQL and SQLite installation via system package managers
  - `spindb engines download mysql` - Installs via Homebrew (macOS), apt/mariadb (Linux), or Chocolatey (Windows)
  - `spindb engines download sqlite` - Installs via system package manager
  - PostgreSQL continues to download binaries from zonky.io (macOS/Linux) or EDB (Windows)

### Changed
- CI workflow now uses SpinDB for all engine installations instead of direct package manager calls
- Dependency manager allows passwordless sudo in CI environments (GitHub Actions, GitLab CI, etc.)

## [0.10.2] - 2025-12-27

### Added
- **Unified CI workflow** - Consolidated GitHub Actions workflow (`ci.yml`) replacing separate platform workflows
  - Runs unit tests, PostgreSQL, MySQL, SQLite integration tests across Ubuntu, macOS, and Windows
  - Includes lint and type checking job
  - CLI E2E test job for full command workflow validation
  - Concurrency controls to cancel in-progress runs on new pushes
- **CLI end-to-end tests** (`tests/integration/cli-e2e.test.ts`) - Tests actual CLI commands rather than core modules
  - Version, help, doctor, and engines command tests
  - Full PostgreSQL workflow: create → list → start → info → url → run SQL → stop → delete
  - Full SQLite workflow: create → list → info → run SQL → delete
  - Error handling tests for invalid inputs
- `test:cli` npm script for running CLI E2E tests independently

### Changed
- Test container name generation uses underscores instead of hyphens for PostgreSQL compatibility (database names can't contain hyphens)
- Moved `EVALUATION.md` to `evaluations/` directory

### Removed
- Separate Windows test workflow (`test-windows.yml`) - functionality merged into unified CI workflow

## [0.10.1] - 2025-12-27

### Added
- **--json flag for all data-outputting commands** - Enable scriptable, machine-readable output across the CLI
  - `spindb backup --json` - Returns backup path, size, format, database, and container
  - `spindb restore --json` - Returns success status, database, format, source type, and connection string
  - `spindb create --json` - Returns container name, engine, version, port, database, and connection string
  - `spindb start --json` - Returns container name, port, connection string, and port change status
  - `spindb stop --json` - Returns stopped container names and count
  - `spindb delete --json` - Returns deleted container name and engine
  - `spindb clone --json` - Returns source, target, new port, and connection string
  - `spindb edit --json` - Returns container name and changes made (rename, port, relocate, config)
- **--force flag for restore command** - Overwrite existing databases without confirmation
  - `spindb restore <container> <backup> -d <database> --force` - Drops and recreates database
  - Interactive confirmation prompt when database exists (unless --force or --json mode)
  - Automatic cleanup of old database before restoration

### Changed
- **Restore command now checks for existing databases** - Prevents accidental data loss
  - Prompts user for confirmation before overwriting existing database
  - Drops existing database and removes from tracking before restoration
  - In --json mode, exits with error if database exists without --force flag

## [0.10.0] - 2025-12-26

### Added
- **Windows support** - Full cross-platform support for Windows x64
  - PostgreSQL binaries from EnterpriseDB (EDB) official distribution
  - Platform abstraction via `Win32PlatformService` class
  - Process management using `taskkill` instead of Unix signals
  - MySQL skips Unix socket on Windows (TCP only)
  - SQLite cross-platform binary detection
  - Windows package managers: Chocolatey, winget, Scoop
  - GitHub Actions Windows CI workflow
- `unzipper` dependency for cross-platform ZIP extraction
- `engines/postgresql/edb-binary-urls.ts` - EDB binary URL builder for Windows

### Changed
- Binary manager now uses `unzipper` npm package instead of shell commands for ZIP extraction
- Platform service extended with `getNullDevice()`, `getExecutableExtension()`, `terminateProcess()`, `isProcessRunning()` methods
- MySQL process termination now uses platform service abstraction
- Process manager now uses `platformService.getNullDevice()` instead of hardcoded `/dev/null`

## [0.9.3] - 2025-12-07

### Added
- **SQLite registry migration** - Registry moved from `~/.spindb/sqlite-registry.json` into `~/.spindb/config.json`
  - Centralized storage under `registry.sqlite` with `version`, `entries`, and `ignoreFolders` fields
  - Backwards compatible: registry facade API unchanged for existing code
- **CWD scanning for SQLite files** - Auto-detect unregistered `.sqlite`, `.sqlite3`, `.db` files
  - `spindb list` now scans current directory and prompts to register discovered files
  - `--no-scan` flag to skip CWD scanning
  - Option to ignore folder permanently ("don't ask again for this folder")
- **`attach` command** - Register existing SQLite database files with SpinDB
  - `spindb attach <path> [--name <name>] [--json]`
  - Auto-derives container name from filename if not specified
- **`detach` command** - Unregister SQLite database (keeps file on disk)
  - `spindb detach <name> [--force] [--json]`
  - Confirmation prompt unless `--force` flag used
- **`sqlite` subcommand group** - SQLite-specific operations
  - `spindb sqlite scan [--path <dir>]` - Scan folder for unregistered files
  - `spindb sqlite ignore [folder]` - Add folder to ignore list (defaults to CWD)
  - `spindb sqlite unignore [folder]` - Remove folder from ignore list (defaults to CWD)
  - `spindb sqlite ignored` - List all ignored folders
  - `spindb sqlite attach` - Alias for top-level attach
  - `spindb sqlite detach` - Alias for top-level detach
- **Detach option in interactive menu** - SQLite containers now show "Detach from SpinDB" in submenu
- Unit tests for `ignoreFolders` functionality (8 new tests)
- Unit tests for `deriveContainerName` scanner function (8 new tests)

### Changed
- Doctor command now shows ignored folders count in SQLite registry details
- SQLite registry now uses O(1) lookup for ignored folders via `Record<string, true>`

### Removed
- `~/.spindb/sqlite-registry.json` file (migrated to config.json)
- `getSqliteRegistryPath()` function from paths.ts (no longer needed)

## [0.9.2] - 2025-12-07

### Added
- STYLEGUIDE.md documenting coding conventions for OSS contributors
- ESLint rule `@typescript-eslint/consistent-type-imports` to enforce type import conventions

### Changed
- Renamed UI theme helper functions from generic names to `ui*` prefix for clarity:
  - `success` → `uiSuccess`
  - `error` → `uiError`
  - `warning` → `uiWarning`
  - `info` → `uiInfo`
- Standardized error variable naming: all catch blocks now use `error` instead of `err`

## [0.9.1] - 2025-12-06

### Added
- `--start` flag for `create` command to start container immediately after creation (skip prompt)
- `--no-start` flag for `create` command to skip starting container after creation
- `--connect` flag for `create` command to open shell connection after creation (implies `--start`)
- SQLite now appears in `engines` list (CLI and interactive menu)
- `handleSqliteInfo()` function in interactive menu to display SQLite installation details
- Database name validation functions (`isValidDatabaseName`, `assertValidDatabaseName`) for SQL injection prevention
- Unit tests for database name validation (15 new tests)
- Throw assertion to dependency-manager test to verify error is actually thrown
- Mock restoration to port-manager test to prevent test pollution

### Fixed
- Column alignment in engines list now properly handles emoji width with `padWithEmoji()` helper
- SQL injection vulnerability via unsanitized database names in PostgreSQL and MySQL engines
- Resource leak in port manager where socket wasn't closed on non-EADDRINUSE errors
- MySQL start promise that could hang indefinitely when `mysqladmin` path is null
- MySQL backup pipeline double-rejection causing unhandled rejection errors
- Restore command now uses TransactionManager for proper rollback on failure
- Clone and rename operations now use TransactionManager for atomicity
- Init cleanup now properly removes data directory on initialization failure
- Restore success check now properly requires exit code 0 (previously could hide failures with no stderr)
- Clone command now validates target name doesn't already exist before starting clone operation
- Clone operation in menu now properly handles errors with spinner feedback
- SQLite file extension validation now case-insensitive (accepts .SQLITE, .DB, etc.)
- Edit command `--set-config` now properly fails if engine doesn't support config editing (previously silent no-op)
- SQLite integration tests now use `execFile` instead of shell interpolation to prevent command injection
- BinarySource type check in config-manager tests now validates actual type union (`bundled | system | custom`)

### Changed
- Engines list display now uses consistent `padWithEmoji()` function across CLI and menu
- Emoji width detection upgraded from limited Unicode range to `\p{Emoji}` property escape for full coverage
- MySQL compressed backup now properly waits for both pipeline AND process exit before resolving
- Database name validation now rejects hyphens (require quoted identifiers in SQL, causing user confusion)

## [0.9.0] - 2025-12-06

### Added
- **SQLite engine support** - File-based database engine, no server process required
  - Databases stored in project directories (CWD by default), not ~/.spindb/
  - Registry system at `~/.spindb/sqlite-registry.json` to track database file locations
  - Full lifecycle support: create, delete, connect, backup, restore, rename
  - Create with `--path` option for custom file location
  - Enhanced CLI support with `litecli`
  - Relocate databases with `spindb edit mydb --relocate ~/new/path`
  - Status shows "available"/"missing" instead of "running"/"stopped"
- **`doctor` command** - System health checks and diagnostics
  - Checks configuration validity and binary cache staleness
  - Reports container status across all engines
  - Detects orphaned SQLite registry entries (files deleted outside SpinDB)
  - Verifies database tool availability
  - Interactive action menu to fix issues
  - JSON output with `--json` flag
  - Available in both CLI (`spindb doctor`) and interactive menu
- `logs` command to view container logs (`--follow`, `-n`, `--editor` options)
- `--json` flag for `config show` and `url` commands
- `status` alias for `info` command
- `shell` alias for `connect` command
- Port availability validation in `edit` command
- `--max-connections` flag for `create` command to customize connection limits
- `--set-config` flag for `edit` command to modify PostgreSQL config values
- Interactive config editing in `edit` menu for PostgreSQL containers
- Higher default `max_connections` (200) for new PostgreSQL and MySQL containers to support parallel builds (Next.js, etc.)
- `--relocate` flag for `edit` command to move SQLite database files
  - Supports tilde expansion (`~/path`), relative paths, and directories
  - Auto-creates destination directories if needed
  - Updates both container config and SQLite registry
  - `--overwrite` flag to replace existing destination file
  - Cross-filesystem moves supported (copy+delete fallback for EXDEV)

### Changed
- Refactored interactive menu from single 2749-line file into modular handler structure
  - New `cli/commands/menu/` directory with feature-specific handler modules
  - Extracted: `container-handlers.ts`, `backup-handlers.ts`, `shell-handlers.ts`, `sql-handlers.ts`, `engine-handlers.ts`, `update-handlers.ts`
  - Shared utilities in `shared.ts` (`MenuChoice` type, `pressEnterToContinue`)
- Converted dynamic imports to static top-level imports across codebase for better maintainability
- SQLite containers now properly rename via registry instead of container directories
- Container list display improved for narrow terminals with emoji width handling

### Fixed
- SQLite container deletion now properly cleans up container directories in `~/.spindb/containers/sqlite/`
- SQLite relocation now updates both container config and registry (prevents "missing" status)
- Tilde expansion in paths (`~/path` now correctly expands to home directory)
- SQLite creation no longer prompts for port
- SQLite shell options now show sqlite3/litecli instead of psql/pgcli
- Container rename now works correctly for SQLite containers

## [0.7.1] - 2025-11-30

### Changed
- Improved file path prompt UX by moving instructions above input field

## [0.7.0] - 2025-11-29

### Added
- `run` command to execute SQL files against containers
- Inline SQL support with `--sql` flag
- Engine enum for improved type safety

### Changed
- Replaced EngineName type with Engine enum across codebase

## [0.6.0] - 2025-11-29

### Added
- `self-update` command with automatic update notifications
- Version management and update checking (`spindb version --check`)
- Homebrew binary distribution plan (Bun compilation)

## [0.5.5] - 2025-11-29

### Added
- `backup` command with multi-database support
- Format options: SQL (plain text) and dump (compressed)
- Database size column in container listings

### Changed
- PostgreSQL binary management to use full versions instead of major versions only
- Config management to support MySQL tools and enhanced shells

## [0.5.0] - 2025-11-27

### Added
- MySQL/MariaDB engine support
- Enhanced shell options (pgcli, mycli, usql)
- Comprehensive CLI commands for container management
- Integration test suite for PostgreSQL and MySQL

### Changed
- Multi-engine architecture with abstract BaseEngine class

## [0.4.0] - 2025-11-26

### Added
- Dependency management system with automatic installation (`spindb deps`)
- Create-with-restore feature (`--from` flag)
- Interactive restore workflow with auto-detection

## [0.3.0] - 2025-11-26

### Added
- Clone container functionality
- Edit command for renaming and port changes
- Port conflict detection with auto-increment
- GitHub Actions workflow for automated npm publishing

### Changed
- License updated to PolyForm Noncommercial 1.0.0

## [0.2.0] - 2025-11-25

### Added
- Interactive menu with arrow-key navigation
- Multiple PostgreSQL versions (14, 15, 16, 17)
- Connection string output and clipboard support

### Changed
- Refactored project structure to remove TypeScript path aliases

## [0.1.0] - 2025-11-25

### Added
- Initial release
- PostgreSQL container management (create, start, stop, delete)
- Binary download from zonky.io
- Basic backup and restore
