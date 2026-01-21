# SpinDB Cheatsheet

Quick reference for all commands. For detailed examples, see [EXAMPLES.md](EXAMPLES.md).

## Container Lifecycle

```bash
spindb create mydb                      # Create PostgreSQL (default)
spindb create mydb -e mysql             # Create MySQL
spindb create mydb -e sqlite            # Create SQLite
spindb create mydb -e mongodb           # Create MongoDB
spindb create mydb -e redis             # Create Redis
spindb create mydb -e valkey            # Create Valkey
spindb create mydb -e clickhouse        # Create ClickHouse
spindb create mydb --db-version 17      # Specific version
spindb create mydb --start              # Create and start
spindb create mydb --from backup.sql    # Create from backup

spindb start mydb                       # Start container
spindb stop mydb                        # Stop container
spindb stop --all                       # Stop all containers
spindb delete mydb -f -y                # Force delete without prompt
spindb list                             # List all containers
spindb info mydb                        # Show container details
```

## Connect & Query

```bash
spindb connect mydb                     # Open database shell
spindb connect mydb -d otherdb          # Connect to specific database
spindb connect mydb --pgcli             # Use pgcli (PostgreSQL)
spindb connect mydb --mycli             # Use mycli (MySQL)
spindb connect mydb --litecli           # Use litecli (SQLite)
spindb connect mydb --iredis            # Use iredis (Redis)

spindb run mydb -c "SELECT 1"           # Run inline SQL/JS/command
spindb run mydb ./schema.sql            # Run SQL file
spindb run mydb -d analytics ./init.sql # Run on specific database
spindb run myredis -c "SET foo bar"     # Run Redis command
spindb run mych -c "SELECT 1"           # Run ClickHouse SQL
```

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
```

## Clone

```bash
spindb stop mydb                        # Must stop first
spindb clone mydb mydb-copy             # Clone container
spindb start mydb-copy                  # Start on new port
```

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

## Default Ports

| Engine     | Default | Range         |
|------------|---------|---------------|
| PostgreSQL | 5432    | 5432-5500     |
| MySQL      | 3306    | 3306-3400     |
| MariaDB    | 3307    | 3307-3400     |
| MongoDB    | 27017   | 27017-27100   |
| Redis      | 6379    | 6379-6400     |
| Valkey     | 6379    | 6379-6479     |
| ClickHouse | 9000    | 9000-9100     |
| SQLite     | N/A     | File-based    |

## Connection String Formats

```
PostgreSQL: postgresql://postgres@127.0.0.1:5432/mydb
MySQL:      mysql://root@127.0.0.1:3306/mydb
MariaDB:    mysql://root@127.0.0.1:3307/mydb
MongoDB:    mongodb://127.0.0.1:27017/mydb
Redis:      redis://127.0.0.1:6379/0
Valkey:     redis://127.0.0.1:6379/0
ClickHouse: clickhouse://default@127.0.0.1:9000/default
SQLite:     sqlite:///path/to/file.sqlite
```

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
spindb delete mydb -f -y && spindb create mydb --start
```
