# CLAUDE.md - Project Context for Claude Code

## Project Overview

SpinDB is a CLI tool for running local PostgreSQL and MySQL databases without Docker. It's a lightweight alternative to DBngin and Postgres.app, downloading PostgreSQL binaries directly and using system-installed MySQL.

**Target audience:** Individual developers who want simple local databases with consumer-grade UX.

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Execution**: `tsx` for direct TypeScript execution (no build step)
- **Package Manager**: pnpm (strictly - not npm/yarn)
- **CLI Framework**: Commander.js
- **Interactive UI**: Inquirer.js (prompts), Chalk (colors), Ora (spinners)
- **Module System**: ESM (`"type": "module"`)

## Project Structure

```
cli/
├── bin.ts                  # Entry point (#!/usr/bin/env tsx)
├── index.ts                # Commander setup, routes to commands
├── commands/               # CLI commands
│   ├── menu.ts             # Interactive arrow-key menu (default)
│   ├── create.ts           # Create container
│   ├── start.ts            # Start container
│   ├── stop.ts             # Stop container
│   ├── delete.ts           # Delete container
│   ├── list.ts             # List containers
│   ├── info.ts             # Show container details (alias: status)
│   ├── connect.ts          # Connect to shell (alias: shell)
│   ├── clone.ts            # Clone container
│   ├── restore.ts          # Restore from backup
│   ├── backup.ts           # Create backup
│   ├── run.ts              # Run SQL files/statements
│   ├── logs.ts             # View container logs
│   ├── edit.ts             # Rename/change port
│   ├── url.ts              # Connection string output
│   ├── config.ts           # Configuration management
│   ├── deps.ts             # Dependency management
│   ├── engines.ts          # Engine management
│   ├── self-update.ts      # Self-update command
│   └── version.ts          # Version info
└── ui/
    ├── prompts.ts          # Inquirer prompts
    ├── spinner.ts          # Ora spinner helpers
    └── theme.ts            # Chalk color theme
core/
├── binary-manager.ts       # PostgreSQL binary downloads
├── config-manager.ts       # ~/.spindb/config.json
├── container-manager.ts    # Container CRUD
├── port-manager.ts         # Port availability
├── process-manager.ts      # Process start/stop
├── dependency-manager.ts   # Tool detection/installation
├── error-handler.ts        # SpinDBError class
├── transaction-manager.ts  # Rollback support
├── start-with-retry.ts     # Port conflict retry
└── platform-service.ts     # Platform abstractions
config/
├── paths.ts                # ~/.spindb/ paths
├── defaults.ts             # Default values
└── os-dependencies.ts      # OS-specific deps
engines/
├── base-engine.ts          # Abstract base class
├── index.ts                # Engine registry
├── postgresql/
│   ├── index.ts            # PostgreSQL engine
│   ├── binary-urls.ts      # Zonky.io URL builder
│   ├── binary-manager.ts   # Client tool management
│   ├── backup.ts           # pg_dump wrapper
│   ├── restore.ts          # Restore logic
│   └── version-validator.ts
└── mysql/
    ├── index.ts            # MySQL engine
    ├── binary-detection.ts # System binary detection
    ├── backup.ts           # mysqldump wrapper
    ├── restore.ts          # Restore logic
    └── version-validator.ts
types/index.ts              # TypeScript types
tests/
├── unit/                   # Unit tests (141 tests)
├── integration/            # Integration tests (28 tests)
└── fixtures/               # Test data
```

## Key Architecture

### Multi-Engine Support

Engines extend `BaseEngine` abstract class:

```typescript
abstract class BaseEngine {
  abstract name: string
  abstract displayName: string
  abstract supportedVersions: string[]
  abstract start(container: ContainerConfig): Promise<void>
  abstract stop(container: ContainerConfig): Promise<void>
  abstract initDataDir(name: string, version: string, options: InitOptions): Promise<void>
  // ...
}
```

**PostgreSQL 🐘**
- Server binaries from [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries)
- Client tools (psql, pg_dump) from system
- Versions: 14, 15, 16, 17

**MySQL 🐬**
- All binaries from system (Homebrew, apt, etc.)
- Requires: mysqld, mysql, mysqldump, mysqladmin

### File Structure

```
~/.spindb/
├── bin/                              # PostgreSQL server binaries
│   └── postgresql-17.7.0-darwin-arm64/
├── containers/
│   ├── postgresql/
│   │   └── mydb/
│   │       ├── container.json
│   │       ├── data/
│   │       └── postgres.log
│   └── mysql/
│       └── mydb/
│           ├── container.json
│           ├── data/
│           └── mysql.log
└── config.json                       # Tool paths cache
```

### Container Config

```typescript
type ContainerConfig = {
  name: string
  engine: 'postgresql' | 'mysql'
  version: string
  port: number
  database: string        // Primary database
  databases?: string[]    // All databases
  created: string
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string
}
```

## Core Principles

### CLI-First Design
All functionality must be available via command-line arguments. Interactive menus are syntactic sugar for CLI commands.

```bash
# These are equivalent:
spindb create mydb -p 5433              # CLI
spindb → Create container → mydb → 5433 # Interactive
```

### Wrapper Pattern
Functions should wrap CLI tools, not implement database logic directly:

```typescript
// CORRECT: Wraps psql CLI
async createDatabase(container: ContainerConfig, database: string): Promise<void> {
  await execAsync(
    `"${psqlPath}" -h 127.0.0.1 -p ${port} -U postgres -d postgres -c 'CREATE DATABASE "${database}"'`
  )
}
```

### Transactional Operations
Multi-step operations must be atomic. Use `TransactionManager` for rollback support:

```typescript
const tx = new TransactionManager()
tx.addRollback(async () => await cleanup())
try {
  await step1()
  await step2()
  tx.commit()
} catch (error) {
  await tx.rollback()
  throw error
}
```

## Common Tasks

### Running the CLI
```bash
pnpm run start              # Interactive menu
pnpm run start create mydb  # Direct command
pnpm run start --help       # Help
```

### Running Tests
```bash
pnpm test           # All tests
pnpm test:unit      # Unit only
pnpm test:pg        # PostgreSQL integration
pnpm test:mysql     # MySQL integration
```

### Adding a New Command
1. Create `cli/commands/{name}.ts`
2. Export a Commander `Command` instance
3. Import and register in `cli/index.ts`
4. Add to `cli/commands/menu.ts` if needed

### Adding a New Engine
1. Create `engines/{engine}/index.ts` extending `BaseEngine`
2. Implement all abstract methods
3. Register in `engines/index.ts`
4. Add to `config/os-dependencies.ts`
5. Add to `config/defaults.ts`
6. Add integration tests

## Implementation Details

### Port Management
- PostgreSQL default: 5432 (range: 5432-5500)
- MySQL default: 3306 (range: 3306-3400)
- Auto-increment on conflict

### Process Management

**PostgreSQL:**
```bash
pg_ctl start -D {dataDir} -l {logFile} -w -o "-p {port}"
pg_ctl stop -D {dataDir} -m fast -w
```

**MySQL:**
```bash
mysqld --datadir={dataDir} --port={port} --socket={socket} ...
mysqladmin -h 127.0.0.1 -P {port} -u root shutdown
```

### Version Resolution (PostgreSQL)
Major versions (e.g., `"17"`) resolve to full versions (e.g., `"17.7.0"`) via Maven Central or fallback map. Full versions used everywhere.

### Config Cache
Tool paths cached in `~/.spindb/config.json` with 7-day staleness. Refresh after package manager interactions:

```typescript
await configManager.refreshAllBinaries()
```

## Error Handling

**Interactive mode:** Log error, show "Press Enter to continue"
**Direct CLI:** Log error, write to `~/.spindb/logs/`, exit non-zero

Error messages should include actionable fix suggestions.

## UI Conventions

### Menu Navigation
- Submenus have "Back" and "Back to main menu" options
- Back buttons: `${chalk.blue('←')} Back`
- Main menu: `${chalk.blue('🏠')} Back to main menu`

### Engine Icons
- PostgreSQL: 🐘
- MySQL: 🐬
- Default: 🗄️

## Known Limitations

1. **macOS/Linux only** - No Windows support (zonky.io limitation)
2. **Client tools required** - psql/mysql must be installed separately
3. **MySQL uses system binaries** - Unlike PostgreSQL
4. **Local only** - Binds to 127.0.0.1 (remote connections planned for v1.1)

## Publishing

npm publishing via GitHub Actions with OIDC trusted publishing.

1. Create PR to `main`
2. Bump version in `package.json`
3. Merge PR
4. GitHub Actions publishes automatically

## Code Style

- ESM imports, no `.js` extensions
- `async/await` over callbacks
- Ora spinners for long operations
- Conventional commits (`feat:`, `fix:`, `chore:`)

See `TODO.md` for roadmap and `CHANGELOG.md` for release history.
