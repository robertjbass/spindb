# TigerBeetle Engine

TigerBeetle is a high-performance financial ledger database written in Zig,
designed for mission-critical safety and performance.

## Platform Support

All 5 platforms:
- darwin-arm64
- darwin-x64
- linux-arm64
- linux-x64
- win32-x64

## Binary Structure

Single binary: `tigerbeetle` (handles both server and REPL client)

## Two-Step Initialization

TigerBeetle requires a format step before starting:

1. **Format**: `tigerbeetle format --cluster=0 --replica=0 --replica-count=1 --development <data-file>`
2. **Start**: `tigerbeetle start --addresses=127.0.0.1:<port> --development <data-file>`

The `--development` flag is always passed since SpinDB is a local dev tool
(relaxes Direct I/O requirements).

## REPL Usage

Connect to a running instance:
```
tigerbeetle repl --cluster=0 --addresses=127.0.0.1:<port>
```

## Version Grouping

Uses xy-format: `0.16.70` groups as `0.16` (like MariaDB/ClickHouse).

## Backup/Restore

Stop-and-copy of the single `0_0.tigerbeetle` data file.
The server must be stopped before backup (the file is exclusively locked).
TigerBeetle is designed for abrupt shutdown (SIGTERM/SIGKILL are safe).

## Key Characteristics

- **Protocol**: Custom binary protocol (not REST, not SQL)
- **Auth**: None
- **Multi-database**: No (single ledger per instance)
- **Health check**: TCP port check + PID (no HTTP endpoint)
- **License**: Apache-2.0
- **Default port**: 3000

## Linux / Docker Note

TigerBeetle uses `io_uring` for I/O on Linux. This works on regular Linux systems
(bare metal, VMs, GitHub Actions runners) but Docker's default seccomp profile blocks
`io_uring_*` syscalls. When running TigerBeetle inside Docker, the container must be
started with `--security-opt seccomp=unconfined`. The `pnpm test:docker` wrapper
handles this automatically. This does not affect macOS or Windows.
