# CLAUDE.md - Project Context for Claude Code

## Project Overview

SpinDB is a CLI tool for running local PostgreSQL databases without Docker. It's a lightweight alternative to DBngin, downloading and managing PostgreSQL binaries directly.

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
src/
├── bin/cli.ts              # Entry point (#!/usr/bin/env tsx)
├── cli/
│   ├── index.ts            # Commander setup, routes to commands
│   ├── commands/           # CLI commands (create, start, stop, etc.)
│   │   ├── menu.ts         # Interactive arrow-key menu (default when no args)
│   │   └── config.ts       # Binary path configuration
│   └── ui/
│       ├── prompts.ts      # Inquirer prompts
│       ├── spinner.ts      # Ora spinner helpers
│       └── theme.ts        # Chalk color theme
├── core/
│   ├── binary-manager.ts   # Downloads PostgreSQL from zonky.io
│   ├── config-manager.ts   # Manages ~/.spindb/config.json
│   ├── container-manager.ts # CRUD for containers
│   ├── port-manager.ts     # Port availability checking
│   └── process-manager.ts  # pg_ctl start/stop wrapper
├── config/
│   ├── paths.ts            # ~/.spindb/ path definitions
│   └── defaults.ts         # Default values, platform mappings
├── engines/
│   ├── base-engine.ts      # Abstract base class
│   ├── index.ts            # Engine registry
│   └── postgresql/
│       ├── index.ts        # PostgreSQL engine implementation
│       ├── binary-urls.ts  # Zonky.io URL builder
│       └── restore.ts      # Backup detection and restore
└── types/index.ts          # TypeScript interfaces
```

## Key Architecture Decisions

### Binary Source
PostgreSQL server binaries come from [zonky.io](https://github.com/zonkyio/embedded-postgres-binaries) (Maven Central). These only include server binaries (postgres, pg_ctl, initdb), NOT client tools (psql, pg_dump, pg_restore).

**Download flow:**
1. Download JAR from Maven Central
2. Unzip JAR (it's a ZIP file)
3. Extract `.txz` file inside
4. Extract tar.xz to `~/.spindb/bin/postgresql-{version}-{platform}-{arch}/`

### Client Tools
Client tools (psql, pg_restore) are detected from the system. The `config-manager.ts` handles:
- Auto-detection from PATH and common locations
- Caching paths in `~/.spindb/config.json`
- Manual override via `spindb config set`

### Data Storage
```
~/.spindb/
├── bin/                      # Downloaded PostgreSQL binaries
├── containers/{name}/
│   ├── container.json        # Container metadata
│   ├── data/                 # PostgreSQL data directory
│   └── postgres.log          # Server logs
└── config.json               # Tool paths, settings
```

### Interactive Menu
When `spindb` is run with no arguments, it shows an interactive menu (`src/cli/commands/menu.ts`) using Inquirer's list prompt. Users navigate with arrow keys.

**Menu Navigation Rules:**
- Any submenu with a "Back" button that goes to a parent menu (not main menu) MUST also have a "Back to main menu" option
- Back buttons use blue color: `${chalk.blue('←')} Back to...`
- Main menu buttons use house emoji: `${chalk.blue('🏠')} Back to main menu`

### Container Config
Each container has a `container.json` with:
```typescript
type ContainerConfig = {
  name: string
  engine: string
  version: string
  port: number
  database: string      // User's database name (separate from container name)
  created: string
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string
}
```

The `database` field allows users to specify a custom database name in the connection string (e.g., `postgresql://postgres@localhost:5432/my-app-db`).

## Common Tasks

### Running the CLI
```bash
pnpm run start              # Opens interactive menu
pnpm run start create mydb  # Run specific command
pnpm run start --help       # Show help
```

### Testing Changes
No test suite yet. Manual testing:
```bash
pnpm run start create testdb -p 5433
pnpm run start list
pnpm run start connect testdb
pnpm run start delete testdb --force --yes
```

### Adding a New Command
1. Create `src/cli/commands/{name}.ts`
2. Export a Commander `Command` instance
3. Import and add to `src/cli/index.ts`
4. Optionally add to interactive menu in `src/cli/commands/menu.ts`

## Important Implementation Details

### Platform Detection
```typescript
import { platform, arch } from 'os';
// platform() returns 'darwin' | 'linux'
// arch() returns 'arm64' | 'x64'
// Mapped to zonky.io names in defaults.ts platformMappings
```

### Version Fetching
PostgreSQL versions are fetched dynamically from Maven Central with a 5-minute cache. Falls back to `FALLBACK_VERSION_MAP` if network fails. See `src/engines/postgresql/binary-urls.ts`:

```typescript
// Fallback versions (used when Maven is unreachable)
export const FALLBACK_VERSION_MAP: Record<string, string> = {
  '14': '14.20.0',
  '15': '15.15.0',
  '16': '16.11.0',
  '17': '17.7.0',
}

// Dynamic fetching from Maven
export async function fetchAvailableVersions(): Promise<Record<string, string[]>>
```

The create flow uses two-step version selection: first major version (14, 15, 16, 17), then specific minor version within that major.

### Port Management
- Default port: 5432
- If busy, scans 5432-5500 for available port
- Uses `net.createServer()` to test availability

### Process Management
Uses `pg_ctl` for start/stop:
```bash
pg_ctl start -D {dataDir} -l {logFile} -w -o "-p {port}"
pg_ctl stop -D {dataDir} -m fast -w
```

PID file location: `~/.spindb/containers/{name}/data/postmaster.pid`

### Create with Restore (One-Shot)
Create a container and restore data in a single command:

```bash
# From a dump file
spindb create mycontainer --from ./backup.dump -d mydb

# From a remote database
spindb create mycontainer --from "postgresql://user:pass@host:5432/dbname" -d mydb
```

The `--from` option auto-detects whether the location is a file path or connection string.

### Restore Command
Restore to an existing container:

1. **From dump file** - Restore from a local `.sql`, custom format, or tar format backup:
   ```bash
   spindb restore mycontainer ./backup.dump -d mydb
   ```

2. **From connection string** - Pull data directly from a remote database using `pg_dump`:
   ```bash
   spindb restore mycontainer --from-url "postgresql://user:pass@host:5432/dbname" -d mydb
   ```

The `--from-url` option:
- Validates the connection string starts with `postgresql://` or `postgres://`
- Creates a temporary dump using `pg_dump -Fc` (custom format)
- Restores it to the target container
- Automatically cleans up the temp file

### Interactive Menu Restore
The interactive menu (`spindb` → "Restore backup") offers:
- Selection of existing running containers
- Option to create a new container as part of the restore flow
- Choice between dump file or connection string source

## Known Limitations

1. **No client tools bundled** - psql/pg_restore/pg_dump must be installed separately
2. **macOS/Linux only** - No Windows support (zonky.io doesn't provide Windows binaries)
3. **Database names immutable** - Cannot rename database after creation (would require `ALTER DATABASE`)

## Future Improvements

See `TODO.md` for full list. Key items:
- [ ] Add `spindb backup` command (export a container's database to a dump file)
- [ ] Add `spindb logs` command to tail postgres.log
- [ ] Add `spindb exec` for running SQL files
- [ ] Database rename support
- [ ] Support MySQL/SQLite engines (architecture supports it)
- [ ] Windows support (would need different binary source)

## Publishing to npm

The package is published to npm using GitHub Actions with OIDC trusted publishing (no tokens required).

### Requirements

1. **GitHub repo must be public** - npm OIDC requires public repos for provenance attestation
2. **npm trusted publisher configured** - On npmjs.com, configure the package with:
   - Repository: `robertjbass/spindb`
   - Workflow: `publish.yml`
   - Environment: (leave blank)
3. **Version must be incremented** - Publishing only occurs when `package.json` version > npm version

### GitHub Actions Workflows

**`.github/workflows/version-check.yml`** - Runs on PRs to `main`
- Compares PR version against current npm version
- Posts a comment if version isn't bumped (with suggested versions)
- Blocks merge if version check fails

**`.github/workflows/publish.yml`** - Runs on push to `main`
- Pre-publish check: Verifies version is greater than npm (skips if not)
- Publishes to npm using OIDC authentication
- Creates a GitHub issue if publish fails

### How to Release

1. Create a PR from your feature branch to `main`
2. Bump version in `package.json` (the PR check will remind you if you forget)
3. Merge the PR
4. GitHub Actions automatically publishes to npm

### Key Configuration

In `package.json`:
```json
"publishConfig": {
  "access": "public",
  "provenance": true
}
```

In workflow, uses Node 24 and latest npm for OIDC support:
```yaml
node-version: '24'
env:
  NPM_CONFIG_PROVENANCE: true
```

## Code Style Notes

- No `.js` extensions in imports
- Use `@/` path alias for all internal imports
- Prefer `async/await` over callbacks
- Use Ora spinners for long-running operations
- Error messages should include actionable fix suggestions
