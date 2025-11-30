# SpinDB TODO

## Roadmap

### v1.0 - Core Features (Complete)
- [x] PostgreSQL container management (create, start, stop, delete)
- [x] MySQL/MariaDB engine support
- [x] Backup and restore with version compatibility checking
- [x] Clone containers from connection strings
- [x] Multiple databases per container
- [x] Interactive menu with arrow-key navigation
- [x] Enhanced shells (pgcli, mycli, usql)
- [x] Run SQL files and inline statements
- [x] Logs command with follow and editor options
- [x] Self-update with automatic notifications
- [x] JSON output for scripting (`--json` flags)

### v1.1 - Remote Connections & Secrets
- [ ] **Remote database connections** - Connect to remote databases (not just local containers)
  - `spindb connect --remote "postgresql://user:pass@host:5432/db"`
  - Save remote connections in config for quick access
  - List saved remotes with `spindb remotes list`
- [ ] **Environment variable support** - Use env vars in connection strings
  - `spindb connect --remote "$DATABASE_URL"`
  - `spindb create mydb --from "$PROD_DATABASE_URL"`
- [ ] **Secrets management** - Secure credential storage
  - macOS Keychain integration for storing passwords
  - `spindb secrets set mydb-password`
  - `spindb secrets get mydb-password`
  - Reference secrets in connection strings: `postgresql://user:${secret:mydb-password}@host/db`

### v1.2 - Additional Engines
- [ ] **SQLite support** - Lightweight file-based databases
- [ ] **Redis support** - In-memory data store
- [ ] **MongoDB support** - Document database

### v1.3 - Advanced Features
- [ ] **Database rename** - Rename databases within containers
- [ ] **Container templates** - Save/load container configurations
- [ ] **Scheduled backups** - Cron-like backup scheduling
- [ ] **Import from Docker** - Migrate data from Docker containers

---

## Feature Backlog

### CLI Improvements
- [ ] **Export query results** - `spindb run <container> query.sql --format csv/json --output file`
- [ ] **Run multiple SQL files** - `spindb run <container> schema.sql seed.sql`
- [ ] **Health checks** - Periodic connection tests for container status

### Security (Pro)
- [ ] **Password authentication** - Set passwords on container creation
- [ ] **Encrypted backups** - GPG/OpenSSL encryption for dumps
- [ ] **User management** - Custom users with specific privileges

### Team Features (Pro)
- [ ] **Shared configs** - Export/import container configs
- [ ] **Config profiles** - Dev/staging/test environment profiles
- [ ] **Cloud backup sync** - S3/GCS/Azure backup storage

### Platform Support
- [ ] **Windows support** - Requires alternative binary source (zonky.io is macOS/Linux only)
- [ ] **Offline mode** - Bundle binaries for air-gapped environments

---

## Distribution

### Homebrew Binary

Distribute SpinDB as a standalone binary (no Node.js dependency) via Homebrew tap.

**Build:** `bun build ./cli/bin.ts --compile --outfile dist/spindb`

**Install:**
```bash
brew tap robertjbass/tap
brew install spindb
```

**Platforms:**
- darwin-arm64 (Apple Silicon)
- darwin-x64 (Intel Mac)
- linux-x64

See `.github/workflows/release.yml` for CI build configuration.

---

## Desktop GUI (Separate Repository)

**Framework:** Tauri v2 (Rust + React)
**Architecture:** GUI shells out to `spindb` CLI commands

### Features
- System tray with running container status
- Start/stop/delete containers
- Create new containers
- View connection strings
- Auto-updates and launch on startup (opt-in)

---

## Known Limitations

- **No Windows support** - zonky.io doesn't provide Windows PostgreSQL binaries
- **Client tools required** - psql/pg_dump and mysql/mysqldump must be installed separately
- **Local only (currently)** - Binds to 127.0.0.1; remote connections planned for v1.1
- **MySQL uses system binaries** - Unlike PostgreSQL, MySQL requires system installation

---

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

---

## Testing

### Run Tests
```bash
pnpm test           # All tests (unit + integration)
pnpm test:unit      # Unit tests only
pnpm test:pg        # PostgreSQL integration
pnpm test:mysql     # MySQL integration
```

### Test Ports
- PostgreSQL: 5454-5456
- MySQL: 3333-3335

### Test Coverage
- **Unit tests:** 141 tests covering validation, error handling, version compatibility
- **Integration tests:** 28 tests (14 PostgreSQL + 14 MySQL) covering full container lifecycle

---

## Monetization Strategy

Similar to ngrok - free tier for individuals, paid tiers for power users and teams.

| Tier | Price | Features |
|------|-------|----------|
| **Free** | $0 | Full local dev, unlimited containers, backup/restore |
| **Pro** | TBD | Password auth, encrypted backups, scheduled backups |
| **Team** | TBD | Shared configs, cloud sync, priority support |
