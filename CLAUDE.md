# CLAUDE.md - Project Context for Claude Code

## Project Overview

SpinDB is a CLI tool for running local PostgreSQL and MySQL databases without Docker. It's a lightweight alternative to DBngin and Postgres.app, downloading PostgreSQL binaries directly and using system-installed MySQL.

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Execution**: `tsx` for direct TypeScript execution (no build step for dev)
- **Package Manager**: pnpm (strictly - not npm/yarn)
- **CLI Framework**: Commander.js
- **Interactive UI**: Inquirer.js (prompts), Chalk (colors), Ora (spinners)
- **Module System**: ESM (`"type": "module"`)
- **Path Aliases**: `@/*` maps to `./src/*`

## Project Structure

```
cli/
├── bin.ts                  # Entry point (#!/usr/bin/env tsx)
├── index.ts                # Commander setup, routes to commands
├── commands/               # CLI commands (create, start, stop, etc.)
│   ├── menu.ts             # Interactive arrow-key menu (default when no args)
│   ├── config.ts           # Binary path configuration
│   ├── create.ts           # Create container command
│   ├── start.ts            # Start container command
│   ├── stop.ts             # Stop container command
│   ├── delete.ts           # Delete container command
│   ├── list.ts             # List containers command
│   ├── info.ts             # Show container details command
│   ├── connect.ts          # Connect to container shell
│   ├── clone.ts            # Clone container command
│   ├── restore.ts          # Restore from backup command
│   ├── deps.ts             # Dependency management command (engine-agnostic)
│   ├── engines.ts          # Engine list and delete commands
│   ├── edit.ts             # Container rename/port editing
│   └── url.ts              # Connection string output
└── ui/
    ├── prompts.ts          # Inquirer prompts
    ├── spinner.ts          # Ora spinner helpers
    └── theme.ts            # Chalk color theme
core/
├── binary-manager.ts       # Downloads PostgreSQL server binaries from zonky.io
├── config-manager.ts       # Manages ~/.spindb/config.json
├── container-manager.ts    # CRUD for containers
├── port-manager.ts         # Port availability checking
├── process-manager.ts      # Process start/stop wrapper
├── dependency-manager.ts   # Client tool detection and installation (engine-agnostic)
├── error-handler.ts        # Centralized error handling with SpinDBError
├── transaction-manager.ts  # Rollback support for multi-step operations
├── start-with-retry.ts     # Port conflict detection and retry
└── platform-service.ts     # Platform-specific abstractions
config/
├── paths.ts                # ~/.spindb/ path definitions
├── defaults.ts             # Default values, platform mappings
└── os-dependencies.ts      # OS-specific dependency definitions
engines/
├── base-engine.ts          # Abstract base class
├── index.ts                # Engine registry
├── postgresql/
│   ├── index.ts            # PostgreSQL engine implementation
│   ├── binary-urls.ts      # Zonky.io URL builder for server binaries
│   ├── binary-manager.ts   # PostgreSQL client tool management (psql, pg_restore)
│   ├── restore.ts          # Backup detection and restore
│   └── version-validator.ts # Version compatibility checking
└── mysql/
    ├── index.ts            # MySQL engine implementation
    ├── binary-detection.ts # System binary detection (mysqld, mysql, mysqldump)
    ├── restore.ts          # Backup detection and restore
    └── version-validator.ts # Version compatibility checking
types/index.ts              # TypeScript interfaces
tests/
├── unit/                   # Unit tests
│   ├── error-handler.test.ts
│   ├── transaction-manager.test.ts
│   ├── version-validator.test.ts
│   ├── mysql-version-validator.test.ts
│   └── platform-service.test.ts
├── integration/
│   ├── helpers.ts          # Test utilities
│   ├── postgresql.test.ts  # PostgreSQL integration tests
│   └── mysql.test.ts       # MySQL integration tests
└── fixtures/
    ├── postgresql/
    │   ├── seeds/sample-db.sql
    │   └── dumps/          # Synthetic dumps for version testing
    └── mysql/
        ├── seeds/sample-db.sql
        └── dumps/          # Synthetic dumps for version testing
```

## Engine File Structure Convention

Each engine folder should have parallel file structure for maintainability:

```
engines/{engine}/
├── index.ts              # Main engine class (extends BaseEngine)
├── restore.ts            # Backup format detection, restore logic, cross-engine error detection
├── version-validator.ts  # Version parsing, compatibility checking
├── binary-manager.ts     # Client tool installation/update (PostgreSQL only - downloads tools)
└── binary-detection.ts   # System binary detection (MySQL - uses system-installed tools)
```

**Naming Parity Rules:**
- `restore.ts` - Every engine has backup/restore functionality
- `version-validator.ts` - Every engine validates dump vs client version compatibility
- Binary management differs by engine:
  - PostgreSQL: `binary-urls.ts` (server binaries from zonky.io) + `binary-manager.ts` (client tools)
  - MySQL: `binary-detection.ts` (all binaries are system-installed)

## Key Architecture Decisions

### Multi-Engine Support

SpinDB supports multiple database engines through an abstract `BaseEngine` class:

```typescript
// engines/base-engine.ts
abstract class BaseEngine {
  abstract name: string
  abstract displayName: string
  abstract supportedVersions: string[]
  abstract start(container: ContainerConfig): Promise<void>
  abstract stop(container: ContainerConfig): Promise<void>
  abstract initDataDir(name: string, version: string, options: InitOptions): Promise<void>
  // ... other abstract methods
}
```

**PostgreSQL 🐘**
- Downloads binaries from [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries) (Maven Central)
- Server binaries only (postgres, pg_ctl, initdb)
- Client tools (psql, pg_dump, pg_restore) from system
- Versions: 14, 15, 16, 17

**MySQL 🐬**
- Uses system-installed MySQL (via Homebrew, apt, etc.)
- Requires: mysqld, mysql, mysqldump, mysqladmin
- Version determined by system installation

### Engine-Scoped Container Paths

Containers are stored in engine-specific directories:
```
~/.spindb/
├── bin/                                    # PostgreSQL server binaries
│   └── postgresql-17-darwin-arm64/
├── containers/
│   ├── postgresql/                         # PostgreSQL containers
│   │   └── mydb/
│   │       ├── container.json
│   │       ├── data/
│   │       └── postgres.log
│   └── mysql/                              # MySQL containers
│       └── mydb/
│           ├── container.json
│           ├── data/
│           └── mysql.log
└── config.json
```

### Binary Sources

**PostgreSQL**: Downloaded from zonky.io on first use:
1. Download JAR from Maven Central
2. Unzip JAR (it's a ZIP file)
3. Extract `.txz` file inside
4. Extract tar.xz to `~/.spindb/bin/postgresql-{version}-{platform}-{arch}/`

**MySQL**: System-installed binaries detected from:
- PATH
- /opt/homebrew/bin/ (macOS ARM)
- /usr/local/bin/ (macOS Intel)
- /usr/bin/ (Linux)

### Client Tools

Client tools are detected from the system. The `dependency-manager.ts` handles:
- Auto-detection from PATH and common locations
- Caching paths in `~/.spindb/config.json`
- Prompting to install missing dependencies

### Container Config
Each container has a `container.json` with:
```typescript
type ContainerConfig = {
  name: string
  engine: 'postgresql' | 'mysql'
  version: string
  port: number
  database: string      // User's database name (separate from container name)
  created: string
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string
}
```

### Error Handling

**Interactive CLI vs Direct CLI:**
- **Interactive CLI (menu mode)**: Always log errors and show a "Press Enter to continue" prompt so the console doesn't clear before the user can read the error message
- **Direct CLI (command mode)**: Log the error, write to the log file at `~/.spindb/logs/`, and exit with a non-zero exit code

**Log Files:**
- All errors should be logged to `~/.spindb/logs/spindb.log` (or date-based files like `spindb-2024-01-15.log`)
- Logs should include timestamp, error code, message, and stack trace
- This allows users to review errors after the fact, especially useful when running scripts

**Sudo/Elevated Privileges:**
- On Linux, system package managers (apt, pacman, dnf) require `sudo` privileges
- When installing dependencies via `spindb deps install`, users may be prompted for their password
- Always warn users before running commands that require elevated privileges
- Homebrew on macOS does NOT require sudo (runs in userspace)

### Ideology
- All commands need to be CLI-first, this tool needs to have full functionality from the command line, there should never be a command you can run from the interactive CLI that the command line can not also handle
- Within the app, we should be making cli calls as function calls. For example, our function to create a database is called `createDatabase()` and it does so as follows:
```ts
  async createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void> {
    const { port } = container
    const psqlPath = await this.getPsqlPath()

    try {
      await execAsync(
        `"${psqlPath}" -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c 'CREATE DATABASE "${database}"'`,
      )
    } catch (error) {
    //...
  }
```
...this is correct because it us just syntactic sugar for a cli call, it does the same thing as running `psql -h 127.0.0.1 -p ${port} -U ${defaults.superuser} -d postgres -c 'CREATE DATABASE "${database}"'` from the command line. All new functionality we add needs to follow this pattern. If you notice any place in the app that does not follow this pattern, please let me know so we can fix it.
- This should be able to be run as a local CLI tool (interactively or with arguments) as well as as an npm package with the same functionality, as well as serve as a back-end for GUI that will be created as a separate project.
- Although we are optimizing for MacOS while also supporting Linux, we will be adding Windows support, we should use dependency injection to abstract away platform-specific code just as we should use dependency injection to abstract away engine-specific code for ultimate modularity, portability, and maintainability.
- All interactive menus (except the main menu) should have a "Back to main menu" option and a "Back" option for submenus.
- We need to think of creating/modifying databases or containers the way we'd think of database transactions. When creating a new database, if we fail to install the database drivers, an empty container should not end up being created in the process.

### Interactive Menu
When `spindb` is run with no arguments, it shows an interactive menu (`cli/commands/menu.ts`) using Inquirer's list prompt. Users navigate with arrow keys.

**Menu Navigation Rules:**
- Any submenu with a "Back" button that goes to a parent menu (not main menu) MUST also have a "Back to main menu" option
- Back buttons use blue color: `${chalk.blue('←')} Back to...`
- Main menu buttons use house emoji: `${chalk.blue('🏠')} Back to main menu`

**Engine Icons:**
- PostgreSQL: 🐘
- MySQL: 🐬
- Default/unknown: 🗄️

## Common Tasks

### Running the CLI
```bash
pnpm run start              # Opens interactive menu
pnpm run start create mydb  # Run specific command
pnpm run start --help       # Show help
```

### Running Tests
```bash
pnpm test           # Run all tests (PostgreSQL + MySQL sequentially)
pnpm test:pg        # PostgreSQL tests only
pnpm test:mysql     # MySQL tests only
```

### Testing Changes Manually
```bash
# PostgreSQL
pnpm run start create testdb -p 5433
pnpm run start list
pnpm run start connect testdb
pnpm run start delete testdb --force --yes

# MySQL
pnpm run start create testdb --engine mysql -p 3307
pnpm run start connect testdb
pnpm run start delete testdb --force --yes
```

### Adding a New Command
1. Create `cli/commands/{name}.ts`
2. Export a Commander `Command` instance
3. Import and add to `cli/index.ts`
4. Optionally add to interactive menu in `cli/commands/menu.ts`

### Adding a New Engine
1. Create `engines/{engine}/index.ts` extending `BaseEngine`
2. Implement all abstract methods
3. Register in `engines/index.ts`
4. Add dependencies to `config/os-dependencies.ts`
5. Add engine defaults to `config/defaults.ts`
6. Update `paths.ts` if needed
7. Add integration tests in `tests/integration/{engine}.test.ts`

## Important Implementation Details

### Platform Detection
```typescript
import { platform, arch } from 'os';
// platform() returns 'darwin' | 'linux'
// arch() returns 'arm64' | 'x64'
// Mapped to zonky.io names in defaults.ts platformMappings
```

### Version Fetching (PostgreSQL)
PostgreSQL versions are fetched dynamically from Maven Central with a 5-minute cache. Falls back to `FALLBACK_VERSION_MAP` if network fails. See `engines/postgresql/binary-urls.ts`:

```typescript
// Fallback versions (used when Maven is unreachable)
export const FALLBACK_VERSION_MAP: Record<string, string> = {
  '14': '14.20.0',
  '15': '15.15.0',
  '16': '16.11.0',
  '17': '17.7.0',
}
```

### Port Management
- PostgreSQL default: 5432 (range: 5432-5500)
- MySQL default: 3306 (range: 3306-3400)
- Uses `net.createServer()` to test availability

### Process Management

**PostgreSQL** uses `pg_ctl`:
```bash
pg_ctl start -D {dataDir} -l {logFile} -w -o "-p {port}"
pg_ctl stop -D {dataDir} -m fast -w
```

**MySQL** uses `mysqld` directly and `mysqladmin` for shutdown:
```bash
mysqld --datadir={dataDir} --port={port} --socket={socket} --pid-file={pidFile} ...
mysqladmin -h 127.0.0.1 -P {port} -u root shutdown
```

MySQL stop waits for process to actually terminate before returning.

### Create with Restore (One-Shot)
```bash
# From a dump file
spindb create mycontainer --from ./backup.dump -d mydb

# From a remote database
spindb create mycontainer --from "postgresql://user:pass@host:5432/dbname" -d mydb
```

### Engine-Aware Shell
The "Open shell" option in container submenu offers multiple shell options:
- **Use default shell (psql/mysql)** - Standard database client
- **Use pgcli/mycli (enhanced)** - Engine-specific CLI with dropdown auto-completion (if installed)
- **Use usql (universal)** - Universal SQL client with tab-completion and syntax highlighting (if installed)
- **Install options** - Downloads and installs enhanced shells via Homebrew (if not installed)

CLI flags:
- `spindb connect mydb` - Default shell (psql for PostgreSQL, mysql for MySQL)
- `spindb connect mydb --pgcli` - Use pgcli for PostgreSQL (dropdown auto-completion)
- `spindb connect mydb --mycli` - Use mycli for MySQL (dropdown auto-completion)
- `spindb connect mydb --install-pgcli` - Install pgcli and connect
- `spindb connect mydb --install-mycli` - Install mycli and connect
- `spindb connect mydb --tui` - Use usql (universal SQL client)
- `spindb connect mydb --install-tui` - Install usql and connect

## Known Limitations

1. **No client tools bundled** - psql/pg_restore/pg_dump and mysql/mysqldump must be installed separately
2. **macOS/Linux only** - No Windows support (zonky.io doesn't provide Windows binaries)
3. **MySQL uses system binaries** - Unlike PostgreSQL, MySQL requires system installation
4. **Database names immutable** - Cannot rename database after creation

## Future Improvements

See `TODO.md` for full list. Key items:
- [ ] Add `spindb backup` command
- [ ] Add `spindb logs` command
- [ ] Add `spindb exec` for running SQL files
- [ ] SQLite support
- [ ] Windows support

## New Feature Checklist

When adding new functionality, ensure ALL of the following are completed:

1. **CLI command** - Direct terminal command (e.g., `spindb edit mydb --port 5433`)
2. **Interactive CLI** - Menu option in `cli/commands/menu.ts` if applicable
3. **Tests** - Unit and/or integration tests in `tests/`
4. **README.md** - Document the new command/feature
5. **TODO.md** - Check off any related items

This ensures CLI parity: all features available in the interactive menu must also be available via command-line arguments.

## Version Maintenance

### PostgreSQL Version Updates

The `latestVersion` constant in `config/engine-defaults.ts` controls which PostgreSQL version is used for Homebrew package names (e.g., `postgresql@17`). This should be updated when a new major PostgreSQL version is released.

**Check for new versions periodically:**
- PostgreSQL releases: https://www.postgresql.org/docs/release/
- Homebrew formula: `brew info postgresql` or https://formulae.brew.sh/formula/postgresql

**When to update:**
1. A new major PostgreSQL version is released (e.g., PostgreSQL 18)
2. Homebrew has the versioned formula available (e.g., `postgresql@18`)
3. Update `config/engine-defaults.ts`:
   - Change `latestVersion: '17'` to `latestVersion: '18'`
   - Add `'18'` to `supportedVersions` array

**GitHub Action (optional):** A `version-check.yml` workflow can be added to check for new PostgreSQL/MySQL releases on PRs and notify maintainers.

## Publishing to npm

The package is published to npm using GitHub Actions with OIDC trusted publishing (no tokens required).

### Requirements

1. **GitHub repo must be public** - npm OIDC requires public repos for provenance attestation
2. **npm trusted publisher configured** - On npmjs.com, configure the package with:
   - Repository: `robertjbass/spindb`
   - Workflow: `publish.yml`
   - Environment: (leave blank)
3. **Version must be incremented** - Publishing only occurs when `package.json` version > npm version

### How to Release

1. Create a PR from your feature branch to `main`
2. Bump version in `package.json` (the PR check will remind you if you forget)
3. Merge the PR
4. GitHub Actions automatically publishes to npm

## Code Style Notes

- No `.js` extensions in imports
- Use `@/` path alias for all internal imports
- Prefer `async/await` over callbacks
- Use Ora spinners for long-running operations
- Error messages should include actionable fix suggestions
- Engine icons: 🐘 (PostgreSQL), 🐬 (MySQL), 🗄️ (default)
