# Legacy Code Reference

This folder contains code from SpinDB's original system-binary-based architecture, preserved for reference when implementing future features that may need system binary support.

## Why This Exists

SpinDB originally used system-installed binaries (via Homebrew, apt, etc.) for MongoDB and Redis. This was migrated to hostdb downloadable binaries for:

- **Multi-version support**: Run different versions side-by-side (e.g., Redis 7 and 8)
- **No package manager dependency**: Works without Homebrew, apt, choco, etc.
- **Consistent cross-platform behavior**: Same binary management across macOS, Linux, and Windows
- **Simplified CI/CD**: Download binaries in GitHub Actions without complex package manager setup

## Preserved Code

### Binary Detection (`engines/*/binary-detection.ts`)

These files contain functions for detecting system-installed binaries:

- `detectBinary(tool)` - Finds tool in PATH using `which`/`where`
- `getVersion(path)` - Extracts version from `--version` output
- `validateVersion(version, supported)` - Checks against supported versions
- `getInstallInstructions()` - Returns package manager install commands

### MongoDB Legacy (`engines/mongodb/binary-detection.ts`)

- `getMongodPath()` - Find mongod binary in system
- `getMongodPathForVersion(version)` - Find specific MongoDB version
- `getMongoshPath()` - Find mongosh binary
- `getMongodumpPath()`, `getMongorestorePath()` - Find backup tools
- `detectInstalledVersions()` - Detect all installed MongoDB versions
- Homebrew-specific path detection for versioned installs (e.g., `mongodb-community@7.0`)

### Redis Legacy (`engines/redis/binary-detection.ts`)

- `getRedisServerPath()` - Find redis-server binary in system
- `getRedisCliPath()` - Find redis-cli binary
- `getRedisVersion()` - Get version from redis-server
- `getInstallInstructions()` - Package manager commands for Redis

## Potential Future Use

This code may be useful for:

1. **Supporting user-provided system binaries** - Alternative to downloaded binaries
2. **Detecting existing installations** - For migration from system to downloaded binaries
3. **Hybrid mode** - Prefer downloaded binaries, fallback to system

## Current Architecture

As of this migration, SpinDB uses:

| Engine     | Binary Source                                                |
|------------|--------------------------------------------------------------|
| PostgreSQL | hostdb (macOS/Linux), EDB (Windows)                          |
| MySQL      | hostdb (all platforms)                                       |
| MariaDB    | hostdb (all platforms)                                       |
| MongoDB    | hostdb (all platforms)                                       |
| Redis      | hostdb (all platforms)                                       |
| SQLite     | System-installed (all platforms)                             |

## Migration Notes

When the migration occurred:

- Existing containers remained intact (orphaned container support)
- Starting orphaned containers prompts to download the missing engine
- Old `container.json` files don't need modification
- Config cache (`~/.spindb/config.json`) is automatically updated with new binary paths
