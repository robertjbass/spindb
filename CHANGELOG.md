# Changelog

All notable changes to SpinDB will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
