# Binary Distribution Plans

This document explores potential future work to provide downloadable binaries for database engines that currently require system installation.

## Current State

| Engine | Binary Source | Multi-Version | Status |
|--------|--------------|---------------|--------|
| PostgreSQL | zonky.io / EDB | Yes (14-18) | Implemented |
| MySQL | System (Homebrew/apt) | No | System-only |
| MongoDB | System (Homebrew/apt) | No | System-only |
| Redis | System (Homebrew/apt) | No | System-only |
| SQLite | System / bundled | N/A | File-based |

---

## Redis

### Why Redis is the Best Candidate

Redis is the most viable candidate for downloadable binaries because:

1. **Trivial compilation** - No dependencies beyond GCC and libc
2. **Simple build** - Just `make` in the source directory
3. **Small binaries** - ~7-9 MB per platform (vs PostgreSQL's ~45 MB, MongoDB's ~300-500 MB)
4. **Cross-platform** - Compiles on Linux, macOS, BSD; Windows via community ports

### Proof of Concept Exists

[coney/redis-executable](https://github.com/coney/redis-executable) already hosts Redis binaries on Maven Central, proving the distribution model works. However, it's:
- Outdated (Redis 5.0.10, last updated July 2021)
- x64 only (no ARM64/Apple Silicon)
- Unmaintained (4 commits total)

### Proposed Approach

Create a new project (or fork coney/redis-executable) that:

1. **Compiles Redis for all platforms:**
   - `linux-x64`
   - `linux-arm64`
   - `darwin-x64`
   - `darwin-arm64`
   - `windows-x64` (using [redis-windows](https://github.com/redis-windows/redis-windows) or compile via MSYS2)

2. **Supports multiple versions:**
   - Redis 7.x (current stable)
   - Redis 8.x (latest)
   - Optionally Redis 6.x (legacy)

3. **Hosts on Maven Central:**
   - Follow zonky.io's model for discoverability
   - Artifact naming: `io.spindb:redis-binaries-{platform}:{version}`

4. **Automates via GitHub Actions:**
   - Trigger on new Redis releases
   - Cross-compile or use platform-specific runners
   - Publish to Maven Central automatically

### Storage Estimate

| Component | Size |
|-----------|------|
| Per platform | ~10 MB |
| Platforms | 5 |
| Versions | 3 |
| **Total** | **~150 MB** |

This is very manageable compared to MongoDB (~1.5 GB for equivalent coverage).

### Implementation Steps

1. Create `spindb-redis-binaries` repository
2. Set up GitHub Actions matrix build:
   ```yaml
   strategy:
     matrix:
       os: [ubuntu-latest, ubuntu-24.04-arm, macos-latest, macos-13, windows-latest]
       redis-version: ['7.4.1', '8.0.0']
   ```
3. Build script:
   ```bash
   curl -O https://download.redis.io/releases/redis-${VERSION}.tar.gz
   tar xzf redis-${VERSION}.tar.gz
   cd redis-${VERSION}
   make
   strip src/redis-server src/redis-cli
   tar czf redis-${VERSION}-${PLATFORM}.tar.gz -C src redis-server redis-cli
   ```
4. Publish to Maven Central or GitHub Releases
5. Update SpinDB to download from new source

### Benefits

- **Multi-version support** - Run Redis 7.x and 8.x side-by-side
- **No Homebrew/apt dependency** - Works on minimal systems
- **Faster CI** - No need to install Redis via package manager
- **Consistent versions** - Same Redis version across all dev machines

---

## MySQL

### The MariaDB4j Situation

[MariaDB4j](https://github.com/MariaDB4j/MariaDB4j) provides embedded MariaDB binaries on Maven Central, but has significant limitations:

| Issue | Details |
|-------|---------|
| **Outdated** | Latest binaries: MariaDB 10.2.11 (from 2018) |
| **No ARM64** | Only `mac64` (Intel) artifacts exist |
| **Java-only** | Binaries packaged in JARs, not directly downloadable |
| **MariaDB ≠ MySQL** | Mostly compatible, but not identical |

### Proposed Approach: Fork and Extend

Rather than starting from scratch, fork MariaDB4j and modernize it:

1. **Update to current MariaDB versions:**
   - MariaDB 10.11 LTS (current)
   - MariaDB 11.x (latest)

2. **Add Apple Silicon support:**
   - Compile `darwin-arm64` binaries
   - Update artifact naming: `mariaDB4j-db-mac-arm64`

3. **Consider direct binary distribution:**
   - Extract binaries from JARs for non-Java consumers
   - Or publish `.tar.gz` alongside JARs

4. **Automate builds:**
   - GitHub Actions for all platforms
   - Trigger on new MariaDB releases

### Compilation Complexity

MariaDB is more complex to compile than Redis:

```bash
# Dependencies (macOS)
brew install cmake openssl bison

# Build
cmake . -DWITH_SSL=system
make -j$(nproc)
```

But GitHub Actions runners have these dependencies available.

### Platform Matrix

| Artifact | Status | Action Needed |
|----------|--------|---------------|
| `mariaDB4j-db-linux64` | Exists (10.2.11) | Update to 10.11/11.x |
| `mariaDB4j-db-linux-arm64` | Missing | Add |
| `mariaDB4j-db-mac64` | Exists (10.2.11) | Update to 10.11/11.x |
| `mariaDB4j-db-mac-arm64` | Missing | Add |
| `mariaDB4j-db-win64` | Exists (10.2.11) | Update to 10.11/11.x |

### Alternative: MySQL Community Server

Instead of MariaDB, compile actual MySQL:

- **Pro:** True MySQL compatibility
- **Con:** Oracle's licensing is more restrictive
- **Con:** Build process is more complex

MariaDB is likely the better path given its permissive licensing and MariaDB4j's existing infrastructure.

### Implementation Steps

1. Fork [MariaDB4j](https://github.com/MariaDB4j/MariaDB4j)
2. Update build scripts for current MariaDB versions
3. Add ARM64 build targets to CI
4. Test on Apple Silicon
5. Publish updated artifacts to Maven Central
6. Update SpinDB to use new artifacts (extract from JAR or direct download)

### Storage Estimate

MariaDB binaries are larger than Redis:

| Component | Size |
|-----------|------|
| Per platform | ~80-100 MB |
| Platforms | 5 |
| Versions | 2 |
| **Total** | **~800 MB - 1 GB** |

Still manageable, but significantly more than Redis.

---

## MongoDB

### Why MongoDB is Harder

[mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server) proves that downloading MongoDB binaries is possible (from `fastdl.mongodb.org`), but:

1. **Large binaries** - ~300-500 MB per platform
2. **Complex URLs** - Platform-specific download paths vary significantly
3. **No need to compile** - Official binaries exist, just large

### Potential Approach

Rather than compiling, SpinDB could:

1. Download official binaries from `fastdl.mongodb.org` on-demand
2. Cache in `~/.spindb/bin/mongodb-{version}-{platform}/`
3. Accept the ~500 MB download per version

This is similar to how `mongodb-memory-server` works, but:
- Downloads only `mongod` (not full server package)
- Caches across all SpinDB containers
- Reuses existing system `mongosh` for client access

### Storage Estimate

| Component | Size |
|-----------|------|
| Per platform | ~300-500 MB |
| Platforms | 5 |
| Versions | 3 |
| **Total** | **~4.5-7.5 GB** |

This is substantial and may not be practical for most users.

---

## Priority Order

Based on feasibility and user impact:

| Priority | Engine | Effort | Impact |
|----------|--------|--------|--------|
| 1 | **Redis** | Low | High - Simple to compile, small binaries |
| 2 | **MySQL/MariaDB** | Medium | Medium - Fork exists, needs updates |
| 3 | **MongoDB** | Low (download) | Low - Large binaries, users have it installed |

---

## References

- [zonky.io embedded-postgres-binaries](https://github.com/zonkyio/embedded-postgres-binaries) - Model to follow
- [coney/redis-executable](https://github.com/coney/redis-executable) - Redis proof of concept
- [MariaDB4j](https://github.com/MariaDB4j/MariaDB4j) - Existing MariaDB infrastructure
- [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server) - MongoDB download approach
- [redis-windows](https://github.com/redis-windows/redis-windows) - Windows Redis builds
- [Redis source](https://download.redis.io/releases/) - Official Redis downloads
