# CLAUDE.md - Project Context for Claude Code

## Project Overview

SpinDB is a CLI tool for running local PostgreSQL and MySQL databases without Docker. It's a lightweight alternative to DBngin, downloading PostgreSQL binaries directly and using system-installed MySQL.

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
│   └── config.ts           # Binary path configuration
└── ui/
    ├── prompts.ts          # Inquirer prompts
    ├── spinner.ts          # Ora spinner helpers
    └── theme.ts            # Chalk color theme
core/
├── binary-manager.ts       # Downloads PostgreSQL from zonky.io
├── config-manager.ts       # Manages ~/.spindb/config.json
├── container-manager.ts    # CRUD for containers
├── port-manager.ts         # Port availability checking
├── process-manager.ts      # pg_ctl start/stop wrapper
└── dependency-manager.ts   # Client tool detection and installation
config/
├── paths.ts                # ~/.spindb/ path definitions
├── defaults.ts             # Default values, platform mappings
└── os-dependencies.ts      # OS-specific dependency definitions
engines/
├── base-engine.ts          # Abstract base class
├── index.ts                # Engine registry
├── postgresql/
│   ├── index.ts            # PostgreSQL engine implementation
│   ├── binary-urls.ts      # Zonky.io URL builder
│   └── restore.ts          # Backup detection and restore
└── mysql/
    └── index.ts            # MySQL engine implementation
types/index.ts              # TypeScript interfaces
tests/
├── integration/
│   ├── helpers.ts          # Test utilities
│   ├── postgresql.test.ts  # PostgreSQL integration tests
│   └── mysql.test.ts       # MySQL integration tests
└── seeds/
    ├── postgresql/sample-db.sql
    └── mysql/sample-db.sql
```

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
The "Open shell" option in container submenu:
- PostgreSQL: `psql {connectionString}`
- MySQL: `mysql -u root -h 127.0.0.1 -P {port} {database}`

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
