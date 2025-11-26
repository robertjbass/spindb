# SpinDB TODO

## Monetization Ideas

Similar to ngrok - free tier for individual developers with core functionality, paid tiers for power users and teams.

- **Free**: Full local dev experience, unlimited containers, basic backup/restore
- **Pro** ($X/month): Security features, multi-engine support, advanced features
- **Team** ($X/user/month): Shared configs, team collaboration, priority support

## Free Features

### High Priority
- [ ] **Run SQL file** - Add menu option to run a `.sql` file against a container (wrapper around `psql -f`)
- [ ] **Backup command** - Add `spindb backup` to create dumps using `pg_dump`
- [ ] **Logs command** - Add `spindb logs <container>` to tail `postgres.log`
- [x] **Engine/binary management** - Menu to list installed PostgreSQL versions, install new versions, uninstall unused versions (free up disk space)

### Medium Priority
- [x] **Container rename** - Rename a container without cloning/deleting (via Edit menu)
- [ ] **Database rename** - Rename a database within a container (requires stopping container, running `ALTER DATABASE ... RENAME TO ...`, updating config)
- [x] **Export connection string** - Copy connection string to clipboard (via container submenu)
- [ ] **Multiple databases per container** - List/create/delete databases within a container
- [x] **Fetch available versions** - Query Maven Central API to show all available PostgreSQL versions instead of hardcoded list

### Low Priority
- [ ] **SQLite support** - Add SQLite engine
- [ ] **Health checks** - Periodic connection tests to verify containers are responsive
- [ ] **Offline Support** - Package binaries locally for offline installation
- [ ] **Binary caching** - Cache downloaded binaries locally to avoid re-downloading
- [ ] **Binary version management** - List, install, and remove different PostgreSQL versions
- [ ] **Binary verification** - Verify downloaded binaries with checksums
- [ ] **Binary cleanup** - Remove old cached binaries to free up disk space
- [ ] **Binary space monitoring** - Show disk usage of cached binaries
- [ ] **Binary auto-cleanup** - Automatically remove old versions after a retention period

---

## Paid Features (Pro)

### Security
- [ ] **Password support** - Set password on container creation, modify `pg_hba.conf` for password auth
- [ ] **Encrypted backups** - Encrypt dumps with password using gpg/openssl

### Multi-Engine Support
- [ ] **MySQL support** - Add MySQL engine (needs binary source)
- [ ] **MongoDB support** - Add MongoDB engine

### Advanced Features
- [ ] **Container templates** - Save container configs as reusable templates
- [ ] **Import from Docker** - Import data from Docker PostgreSQL containers
- [ ] **Automatic binary updates** - Check for and download newer PostgreSQL versions
- [ ] **Custom superuser name** - Allow changing from default `postgres` user
- [ ] **Scheduled backups** - Cron-like backup scheduling
- [ ] **Cloud backup sync** - Sync backups to S3/GCS/Azure

### Team Features
- [ ] **Shared configs** - Export/import container configs for team sharing
- [ ] **Config profiles** - Dev/staging/test profiles with different settings

---

## Stretch Goals

- [ ] **Terminal-based IDE** - Full TUI (terminal UI) for browsing tables, running queries, viewing results, editing data inline (think `lazygit` but for databases)
  - Potential libraries: [blessed](https://github.com/chjj/blessed), [ink](https://github.com/vadimdemedes/ink), [terminal-kit](https://github.com/cronvel/terminal-kit)
  - Inspiration: `lazygit`, `k9s`, `pgcli`

---

## Known Limitations

- **No Windows support** - zonky.io doesn't provide Windows binaries
- **Client tools required** - psql/pg_dump/pg_restore must be installed separately (not bundled)
- **Local only** - No remote connection support (binds to 127.0.0.1)
