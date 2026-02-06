# Testing Strategy

## Overview

SpinDB tests every engine on every supported platform-arch combo in CI.

## CI Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci-fast.yml` | Push to any branch (except main) | Fast feedback: lint + unit tests on Ubuntu |
| `ci.yml` | PR to main, manual dispatch | Full integration tests on all platforms |
| `ci-full.yml` | Manual dispatch, weekly schedule | Same as ci.yml (kept as rollback target) |

## Platform Coverage (ci.yml)

Every engine runs on **5 runners** covering all **5 platform-arch combos**:

| Platform-Arch | Runner | Notes |
|---------------|--------|-------|
| linux-x64 | ubuntu-22.04 | Older glibc (2.35) — catches binary compatibility issues |
| linux-x64 | ubuntu-24.04 | Newer glibc (2.39) — catches library renames (e.g., libaio) |
| linux-arm64 | Docker + QEMU | Smoke test: download, start, one query, stop per engine |
| darwin-x64 | macos-15-intel | Intel macOS (available until Aug 2027) |
| darwin-arm64 | macos-14 | Apple Silicon |
| win32-x64 | windows-latest | |

**Important:** `macos-14` and `macos-15` are both ARM64 runners. Use `macos-15-intel` for darwin-x64 testing.

The linux-arm64 QEMU job reuses the Docker E2E image (`tests/docker/Dockerfile`) and `run-e2e.sh` in smoke test mode. It's slow (~30-45 min under emulation) but runs in parallel with all other jobs.

### Exceptions

| Engine | Runners | Reason |
|--------|---------|--------|
| ClickHouse | 4 (no Windows) | No hostdb binary for Windows |
| FerretDB | 4 (no Windows) | postgresql-documentdb has startup issues on Windows |
| Meilisearch | 5 (backup/restore skipped on Windows) | Upstream page size alignment bug |

**Unit tests** run on 3 runners: ubuntu-24.04, macos-14, windows.

## Test Types

### Unit Tests (`pnpm test:unit`)
- ~1000+ tests, run in ~30s
- No database binaries needed
- Test pure logic: validation, parsing, config management, error handling

### Integration Tests (`pnpm test:engine <engine>`)
- Full container lifecycle with real database processes
- Download binaries, create/start/stop/delete containers
- Backup/restore, rename, clone operations
- Reserved test ports to avoid conflicts

### CLI E2E Tests (`pnpm test:cli`)
- Test CLI commands end-to-end via subprocess
- Uses PostgreSQL + SQLite as representative engines

### Docker E2E Tests (`pnpm test:docker`)
- Verify hostdb binaries work on minimal Linux (Ubuntu 22.04)
- Catches library dependency issues
- Supports `--group` flag for parallel execution: `sql`, `nosql`, `rest`

## Test Port Allocation

Integration tests use reserved ports to avoid conflicts with user databases:
- PostgreSQL: 5454-5456
- MySQL: 3333-3335
- Redis: 6399-6401
- See `tests/integration/helpers.ts` for full port map
