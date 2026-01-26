# SpinDB Cheatsheet

Quick reference for all commands. For detailed examples, see [EXAMPLES.md](EXAMPLES.md).

## Container Lifecycle

```bash
spindb create mydb                      # Create PostgreSQL (default)
spindb create mydb -e mysql             # Create MySQL
spindb create mydb -e mariadb           # Create MariaDB
spindb create mydb -e sqlite            # Create SQLite
spindb create mydb -e duckdb            # Create DuckDB
spindb create mydb -e mongodb           # Create MongoDB
spindb create mydb -e ferretdb          # Create FerretDB
spindb create mydb -e redis             # Create Redis
spindb create mydb -e valkey            # Create Valkey
spindb create mydb -e clickhouse        # Create ClickHouse
spindb create mydb -e qdrant            # Create Qdrant
spindb create mydb -e meilisearch       # Create Meilisearch
spindb create mydb -e couchdb           # Create CouchDB
spindb create mydb -e cockroachdb       # Create CockroachDB
spindb create mydb -e surrealdb         # Create SurrealDB
spindb create mydb --db-version 17      # Specific version
spindb create mydb --start              # Create and start
spindb create mydb --from backup.sql    # Create from backup

spindb start mydb                       # Start container
spindb stop mydb                        # Stop container
spindb stop --all                       # Stop all containers
spindb delete mydb -f                   # Force delete (stops if running, skips prompt)
spindb list                             # List all containers
spindb info mydb                        # Show container details
```

## Connect & Query

```bash
spindb connect mydb                     # Open database shell
spindb connect mydb -d otherdb          # Connect to specific database
spindb connect mydb --pgcli             # Use pgcli (PostgreSQL/CockroachDB)
spindb connect mydb --mycli             # Use mycli (MySQL/MariaDB)
spindb connect mydb --litecli           # Use litecli (SQLite)
spindb connect mydb --iredis            # Use iredis (Redis/Valkey)

spindb run mydb -c "SELECT 1"           # Run inline SQL/JS/command
spindb run mydb ./schema.sql            # Run SQL file
spindb run mydb -d analytics ./init.sql # Run on specific database
spindb run myredis -c "SET foo bar"     # Run Redis command
spindb run mych -c "SELECT 1"           # Run ClickHouse SQL
spindb run mycrdb -c "SELECT 1"         # Run CockroachDB SQL
spindb run mysurreal -c "SELECT * FROM users"  # Run SurrealQL
```

> **REST API Engines:** Qdrant, Meilisearch, and CouchDB use REST APIs instead of CLI shells.
> `spindb connect` opens their web dashboards in your browser. `spindb run` is not available for these engines.

## Connection Strings

```bash
spindb url mydb                         # Print connection string
spindb url mydb --copy                  # Copy to clipboard
spindb url mydb -d analytics            # URL for specific database
spindb url mydb --json                  # JSON with host/port/user details
```

## Backup & Restore

```bash
spindb backup mydb                      # Backup (default format)
spindb backup mydb --format sql         # Plain SQL backup
spindb backup mydb --format custom      # PostgreSQL custom format
spindb backup mydb -o ~/backups         # Custom output directory
spindb backup mydb -d analytics         # Backup specific database

spindb backups                          # List backups in current directory
spindb backups --all                    # Include ~/.spindb/backups
spindb backups ./data --limit 50        # List backups in specific directory

spindb restore mydb ./backup.sql        # Restore from file
spindb restore mydb ./backup.dump -f    # Force overwrite

# Restore from remote database (all engines supported)
spindb restore mydb --from-url "postgresql://user:pass@host:5432/db"
spindb restore mydb --from-url "mysql://root:pass@host:3306/db"
spindb restore mydb --from-url "mongodb://user:pass@host:27017/db"
spindb restore mydb --from-url "redis://:password@host:6379/0"
spindb restore mydb --from-url "clickhouse://default:pass@host:8123/db"
spindb restore mydb --from-url "http://host:6333?api_key=KEY"  # Qdrant
spindb restore mydb --from-url "http://host:7700?api_key=KEY"  # Meilisearch
spindb restore mydb --from-url "http://user:pass@host:5984/db" # CouchDB
spindb restore mydb --from-url "postgresql://root@host:26257/db?sslmode=disable"  # CockroachDB
spindb restore mydb --from-url "ws://root:root@host:8000/ns/db"  # SurrealDB
```

## Clone

```bash
spindb stop mydb                        # Must stop first
spindb clone mydb mydb-copy             # Clone container
spindb start mydb-copy                  # Start on new port
```

## Database Tracking

SpinDB tracks which databases exist within each container. Use these commands to keep tracking in sync after external changes (e.g., SQL renames, scripts that create/drop databases).

```bash
spindb databases list mydb              # List tracked databases
spindb databases add mydb analytics     # Add database to tracking
spindb databases remove mydb old_backup # Remove from tracking
spindb databases sync mydb old new      # Sync after rename (remove old, add new)

# JSON output for scripting
spindb databases list mydb --json
spindb databases add mydb newdb --json
```

> **Note:** These commands only update SpinDB's tracking. They do NOT create or drop actual databases. Use `spindb run` for that.

## Edit & Configure

```bash
spindb edit mydb -n newname             # Rename container
spindb edit mydb -p 5555                # Change port
spindb edit mydb --set-config max_connections=500  # PostgreSQL config

# SQLite only
spindb edit mydb --relocate ./data/     # Move database file
```

## Logs

```bash
spindb logs mydb                        # Last 50 lines
spindb logs mydb -n 200                 # Last 200 lines
spindb logs mydb -f                     # Follow (tail -f)
spindb logs mydb --editor               # Open in $EDITOR
```

## Engine Management

```bash
spindb engines list                     # List downloaded engines
spindb engines download postgresql 18   # Download specific version
spindb engines delete postgresql 17     # Delete engine version
spindb deps check                       # Check required tools
spindb deps install                     # Install missing tools
```

## Doctor

```bash
spindb doctor                           # Interactive health check
spindb doctor --fix                     # Auto-fix all issues
spindb doctor --dry-run                 # Preview fixes without applying
spindb doctor --json                    # JSON output for scripting
```

**Checks performed:**
- Configuration validity and stale binary cache
- Container status across all engines
- SQLite/DuckDB registry orphaned entries
- Database tool availability
- Outdated container versions (updates config, removes unused binaries)
- Orphaned test container directories

## Default Ports

| Engine      | Default | Range         | Notes |
|-------------|---------|---------------|-------|
| PostgreSQL  | 5432    | 5432-5500     | |
| MySQL       | 3306    | 3306-3400     | |
| MariaDB     | 3307    | 3307-3400     | |
| MongoDB     | 27017   | 27017-27100   | Shared with FerretDB |
| FerretDB    | 27017   | 27017-27100   | Shared with MongoDB |
| Redis       | 6379    | 6379-6400     | Shared with Valkey |
| Valkey      | 6379    | 6379-6479     | Shared with Redis |
| ClickHouse  | 9000    | 9000-9100     | HTTP UI on 8123 |
| Qdrant      | 6333    | 6333-6400     | gRPC on port+1 |
| Meilisearch | 7700    | 7700-7800     | |
| CouchDB     | 5984    | 5984-6000     | Fauxton UI included |
| CockroachDB | 26257   | 26257-26357   | HTTP UI on port+1 |
| SurrealDB   | 8000    | 8000-8100     | HTTP/WebSocket |
| SQLite      | N/A     | File-based    | |
| DuckDB      | N/A     | File-based    | |

> **Port Conflicts:** FerretDB/MongoDB and Redis/Valkey share default ports. Use different ports if running both concurrently.

## Connection String Formats

```
PostgreSQL:  postgresql://postgres@127.0.0.1:5432/mydb
MySQL:       mysql://root@127.0.0.1:3306/mydb
MariaDB:     mysql://root@127.0.0.1:3307/mydb
MongoDB:     mongodb://127.0.0.1:27017/mydb
FerretDB:    mongodb://127.0.0.1:27017/mydb
Redis:       redis://127.0.0.1:6379/0
Valkey:      redis://127.0.0.1:6379/0
ClickHouse:  clickhouse://default@127.0.0.1:9000/default
Qdrant:      http://127.0.0.1:6333
Meilisearch: http://127.0.0.1:7700
CouchDB:     http://admin:admin@127.0.0.1:5984/mydb
CockroachDB: postgresql://root@127.0.0.1:26257/defaultdb?sslmode=disable
SurrealDB:   ws://root:root@127.0.0.1:8000/test/test
SQLite:      sqlite:///path/to/file.sqlite
DuckDB:      duckdb:///path/to/file.duckdb
```

> **CockroachDB:** Uses PostgreSQL wire protocol. Add `?sslmode=disable` for local insecure connections.
> **SurrealDB:** Format is `ws://user:pass@host:port/namespace/database`. Defaults: root/root, test/test.
> **CouchDB:** Default credentials are admin/admin.

## JSON Output (for scripting)

Most commands support `--json` / `-j` for machine-readable output:

```bash
spindb list --json
spindb create mydb --json
spindb url mydb --json
spindb backup mydb --json
spindb backups --json
```

## Common Workflows

```bash
# Dev database setup
spindb create dev-db --start && spindb run dev-db ./schema.sql

# Test with clone
spindb stop prod && spindb clone prod test && spindb start test

# Quick backup before changes
spindb backup mydb --format sql -o ~/backups

# Reset database
spindb delete mydb -f && spindb create mydb --start
```
