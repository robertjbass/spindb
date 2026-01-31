# Valkey Engine Implementation

## Overview

Valkey is a Redis-compatible fork maintained by the Linux Foundation. SpinDB downloads Valkey binaries from hostdb and manages them identically to Redis.

## Platform Support

| Platform | Architecture | Status | Notes |
|----------|--------------|--------|-------|
| darwin | x64 | Supported | Uses hostdb binaries |
| darwin | arm64 | Supported | Uses hostdb binaries (Apple Silicon) |
| linux | x64 | Supported | Uses hostdb binaries |
| linux | arm64 | Supported | Uses hostdb binaries |
| win32 | x64 | Supported | **Custom-built binary** (see below) |

### Windows Binary - Custom Build

**There is no official Windows binary for Valkey.** The hostdb Windows binary was **manually built in a Windows VM** specifically for SpinDB. This required:

1. Setting up a Windows development environment
2. Building Valkey from source with Cygwin runtime
3. Packaging the resulting binaries with Cygwin DLLs
4. Uploading to hostdb

This is one of the more unusual workarounds in SpinDB's engine support.

### Cygwin Runtime on Windows

The Windows Valkey binary is built with Cygwin, which means:
- Paths must be converted to Cygwin format
- The binary expects `/cygdrive/c/...` style paths

```typescript
// Path conversion function for Windows
function toCygwinPath(windowsPath: string): string {
  // C:\Users\foo\config.conf -> /cygdrive/c/Users/foo/config.conf
  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\]/)
  if (!driveMatch) return windowsPath.replace(/\\/g, '/')

  const driveLetter = driveMatch[1].toLowerCase()
  const restOfPath = windowsPath.slice(3).replace(/\\/g, '/')
  return `/cygdrive/${driveLetter}/${restOfPath}`
}
```

## Binary Packaging

### Archive Format
- **Unix (macOS/Linux)**: `tar.gz`
- **Windows**: `zip` (contains Cygwin-built binaries)

### Archive Structure
```
valkey/
└── bin/
    ├── valkey-server    # Server binary
    ├── valkey-cli       # Client CLI
    ├── valkey-benchmark # Benchmarking tool
    └── cygwin1.dll      # Cygwin runtime (Windows only)
```

### Version Map Sync

```typescript
export const VALKEY_VERSION_MAP: Record<string, string> = {
  '8': '8.0.6',
  '9': '9.x.x',
}
```

## Implementation Details

### Binary Manager

Valkey uses `BaseBinaryManager` with configuration identical to Redis.

### Version Parsing

- **Version output format**: `Valkey server v=8.0.6 sha=00000000:0 malloc=jemalloc-5.3.0...`
- **Parse pattern**: `/v=(\d+\.\d+\.\d+)/` then fallback to `/(\d+\.\d+\.\d+)/`

### Redis Compatibility

Valkey uses `redis://` connection scheme for client compatibility:

```
redis://127.0.0.1:{port}/{database}
```

Not `valkey://` - this ensures compatibility with existing Redis clients and tools.

### Default Configuration

- **Default Port**: 6379 (same as Redis, auto-increments on conflict)
- **Databases**: 16 numbered databases (0-15)
- **PID File**: `valkey.pid` in container directory
- **Persistence**: RDB snapshots enabled

### Generated Configuration

SpinDB generates `valkey.conf` with Redis-compatible settings:
```
port {port}
bind 127.0.0.1
dir {dataDir}
daemonize yes     # Unix only
logfile {logFile}
pidfile {pidFile}

# Persistence
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb
appendonly no
```

### Windows Detached Spawn

Like Redis, Valkey on Windows uses detached spawn:
```typescript
const spawnOpts: SpawnOptions = {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  windowsHide: true,
}
// Convert path to Cygwin format
const cygwinConfigPath = toCygwinPath(configPath)
spawn(valkeyServer, [cygwinConfigPath], spawnOpts)
```

## Backup & Restore

### Backup Formats

| Format | Extension | Tool | Notes |
|--------|-----------|------|-------|
| text | `.valkey` | Custom RESP | Human-readable commands |
| rdb | `.rdb` | Native RDB | Binary snapshot |

Identical to Redis backup formats, with `.valkey` extension for text format.

## Integration Test Notes

### Port Allocation

Valkey tests should avoid conflicting with Redis tests since they share default port 6379.

### Test Fixtures

Located in `tests/fixtures/valkey/seeds/`:
- Key-value pairs for testing

## Docker E2E Test Notes

Valkey Docker E2E tests verify Redis-compatible operations:
- Server lifecycle
- Key-value operations
- Backup/restore
- Database switching

## Known Issues & Gotchas

### 1. Windows Cygwin Paths

**Critical**: The Windows binary expects Cygwin-style paths. Passing Windows paths directly will fail:
```
# Wrong: C:\Users\spindb\valkey.conf
# Right: /cygdrive/c/Users/spindb/valkey.conf
```

### 2. No Official Windows Binary

The Windows support required manual compilation. If issues arise with the Windows binary, it may need to be rebuilt from source in a Windows VM.

### 3. Port Conflict with Redis

Valkey and Redis share default port 6379. SpinDB prevents conflicts via auto-increment.

### 4. iredis Compatibility

The `iredis` enhanced CLI (Python tool) works with Valkey since it's protocol-compatible. The engine detects and supports `iredis` as an alternative to `valkey-cli`.

### 5. Connection Scheme

Despite being Valkey, uses `redis://` scheme:
- `redis://` (plain)
- `rediss://` (TLS)
- `valkey://` / `valkeys://` are also accepted and normalized

## CI/CD Notes

### GitHub Actions Cache Step

```yaml
- name: Cache Valkey binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/valkey-*
    key: valkey-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/valkey/version-maps.ts') }}
```

### Windows CI Considerations

Windows CI tests for Valkey verify the Cygwin-built binary works correctly with path conversion.

## Building Windows Binaries

If you need to rebuild the Windows binary:

1. Set up a Windows VM with Visual Studio Build Tools
2. Install Cygwin with development packages
3. Clone Valkey source
4. Build with: `make`
5. Package `valkey-server.exe`, `valkey-cli.exe`, and required Cygwin DLLs
6. Create zip and upload to hostdb

This is a manual process not automated in CI.
