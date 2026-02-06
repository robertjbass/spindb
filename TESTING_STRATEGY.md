# Testing Strategy

## Overview

SpinDB uses a tiered CI testing strategy to balance fast feedback with thorough cross-platform coverage.

## CI Workflows

| Workflow | Trigger | Duration | Purpose |
|----------|---------|----------|---------|
| `ci-fast.yml` | Push to any branch (except main) | ~3-5 min | Fast feedback: lint + unit tests on Ubuntu |
| `ci.yml` | PR to main, manual dispatch | ~20-25 min | Tiered OS matrix (see below) |
| `ci-full.yml` | Manual dispatch, weekly schedule | ~30-45 min | Full 5-OS matrix for all engines (rollback target) |

## OS Matrix Tiers (ci.yml)

| Tier | Engines | OS Variants | Rationale |
|------|---------|-------------|-----------|
| **A (full)** | PostgreSQL, MySQL | 5: ubuntu-22.04, ubuntu-24.04, macos-15, macos-14, windows | Most popular, most platform quirks (EDB Windows binaries, libaio) |
| **B (reduced)** | MariaDB, MongoDB, Redis, Valkey, SQLite, DuckDB, CockroachDB | 3: ubuntu-24.04, macos-14, windows | Stable binaries, adequate cross-platform signal |
| **C (minimal)** | ClickHouse, FerretDB | 2: ubuntu-24.04, macos-14 | No Windows support (no hostdb binaries) |
| **C+ (3 OS)** | Qdrant, Meilisearch, CouchDB, SurrealDB, QuestDB | 3: ubuntu-24.04, macos-14, windows | Simpler engines with Windows support |

**Unit tests** run on 3 OS variants: ubuntu-24.04, macos-14, windows.

## Rollback Instructions

If the reduced matrix in `ci.yml` misses a platform-specific regression:

1. Rename `ci-full.yml` back to `ci.yml` (restore full matrix as PR trigger)
2. Delete the current `ci.yml` and `ci-fast.yml`
3. The full 5-OS matrix will run on every PR again

Alternatively, manually dispatch `ci-full.yml` to run the complete matrix on demand.

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
