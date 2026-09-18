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
| linux-arm64 | `ubuntu-24.04-arm` + Docker | **Native arm64, runs on every PR and the nightly cron** (no emulation since the 0.70.x cycle). Full engine set, same image and timeouts as the x64 Docker job. Not in `CI Success` yet, so it reports but cannot block a release - read it explicitly on hostdb bumps |
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

### linux-arm64 runs natively, not under QEMU

The `Docker Linux ARM64` job reuses the Docker E2E image (`tests/docker/Dockerfile`) and `run-e2e.sh` in smoke test mode, exactly like the x64 leg, on GitHub's hosted native arm64 runner (`ubuntu-24.04-arm`, free for public repositories). Because it is real hardware rather than emulation it runs on every PR and on the nightly cron with no special timeouts and no skipped engines.

It replaced a QEMU-emulated, dispatch-only version of the same job that **failed every dispatch it ever had**: TigerBeetle requires io_uring and QEMU user-mode emulation does not implement io_uring at all (`error(io): io_uring is not available ... SystemOutdated`). 16 of 17 engines passed, the job was permanently red, and a hostdb bump shipped against it. Emulation also forced SurrealDB and ClickHouse to be skipped and the startup timeouts inflated roughly 5x; none of that is needed now.

Two details that matter if you touch this job:

- **It stays inside Docker.** The container is the test environment, not an emulation wrapper: a minimal Ubuntu 22.04 with no preinstalled database tooling, pinned to 22.04 because hostdb's PostgreSQL binaries link against ICU 70 and 24.04 ships the ABI-incompatible ICU 74. Inside the container the runner's own distro is irrelevant, so the arm64 and x64 legs differ by architecture only. The build is a plain `docker build` (no buildx, no binfmt, no `--platform`) because the runner is natively arm64.
- **`--security-opt seccomp=unconfined` is still required**, identically to the x64 Docker job. Docker's default seccomp profile does not allow the io_uring syscalls, which is a container policy question rather than an architecture one; the arm64 runner's kernel supports io_uring natively.

It is deliberately not in the `CI Success` needs list yet, because the job has no green history to stand on. Promote it (needs + names + results in `ci-success`) once it has proven itself, and check it by name on hostdb bumps until then, since linux-arm64 risk lives in hostdb binaries rather than spindb code.

### Exceptions

| Engine | Runners | Reason |
|--------|---------|--------|
| ClickHouse | 3 (no Windows) | No hostdb binary for Windows |
| FerretDB | 3 (no Windows) | postgresql-documentdb has startup issues on Windows |
| Meilisearch | 4 (backup/restore skipped on Windows) | Upstream page size alignment bug |
| QuestDB | 3 blocking + Windows weekly | Slowest job in the matrix (JVM cold start per test on the slowest runner class) |
| FerretDB v1 | 3 blocking + Windows weekly | Second slowest (full PostgreSQL backend behind the proxy) |

QuestDB and FerretDB v1 are the **only** two engines whose Windows leg is off
the blocking path. It runs weekly instead, from
`.github/workflows/weekly-windows-engines.yml` (Mondays 07:23 UTC plus manual
dispatch), because those two dominated PR wall-clock time and neither has ever
failed Windows-specifically. Every other Windows engine job stays blocking, and
that is not a formality: the DuckDB Windows job caught a real data-correctness
bug the day before the split (C-142 - an open DuckDB file is locked exclusively
on Windows, so the branch copy failed with EBUSY where POSIX succeeded). Widen
the split only for a job that is both slow and has never found anything.

Because scheduled workflows run only from the default branch, the weekly run
tests `main`, not `dev`. A failure shows red in the Actions tab; there is no
alerting wiring.

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
