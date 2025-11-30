# New Database Engine Checklist

When adding a new database engine to SpinDB, ALL features below must be implemented before the engine is considered complete.

## Engine Implementation

### Core Files Required
- [ ] `engines/{engine}/index.ts` - Main engine class extending `BaseEngine`
- [ ] `engines/{engine}/backup.ts` - Backup creation wrapper
- [ ] `engines/{engine}/restore.ts` - Backup detection and restore logic
- [ ] `engines/{engine}/version-validator.ts` - Version parsing and compatibility
- [ ] `engines/{engine}/binary-manager.ts` OR `binary-detection.ts` - Binary management

### BaseEngine Abstract Methods
Every engine must implement these methods from `engines/base-engine.ts`:

```typescript
abstract name: string                    // e.g., 'postgresql', 'mysql', 'sqlite'
abstract displayName: string             // e.g., 'PostgreSQL', 'MySQL', 'SQLite'
abstract supportedVersions: string[]     // e.g., ['14', '15', '16', '17']
abstract defaultPort: number             // e.g., 5432, 3306, 0 (for file-based)
abstract defaultUser: string             // e.g., 'postgres', 'root'

abstract start(container: ContainerConfig): Promise<void>
abstract stop(container: ContainerConfig): Promise<void>
abstract isRunning(container: ContainerConfig): Promise<boolean>
abstract initDataDir(name: string, version: string, options: InitOptions): Promise<void>
abstract getConnectionString(container: ContainerConfig, database?: string): string
abstract createDatabase(container: ContainerConfig, database: string): Promise<void>
abstract deleteDatabase(container: ContainerConfig, database: string): Promise<void>
abstract listDatabases(container: ContainerConfig): Promise<string[]>
abstract runScript(container: ContainerConfig, script: string, options?: RunScriptOptions): Promise<string>
abstract backup(container: ContainerConfig, options: BackupOptions): Promise<string>
abstract restore(container: ContainerConfig, backupPath: string, options?: RestoreOptions): Promise<void>
abstract getLogPath(containerName: string): string
```

---

## CLI Commands Support

Each engine must work with ALL existing CLI commands:

### Container Lifecycle
- [ ] `spindb create [name] --engine {engine}` - Create container
- [ ] `spindb start [name]` - Start container
- [ ] `spindb stop [name]` - Stop container
- [ ] `spindb delete [name]` - Delete container
- [ ] `spindb list` - Show in container list with correct icon
- [ ] `spindb info [name]` - Show container details

### Data Operations
- [ ] `spindb connect [name]` - Open database shell
- [ ] `spindb connect [name] --{enhanced-cli}` - Enhanced CLI if available (e.g., `--litecli` for SQLite)
- [ ] `spindb run <name> [file]` - Run SQL file
- [ ] `spindb run <name> --sql "..."` - Run inline SQL
- [ ] `spindb url [name]` - Output connection string
- [ ] `spindb url [name] --json` - JSON output with connection details

### Backup & Restore
- [ ] `spindb backup [name]` - Create backup (auto-detect format)
- [ ] `spindb backup [name] --format sql` - Plain SQL backup
- [ ] `spindb backup [name] --format dump` - Compressed/binary backup
- [ ] `spindb restore [name] [backup]` - Restore from backup file
- [ ] `spindb create [name] --from [backup]` - Create with restore
- [ ] `spindb create [name] --from [connection-string]` - Clone from remote

### Container Management
- [ ] `spindb clone [source] [target]` - Clone container
- [ ] `spindb edit [name] --name [newname]` - Rename container
- [ ] `spindb edit [name] --port [port]` - Change port (if applicable)
- [ ] `spindb logs [name]` - View container logs
- [ ] `spindb logs [name] --follow` - Follow logs
- [ ] `spindb logs [name] --editor` - Open in editor

### Engine Management
- [ ] `spindb engines` - Show in engines list
- [ ] `spindb engines delete {engine} [version]` - Delete engine binaries (if downloadable)
- [ ] `spindb deps check --engine {engine}` - Check dependencies
- [ ] `spindb deps install --engine {engine}` - Install dependencies

---

## Interactive Menu Support

- [ ] Engine appears in "Create container" engine selection
- [ ] Container submenu works (start/stop/connect/backup/etc.)
- [ ] "View logs" option works
- [ ] "Run SQL file" option works
- [ ] Enhanced CLI install option if applicable

---

## Multi-Database Support

- [ ] List databases within container
- [ ] Create new databases within container
- [ ] Delete databases within container
- [ ] Target specific database with `-d/--database` flag
- [ ] Track databases in `container.json` (`databases[]` array)

---

## Configuration

### Files to Update
- [ ] `engines/index.ts` - Register engine in `getEngine()` and `getAllEngines()`
- [ ] `config/defaults.ts` - Add engine defaults (port range, superuser, etc.)
- [ ] `config/os-dependencies.ts` - Add required system dependencies
- [ ] `types/index.ts` - Add engine to `Engine` enum

### Container Config Support
```typescript
// container.json must support:
{
  engine: '{engine}',
  version: string,
  port: number,        // 0 for file-based databases
  database: string,
  databases: string[],
  // Engine-specific fields as needed
}
```

---

## Testing

### Required Tests
- [ ] `tests/integration/{engine}.test.ts` - Full lifecycle integration tests
- [ ] `tests/fixtures/{engine}/seeds/sample-db.sql` - Test seed file

### Integration Test Coverage (14 tests minimum)
1. Create container without starting (`--no-start`)
2. Start container
3. Seed database with test data
4. Create from connection string (dump/restore)
5. Verify restored data
6. Stop and delete restored container
7. Modify data using `runScript`
8. Rename container and change port
9. Verify data persists after rename
10. Handle port conflict gracefully
11. Handle start on already running container
12. Handle stop on already stopped container
13. Delete container with `--force`
14. Verify no test containers remain

---

## Documentation

- [ ] Update `README.md` with engine section (like PostgreSQL/MySQL sections)
- [ ] Update `TODO.md` - Check off engine in roadmap
- [ ] Update `CHANGELOG.md` - Add to unreleased section
- [ ] Update `CLAUDE.md` - Add engine-specific notes if needed

---

## Engine-Specific Considerations

### File-Based Databases (SQLite, DuckDB, etc.)
- [ ] Data stored in project directory (CWD), not `~/.spindb/containers/`
- [ ] User specifies file path on create
- [ ] No port management needed (`port: 0`)
- [ ] No start/stop needed (embedded database)
- [ ] Connection string is file path

### Server Databases (PostgreSQL, MySQL, etc.)
- [ ] Data stored in `~/.spindb/containers/{engine}/{name}/`
- [ ] Port management with auto-increment on conflict
- [ ] Process management (start/stop/PID tracking)
- [ ] Log file management

### Binary Management
- [ ] **Downloadable binaries**: Create `binary-manager.ts` (like PostgreSQL)
- [ ] **System binaries**: Create `binary-detection.ts` (like MySQL)

---

## Current Engine Status

### PostgreSQL 🐘
| Feature | Status |
|---------|--------|
| Container lifecycle | ✅ |
| Backup/restore | ✅ |
| Multi-database | ✅ |
| Enhanced CLI (pgcli) | ✅ |
| Integration tests | ✅ |

### MySQL 🐬
| Feature | Status |
|---------|--------|
| Container lifecycle | ✅ |
| Backup/restore | ✅ |
| Multi-database | ✅ |
| Enhanced CLI (mycli) | ✅ |
| Integration tests | ✅ |

### SQLite (Planned)
| Feature | Status |
|---------|--------|
| Container lifecycle | ❌ |
| Backup/restore | ❌ |
| Multi-database | N/A (single file) |
| Enhanced CLI (litecli) | ❌ |
| Integration tests | ❌ |
