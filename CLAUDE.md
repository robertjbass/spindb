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

### Version Mapping
Major versions (14, 15, 16, 17) map to full versions in `src/engines/postgresql/binary-urls.ts`:
```typescript
const VERSION_MAP = {
  '14': '14.15.0',
  '15': '15.10.0',
  '16': '16.6.0',
  '17': '17.2.0'
};
```

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

## Known Limitations

1. **No client tools bundled** - psql/pg_restore must be installed separately
2. **macOS/Linux only** - No Windows support (zonky.io doesn't provide Windows binaries)
3. **No backup command** - pg_dump must be run manually with system tools
4. **No automatic updates** - Binary versions are hardcoded in VERSION_MAP

## Future Improvements (Not Implemented)

- [ ] Add `spindb backup` command (wrapper around pg_dump)
- [ ] Support MySQL/SQLite engines (architecture supports it)
- [ ] Add `spindb logs` command to tail postgres.log
- [ ] Add `spindb exec` for running SQL files
- [ ] Automatic binary version updates
- [ ] Windows support (would need different binary source)

## Code Style Notes

- No `.js` extensions in imports
- Use `@/` path alias for all internal imports
- Prefer `async/await` over callbacks
- Use Ora spinners for long-running operations
- Error messages should include actionable fix suggestions
