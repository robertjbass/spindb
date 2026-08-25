# Testing Strategy

## Overview

SpinDB tests every engine on every supported platform-arch combo in CI.

## CI Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | PR to main, nightly cron, manual dispatch | Lint, unit tests, and full integration tests on all platforms. The nightly run keeps Actions binary caches warm (7-day last-access TTL, 10 GB LRU cap) so release PRs restore hot caches instead of re-downloading, and surfaces platform/registry breakage before release day |
| `publish.yml` | Push to main (merge) | Version check + publish to npm with OIDC |
| `upstream-version-check.yml` | PR to main | Informational: flags newer PostgreSQL major versions |

## Platform Coverage (ci.yml)

Every engine runs on **5 runners**, with darwin-x64 reduced to a smoke set:

| Platform-Arch | Runner | Notes |
|---------------|--------|-------|
| linux-x64 | ubuntu-22.04 | Older glibc (2.35) — catches binary compatibility issues |
| linux-x64 | ubuntu-24.04 | Newer glibc (2.39) — catches library renames (e.g., libaio) |
| linux-arm64 | Docker + QEMU | **Manual/periodic only** — the QEMU smoke job is commented out in ci.yml (too slow under emulation); no PR or nightly run covers linux-arm64 |
| darwin-x64 | macos-15-intel | **Smoke set only**: PostgreSQL + Redis (see below) |
| darwin-arm64 | macos-14 | Apple Silicon |
| win32-x64 | windows-latest | |

**Important:** `macos-14` and `macos-15` are both ARM64 runners. Use `macos-15-intel` for darwin-x64 testing.

### darwin-x64 (Intel Mac) is a smoke set, not a full matrix

Since the 0.64.x cycle, Intel macOS runs only two jobs: **PostgreSQL** (core
lifecycle + bundled client tools) and **Redis** (the canonical dyld-linked
engine — Intel Homebrew lives at `/usr/local` vs `/opt/homebrew` on ARM, the
one genuinely arch-specific macOS code path; see `core/library-env.ts`).

Why: Apple stopped selling Intel Macs in 2023 and macOS Tahoe is the last
Intel release; GitHub's Intel runners exist only until Aug 2027; macOS jobs
share a 5-concurrent-runner pool so the full Intel matrix roughly doubled
macOS queue time; and its ~20 binary caches crowded the repo's 10 GB Actions
cache cap, evicting the Windows caches that protect the slowest jobs.

Binaries for darwin-x64 are still built by hostdb and fully supported at
runtime. Full sunset (hostdb builds, spindb support table, desktop Intel
build) is a coordinated ecosystem decision for when GitHub retires Intel
runners — see the OS Coverage Strategy header in `ci.yml`.

The linux-arm64 QEMU job reuses the Docker E2E image (`tests/docker/Dockerfile`) and `run-e2e.sh` in smoke test mode. It's slow (~30-45 min under emulation), so it is **commented out in ci.yml** — uncomment or run it manually to periodically verify arm64 binaries.

### Exceptions

| Engine | Runners | Reason |
|--------|---------|--------|
| ClickHouse | 3 (no Windows) | No hostdb binary for Windows |
| FerretDB | 3 (no Windows) | postgresql-documentdb has startup issues on Windows |
| Meilisearch | 4 (backup/restore skipped on Windows) | Upstream page size alignment bug |

**Unit tests** run on 3 runners in ci.yml (ubuntu-24.04, macos-14, windows-latest).

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
