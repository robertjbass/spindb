# Changelog

All notable changes to SpinDB will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Documentation
- Comprehensive engine documentation in TODO.md (backup formats, binary sizes)
- FEATURE.md checklist for adding new engines
- Silent catch blocks documentation in TODO.md

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
