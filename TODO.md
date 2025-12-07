# SpinDB TODO

## Maintenance

- [ ] Review and update `EVALUATION.md` periodically (last updated: 2025-12-06, v0.9.0)

---

## Roadmap

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

See [ENGINES.md](ENGINES.md) for full engine status and details.

- [ ] Redis (in-memory key-value)
- [ ] MongoDB (document database)
- [ ] MariaDB as standalone engine

### v1.3 - Advanced Features

- [ ] **Database rename** - Rename databases within containers
- [ ] **Container templates** - Save/load container configurations
- [ ] **Scheduled backups** - Cron-like backup scheduling
- [ ] **Import from Docker** - Migrate data from Docker containers

---

## Backlog

### CLI Improvements

- [ ] **Export query results** - `spindb run <container> query.sql --format csv/json --output file`
- [ ] **Run multiple SQL files** - `spindb run <container> schema.sql seed.sql`
- [ ] **Health checks** - Periodic connection tests for container status
- [ ] **Overwrite existing databases on restore** - Add `--force` or `--drop-existing` flag to restore/create commands to drop and recreate tables that already exist (currently fails if tables exist)
- [ ] **Update doctor tool** - Add checks for database file permissions, container health, and engines

### Chained Command Ideas

Combine common multi-step workflows into single commands. These should remain intuitive and not bloat the CLI.

| Proposed Command | Steps Combined | Example |
|------------------|----------------|---------|
| `spindb db create <container> <dbname> [--seed file.sql] [--connect]` | Create database + run seed file + open shell | `spindb db create myapp users --seed schema.sql --connect` |
| `spindb clone <container> <new-name> --start` | Clone container + start it | `spindb clone prod-backup local-test --start` |
| `spindb restore <container> <backup> --start` | Restore backup + start container | `spindb restore mydb backup.dump --start` |
| `spindb backup <container> --stop` | Stop container + create backup | `spindb backup mydb --stop` (for consistent backups) |

**Guidelines:**
- Flags should be additive (each flag adds one step)
- Order of operations should be intuitive (create → seed → start → connect)
- Don't combine conflicting operations
- Keep documentation clear about what each flag does

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

### Distribution

- [ ] **Homebrew binary** - Distribute as standalone binary (no Node.js dependency) via Homebrew tap
  - Build: `bun build ./cli/bin.ts --compile --outfile dist/spindb`
  - Platforms: darwin-arm64, darwin-x64, linux-x64