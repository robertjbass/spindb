# New Database Engine Checklist

When adding a new database engine to SpinDB, ensure all of the following features are implemented:

## Core Container Management
- [ ] **Start/stop containers** - Ability to start and stop database containers
- [ ] **Filesystem persistence** - Save database data to the filesystem (especially important for embedded databases like SQLite which live in the project folder)
- [ ] **Port management** - Assign and manage ports, handle port conflicts with auto-increment

## Binary Management
- [ ] **Download versioned binaries** - Download and cache versioned binaries for use in containers
- [ ] **Binary verification** - Verify downloaded binaries with checksums
- [ ] **Offline support** - Support for offline installation with cached binaries

## Backup & Restore
- [ ] **Backup database** - Export as compressed dump, `.sql` file (for SQL databases), or appropriate format (e.g., JSON/JSONB for document databases)
- [ ] **Restore database** - Restore from backup files
- [ ] **Clone from connection string** - Create new container from existing database via `--from` flag

## Connection & Access
- [ ] **Generate connection strings** - Generate and copy connection strings in appropriate format
- [ ] **Enhanced CLI tool integration** - Support enhanced CLI tools if available (e.g., `pgcli` for PostgreSQL, `mycli` for MySQL, `litecli` for SQLite, `iredis` for Redis)
- [ ] **Run script files** - Execute `.sql` or equivalent script files against the database

## Multi-Database Support
- [ ] **List databases** - List all databases within a container
- [ ] **Create databases** - Create new databases within a container
- [ ] **Delete databases** - Delete databases within a container
- [ ] **Database rename** - Rename databases within a container

## Testing
- [ ] **Integration tests** - Full lifecycle tests (create, seed, query, backup, restore, delete)
- [ ] **Test fixtures** - Seed files in `tests/fixtures/{engine}/seeds/`

## Documentation
- [ ] **Update README** - Document engine-specific features and limitations
- [ ] **Update TODO.md** - Track engine-specific tasks and known limitations