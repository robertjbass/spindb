# Contributing to SpinDB

## Development Setup

See [CLAUDE.md](CLAUDE.md) for architecture documentation and development guidelines.

## Pull Request Requirements

All PRs must:

1. **Target the `dev` branch** (not `main`)
2. **Pass the linter:** `pnpm lint`
3. **Be formatted with Prettier:** `pnpm format`

Please run both commands before opening a PR.

## Running Tests

```bash
pnpm test              # All tests (unit + integration)
pnpm test:unit         # Unit tests only
pnpm test:engine       # All integration tests
pnpm test:engine pg    # PostgreSQL integration (aliases: postgres, postgresql)
pnpm test:engine mysql # MySQL integration
pnpm test:engine mongo # MongoDB integration (alias: mongodb)
pnpm test:engine --help # Show all available engines and aliases
```

### Why `--test-concurrency=1`?

All test scripts use `--test-concurrency=1` to disable Node's test runner worker threads. This prevents a serialization bug in Node 22's test runner on macOS where worker thread IPC fails with "Unable to deserialize cloned data due to invalid or unsupported version."

Running tests sequentially is slightly slower but ensures reliable cross-platform CI.

### Test Ports

- PostgreSQL: 5454-5456
- MySQL: 3333-3335

### Test Coverage

- **Unit tests:** 381 tests covering validation, error handling, version compatibility, SQLite registry, relocation
- **Integration tests:** 14 PostgreSQL + 14 MySQL + 10 SQLite covering full container lifecycle
- **CLI E2E tests:** 38 tests covering full command workflows (create, list, start, stop, backup, restore, clone, delete)

## Silent Catch Blocks (By Design)

These catch blocks intentionally suppress errors because they handle expected failure scenarios:

| Location | Purpose |
|----------|---------|
| `mysql/binary-detection.ts:71,87` | Version/MariaDB detection probes |
| `mysql/binary-detection.ts:231,261,278,295,312` | Package manager detection |
| `mysql/index.ts:315` | MySQL readiness probe loop |
| `mysql/index.ts:356` | MySQL ping check (no PID file) |
| `cli/commands/list.ts:28` | Database size fetch (container not running) |
| `postgresql/binary-urls.ts:75` | Maven version fetch (fallback to hardcoded) |
| `cli/index.ts:78,88` | Update check notification (non-critical) |

## Desktop GUI (Separate Repository)

**Framework:** Tauri v2 (Rust + React)
**Architecture:** GUI shells out to `spindb` CLI commands

### Features
- System tray with running container status
- Start/stop/delete containers
- Create new containers
- View connection strings
- Auto-updates and launch on startup (opt-in)
