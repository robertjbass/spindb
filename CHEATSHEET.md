# SpinDB Cheatsheet

Quick reference for all SpinDB commands.

## Container Lifecycle

```bash
spindb create mydb                      # Create PostgreSQL (default)
spindb create mydb -e mysql             # Create MySQL
spindb create mydb -e mariadb           # Create MariaDB
spindb create mydb -e sqlite            # Create SQLite
spindb create mydb -e duckdb            # Create DuckDB
spindb create mydb -e mongodb           # Create MongoDB
spindb create mydb -e ferretdb          # Create FerretDB (v2 on macOS/Linux, v1 on Windows)
spindb create mydb -e ferretdb --db-version 1  # FerretDB v1 (plain PG backend, all platforms)
spindb create mydb -e ferretdb --db-version 2  # FerretDB v2 (DocumentDB backend, macOS/Linux only)
spindb create mydb -e redis             # Create Redis
spindb create mydb -e valkey            # Create Valkey
spindb create mydb -e clickhouse        # Create ClickHouse
spindb create mydb -e qdrant            # Create Qdrant
spindb create mydb -e meilisearch       # Create Meilisearch
spindb create mydb -e couchdb           # Create CouchDB
spindb create mydb -e cockroachdb       # Create CockroachDB
spindb create mydb -e surrealdb         # Create SurrealDB
spindb create mydb -e questdb           # Create QuestDB
spindb create mydb -e typedb            # Create TypeDB
spindb create mydb -e influxdb          # Create InfluxDB
spindb create mydb -e weaviate          # Create Weaviate
spindb create mydb -e tigerbeetle       # Create TigerBeetle
spindb create mydb --db-version 17      # Specific version
spindb create mydb --start              # Create and start
spindb create mydb --from backup.sql    # Create from backup

spindb start mydb                       # Start container
spindb start mydb -f                    # Start (auto-download missing binaries)
spindb stop mydb                        # Stop container
spindb stop --all                       # Stop all containers
spindb delete mydb -f                   # Force delete (stops if running, skips prompt)
spindb list                             # List all containers
spindb info mydb                        # Show container details
spindb ports                            # Show ports for all containers
spindb ports mydb                       # Show ports for one container
spindb ports --running                  # Only running containers
spindb ports --json                     # JSON output
```

## Connect & Query

```bash
spindb connect mydb                     # Open database shell
spindb connect mydb -d otherdb          # Connect to specific database
spindb connect mydb --pgcli             # Use pgcli (PostgreSQL/CockroachDB)
spindb connect mydb --mycli             # Use mycli (MySQL/MariaDB)
spindb connect mydb --litecli           # Use litecli (SQLite)
spindb connect mydb --iredis            # Use iredis (Redis/Valkey)
spindb connect mydb --dblab             # Use dblab visual TUI
spindb connect mydb --install-dblab     # Download dblab + connect
spindb connect mydb --ui                # Open built-in Web UI (DuckDB only)

spindb run mydb -c "SELECT 1"           # Run inline SQL/JS/command
spindb run mydb ./schema.sql            # Run SQL file
spindb run mydb -d analytics ./init.sql # Run on specific database
spindb run myredis -c "SET foo bar"     # Run Redis command
spindb run mych -c "SELECT 1"           # Run ClickHouse SQL
spindb run mycrdb -c "SELECT 1"         # Run CockroachDB SQL
spindb run mysurreal -c "SELECT * FROM users"  # Run SurrealQL
spindb run myquest -c "SELECT * FROM sensors"  # Run QuestDB SQL

# Query with structured output (table or JSON)
spindb query mydb "SELECT * FROM users"                 # Table output
spindb query mydb "SELECT * FROM users" --json          # JSON output
spindb query mydb "SELECT * FROM users" -d analytics    # Specific database
spindb query myferret "users.find({}).sort({id: 1})"    # MongoDB/FerretDB query
spindb query myferret "users.find({age: {\$gt: 25}})" --json  # FerretDB JSON output
```

> **`run` vs `query`:** Use `run` for executing scripts and fire-and-forget commands (migrations, seeds, DDL). Use `query` when you need structured results back — it outputs a formatted table by default, or JSON with `--json`.
>
> **REST API Engines:** Qdrant, Meilisearch, CouchDB, InfluxDB, and Weaviate use REST APIs instead of CLI shells.
> `spindb connect` shows REST API info. Qdrant, Meilisearch, CouchDB, and Weaviate have web dashboards. InfluxDB is API-only (no web UI). `spindb run` is not available for these engines via the interactive menu.

## Web Panels

Some engines have browser-based interfaces available from the console menu (`spindb connect` or interactive menu → Open console).

| Engine | Web Panel | Notes |
|--------|-----------|-------|
| PostgreSQL | pgweb | Downloaded on first use, runs as background process |
| CockroachDB | pgweb | Same pgweb binary, uses PG wire protocol |
| FerretDB | pgweb | Same pgweb binary, connects to PG backend |
| DuckDB | Web UI | Built-in extension at `http://localhost:4213` |
| ClickHouse | Play UI | Built-in at `http://localhost:{http_port}/play` |
| Qdrant | Web UI | Downloaded separately, served by Qdrant |
| Meilisearch | Dashboard | Built-in at `http://localhost:{port}/` |
| CouchDB | Fauxton | Built-in at `http://localhost:{port}/_utils` |
| QuestDB | Web Console | Built-in at `http://localhost:{http_port}/` |

**pgweb** is a standalone web panel for browsing and querying PostgreSQL-compatible databases. It runs as a background process and opens in your browser.

- **Start**: Select "Open pgweb" from the console menu (downloads automatically on first use)
- **Stop**: Select "Stop pgweb" from the container submenu or console menu, or it stops automatically when the database stops
- **Port**: Dynamically allocated starting at 8081

## Link Remote Databases

Link external databases (cloud-hosted or local non-SpinDB instances) to manage through SpinDB.

```bash
# Link by connection string (engine auto-detected from scheme)
spindb link "postgresql://user:pass@ep-cool-123.neon.tech/mydb"
spindb link "mysql://root:pass@db.planetscale.com/mydb"
spindb link "mongodb+srv://user:pass@cluster.mongodb.net/mydb"
spindb link "redis://default:pass@us1-cat.upstash.io:6379"

# Custom name
spindb link "postgresql://user:pass@host/db" production-pg

# Specify engine when scheme is ambiguous (http/https)
spindb link "http://localhost:6333" --engine qdrant

# Override database name
spindb link "postgresql://user:pass@host/db" -d analytics

# JSON output
spindb link "postgresql://user:pass@host/db" --json

# Connect to linked database
spindb connect production-pg

# View connection string
spindb url production-pg               # Redacted (password hidden)
spindb url production-pg --password    # Full connection string

# Unlink (removes local metadata only, remote database not affected)
spindb delete production-pg
```

**Auto-detected providers:** Neon, Supabase, PlanetScale, Upstash, Railway, Aiven, CockroachDB Cloud

**Supported operations:** `connect`, `url`, `info`, `list`, `delete` (unlink), `databases`, `query`

**Not yet supported:** `backup`, `run`, `restore`, `export`, `clone`, `start`, `stop`, `logs`

## Connection Strings

```bash
spindb url mydb                         # Print connection string
spindb url mydb --copy                  # Copy to clipboard
spindb url mydb -d analytics            # URL for specific database
spindb url mydb --json                  # JSON with host/port/user details
spindb url mydb --password              # Full URL with password (remote only)
```

## Find Container

Find which container matches a port or connection URL. Useful for scripting.

```bash
spindb which --port 5432                # Find container on port 5432
spindb which --url "$DATABASE_URL"      # Find container matching URL
spindb which --port 5432 --running      # Only match running containers
spindb which --port 5432 --json         # JSON output for scripting

# Use in scripts to auto-detect container
CONTAINER=$(spindb which --url "$DATABASE_URL")
spindb pull "$CONTAINER" --from-env PROD_DB_URL
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
spindb restore mydb --from-url "postgresql://admin:quest@host:8812/qdb"  # QuestDB
spindb restore mydb --from-url "http://host:8086"                      # InfluxDB
```

## Clone

```bash
spindb stop mydb                        # Must stop first
spindb clone mydb mydb-copy             # Clone container
spindb start mydb-copy                  # Start on new port
```

## Pull (Sync from Remote)

Pull remote database data into a local container with automatic backup.

```bash
# Replace mode (default): backs up original, then replaces with remote data
spindb pull mydb --from "postgresql://user:pass@prod.example.com/db"

# Read URL from environment variable (keeps credentials out of shell history)
spindb pull mydb --from-env CLONE_FROM_DATABASE_URL

# Clone mode: pull to new database, leave original untouched
spindb pull mydb --from-env PROD_DB_URL --as mydb_prod

# Target specific database (default: container's default database)
spindb pull mydb --from-env PROD_DB_URL -d analytics

# Skip backup (dangerous, requires --force)
spindb pull mydb --from-env PROD_DB_URL --no-backup -f

# Preview changes without executing
spindb pull mydb --from-env PROD_DB_URL --dry-run

# Run script after pull (e.g., sync credentials)
spindb pull mydb --from-env PROD_DB_URL --post-script ./sync-creds.ts

# JSON output for scripting (includes connection URLs)
spindb pull mydb --from-env PROD_DB_URL --json
```

**JSON output includes connection URLs for scripting:**
```json
{
  "success": true,
  "mode": "replace",
  "container": "mydb",
  "port": 5432,
  "database": "efficientdb",
  "databaseUrl": "postgresql://postgres@127.0.0.1:5432/efficientdb",
  "backupDatabase": "efficientdb_20260129_143052",
  "backupUrl": "postgresql://postgres@127.0.0.1:5432/efficientdb_20260129_143052",
  "source": "postgresql://user:***@prod.example.com/db"
}
```

> **vs restore --from-url:** `restore` directly overwrites without backup. `pull` automatically creates a timestamped backup (e.g., `mydb_20260129_143052`) before replacing, so you can always revert.

### Post-Pull Scripts

Post-pull scripts run after the pull completes, with access to both the new data and your original data (backup). This is useful for syncing credentials from your local database to the pulled production data.

SpinDB writes a JSON context file and sets `SPINDB_CONTEXT` env var pointing to it:

```json
{
  "container": "myapp",
  "engine": "postgresql",
  "mode": "replace",
  "port": 5432,
  "newDatabase": "mydb",
  "newUrl": "postgresql://postgres@127.0.0.1:5432/mydb",
  "originalDatabase": "mydb_20260129_143052",
  "originalUrl": "postgresql://postgres@127.0.0.1:5432/mydb_20260129_143052"
}
```

### Example: Sync user credentials after pulling production data

```typescript
#!/usr/bin/env tsx
// sync-credentials.ts - Preserves local passwords after pulling prod
import { readFileSync } from 'fs'
import pg from 'pg'

const ctx = JSON.parse(readFileSync(process.env.SPINDB_CONTEXT!, 'utf-8'))
const { originalUrl, newUrl } = ctx

const originalPool = new pg.Pool({ connectionString: originalUrl })
const newPool = new pg.Pool({ connectionString: newUrl })

async function syncCredentials() {
  const originalClient = await originalPool.connect()
  const newClient = await newPool.connect()

  try {
    // Get credentials from original (backup) database
    const { rows } = await originalClient.query(`
      SELECT email, password_hash, password_salt, refresh_token_hash
      FROM users WHERE email IS NOT NULL
    `)

    if (!rows.length) return

    // Build batch UPDATE
    const values: string[] = []
    const params: string[] = []

    rows.forEach((u, i) => {
      const base = i * 4
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`)
      params.push(u.email, u.password_hash, u.password_salt, u.refresh_token_hash)
    })

    await newClient.query('BEGIN')
    await newClient.query(`
      UPDATE users AS n SET
        password_hash = v.password_hash,
        password_salt = v.password_salt,
        refresh_token_hash = v.refresh_token_hash,
        updated_at = NOW()
      FROM (VALUES ${values.join(',')}) AS v(email, password_hash, password_salt, refresh_token_hash)
      WHERE n.email = v.email
    `, params)
    await newClient.query('COMMIT')

    console.log(`Synced credentials for ${rows.length} users`)
  } catch (e) {
    await newClient.query('ROLLBACK')
    throw e
  } finally {
    originalClient.release()
    newClient.release()
    await originalPool.end()
    await newPool.end()
  }
}

syncCredentials()
```

> **Note:** When using `--no-backup` with `--post-script`, SpinDB still creates a temporary backup so your script can access the original data, then drops it after the script succeeds.

## Database Management

### Create, Rename, and Drop Databases

```bash
# Create a new database in a running container
spindb databases create mydb analytics
spindb databases create mydb                    # Interactive: prompts for name

# Rename a database (backup/restore strategy for safety)
spindb databases rename mydb old_name new_name
spindb databases rename mydb                    # Interactive: select + name
spindb databases rename mydb old new --backup   # Force backup even for native-rename engines
spindb databases rename mydb old new --no-drop  # Keep old database after copying

# Drop a database (with confirmation)
spindb databases drop mydb analytics
spindb databases drop mydb analytics --force    # Skip confirmation

# JSON output for scripting
spindb databases create mydb analytics --json
spindb databases rename mydb old new --json
spindb databases drop mydb analytics --json
```

> **Rename strategy:** For engines that support native rename (PostgreSQL, ClickHouse, CockroachDB, Meilisearch),
> the operation is instant. For all others (MySQL, MongoDB, etc.), SpinDB
> performs a safe backup → create → restore → drop sequence. A safety backup is always
> created at `~/.spindb/backups/rename/` and retained after the operation.
>
> **Not supported:** SQLite, DuckDB (file-based), Redis, Valkey (fixed-numbered DBs),
> QuestDB (single-database), TigerBeetle (single ledger). These engines show a clear
> error with alternative instructions.

### Database Tracking

SpinDB tracks which databases exist within each container. Use these commands to keep tracking in sync after external changes (e.g., SQL renames, scripts that create/drop databases).

```bash
spindb databases list                   # List all containers with their databases
spindb databases list mydb              # List tracked databases in a container
spindb databases list mydb --default    # Show only the default database name
spindb databases add mydb analytics     # Add database to tracking
spindb databases remove mydb old_backup # Remove from tracking
spindb databases sync mydb old new      # Sync after rename (remove old, add new)
spindb databases set-default mydb prod  # Change the default database
spindb databases refresh mydb           # Query server and sync registry

# JSON output for scripting
spindb databases list --json            # All containers with databases as JSON
spindb databases list mydb --json
spindb databases list mydb --default --json  # {"database": "mydb"}
spindb databases add mydb newdb --json
spindb databases set-default mydb prod --json
spindb databases refresh mydb --json    # {"databases": [...], "changes": {...}}
```

> **Note:** `list`, `add`, `remove`, `sync`, and `set-default` only update SpinDB's tracking. They do NOT create or drop actual databases. Use `spindb databases create`/`drop` or `spindb run` for that.
>
> **`databases refresh`** queries the actual database server and syncs the registry with what exists. Works on all engines. Called automatically on `spindb start` and after `spindb pull`.

The **default database** is used when no `-d` flag is provided to commands like `spindb run`, `spindb backup`, etc. Change it via CLI or the interactive menu's "Change default database" option.

**Scripting pattern** - Get the default database for use in scripts:
```bash
DB=$(spindb databases list myapp --default)
spindb run myapp -d "$DB" -c "SELECT * FROM users"
```

## User Management

```bash
spindb users create mydb                # Create user (default: "spindb")
spindb users create mydb devuser        # Create user with specific name
spindb users create mydb --password p   # Use specific password
spindb users create mydb --copy         # Copy connection string to clipboard
spindb users create mydb --json         # JSON output for scripting
spindb users create mydb --no-save      # Don't save credential file
spindb users create mydb --force        # Overwrite existing credential file

spindb users list mydb                  # List saved credentials
spindb users list mydb --json           # JSON output
```

> **Supported engines:** PostgreSQL, MySQL, MariaDB, CockroachDB, ClickHouse, MongoDB, FerretDB, Redis, Valkey, SurrealDB, CouchDB, Meilisearch, Qdrant. Not supported: SQLite, DuckDB, QuestDB, TypeDB, InfluxDB.
>
> **Credentials** are saved as `.env.{username}` files in `~/.spindb/containers/{engine}/{name}/credentials/`.
>
> **API key engines** (Meilisearch, Qdrant) generate API keys instead of user/password pairs.

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
spindb engines                          # List downloaded engines
spindb engines --json                   # List engines as JSON
spindb engines download postgresql 18   # Download specific version
spindb engines delete postgresql 17     # Delete engine version (prompts)
spindb engines delete postgresql 17 -y  # Delete engine version (skip prompt)
spindb deps check                       # Check required tools
spindb deps install                     # Install missing tools
```

## Configuration

```bash
spindb config show                      # Show current config
spindb config detect                    # Re-detect tool paths
spindb config set psql /opt/pg/bin/psql # Set custom binary path
spindb config unset psql                # Remove custom path
spindb config path psql                 # Show path for a tool
spindb config update-check              # Show update check status
spindb config update-check on           # Enable update checks
spindb config update-check off          # Disable update checks
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
| CouchDB     | 5984    | 5984-6084     | Fauxton UI included |
| CockroachDB | 26257   | 26257-26357   | HTTP UI on port+1 |
| SurrealDB   | 8000    | 8000-8100     | HTTP/WebSocket |
| QuestDB     | 8812    | 8812-8912     | Web Console at PG+188 |
| TypeDB      | 1729    | 1729-1829     | HTTP on port+6271 |
| InfluxDB    | 8086    | 8086-8186     | REST API only |
| Weaviate    | 8080    | 8080-8180     | gRPC on port+1 |
| TigerBeetle | 3000    | 3000-3100     | Custom binary protocol |
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
QuestDB:     postgresql://admin:quest@127.0.0.1:8812/qdb
TypeDB:      typedb://127.0.0.1:1729
InfluxDB:    http://127.0.0.1:8086
Weaviate:    http://127.0.0.1:8080
TigerBeetle: 127.0.0.1:3000
SQLite:      sqlite:///path/to/file.sqlite
DuckDB:      duckdb:///path/to/file.duckdb
```

> **CockroachDB:** Uses PostgreSQL wire protocol. Add `?sslmode=disable` for local insecure connections.
> **SurrealDB:** Format is `ws://user:pass@host:port/namespace/database`. Defaults: root/root, test/test.
> **CouchDB:** Default credentials are admin/admin.
> **QuestDB:** Uses PostgreSQL wire protocol. Default credentials are admin/quest. Single database `qdb`.
> **TypeDB:** Uses gRPC protocol. Default credentials: admin/password.
> **InfluxDB:** REST API only. Databases created implicitly on first write. No authentication in local dev mode.
> **Weaviate:** REST/GraphQL API on HTTP port, gRPC on port+1. No authentication in local dev mode.
> **TigerBeetle:** Custom binary protocol (no URI scheme). Single binary serves as both server and REPL client.

## Export to Docker

Export a container to a Docker-ready package that runs SpinDB inside Docker.

```bash
# Basic export
spindb export docker mydb                    # Export to ~/.spindb/containers/{engine}/mydb/docker/
spindb export docker mydb -o ./deploy        # Custom output directory (recommended)
spindb export docker mydb -f                 # Overwrite existing export

# Schema only vs full data
spindb export docker mydb --no-data          # Schema only (empty database)
spindb export docker mydb                    # Full data (default)

# Port and TLS options
spindb export docker mydb -p 5433            # Override port (default: engine's standard port)
spindb export docker mydb --no-tls           # Skip TLS certificates

# Scripting options
spindb export docker mydb --copy             # Copy password to clipboard
spindb export docker mydb --json             # JSON output for scripting
```

**Build and run the exported container:**
```bash
cd ./deploy
docker compose build --no-cache              # Build image
docker compose up -d                         # Start container
docker compose logs -f                       # Watch startup logs
docker compose down                          # Stop container
```

**Connect from host machine:**
```bash
# Get credentials from .env
source .env
psql "postgresql://$SPINDB_USER:$SPINDB_PASSWORD@localhost:$PORT/$DATABASE"
```

> **Default output path:** For server-based engines (PostgreSQL, MySQL, etc.), exports go to `~/.spindb/containers/{engine}/{name}/docker/`. For file-based engines (**SQLite** and **DuckDB**), data lives in your project directory (CWD), so use `-o` to specify where to export.
>
> **Port behavior:** Docker exports default to the engine's standard port (5432 for PostgreSQL, 3306 for MySQL, etc.). If your local container uses a different port, you'll be prompted to choose.

**Generated files:**
- `Dockerfile` - Ubuntu 22.04 base with Node.js, pnpm, SpinDB
- `docker-compose.yml` - Container orchestration with health checks
- `entrypoint.sh` - Startup script with user creation and data restore
- `.env` - Auto-generated credentials (spindb user + random password)
- `certs/` - Self-signed TLS certificates
- `data/` - Database backup for initialization
- `README.md` - Usage instructions and connection strings

**To deploy:**
```bash
# Navigate to the output directory (shown in export output)
cd ~/.spindb/containers/postgresql/mydb/docker && docker compose up -d

# Or use -o to export to a custom directory
spindb export docker mydb -o ./mydb-docker
cd mydb-docker && docker compose up -d
```

> **File-based databases:** SQLite and DuckDB are supported but don't have network servers. Inside Docker, they work as local files. For managing SQLite/DuckDB registry entries, see `spindb attach` and `spindb detach`.

## Docker Commands (after export)

After exporting with `spindb export docker`, use these commands to manage the container:

```bash
# Container lifecycle
docker compose up -d                    # Start container
docker compose down                     # Stop container
docker compose down -v                  # Stop and remove volume (DATA LOSS!)
docker compose restart                  # Restart (safe, idempotent)
docker compose logs -f                  # Follow logs
docker compose ps                       # Show status

# Build/rebuild
docker compose build                    # Build image
docker compose build --no-cache         # Rebuild from scratch

# Execute commands inside container (use bash -l for PATH)
docker exec spindb-mydb bash -l -c "psql --version"
docker exec spindb-mydb bash -l -c "which psql"
docker exec spindb-mydb bash -l -c 'PGPASSWORD=$SPINDB_PASSWORD psql -U spindb -d mydb'
docker exec spindb-mydb bash -l -c 'PGPASSWORD=$SPINDB_PASSWORD psql -U spindb -d mydb -c "SELECT 1"'

# Health and inspection
docker inspect spindb-mydb --format='{{.State.Health.Status}}'
docker inspect spindb-mydb --format='{{json .State}}'
docker inspect spindb-mydb --format='{{.RestartCount}}'
```

> **Login shell required:** Use `bash -l` to ensure database binaries are in PATH. Without `-l`, tools like `psql` won't be found.

## JSON Output (for scripting)

Most commands support `--json` / `-j` for machine-readable output:

```bash
spindb list --json
spindb engines --json
spindb create mydb --json
spindb query mydb "SELECT 1" --json
spindb url mydb --json
spindb backup mydb --json
spindb backups --json
spindb users create mydb --json
spindb users list mydb --json
spindb export docker mydb --json
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

## Scripting & Automation

### Scripting Patterns

```bash
# Export connection string to environment
export DATABASE_URL=$(spindb url mydb)

# Use in psql
psql $(spindb url mydb)

# Backup all PostgreSQL containers
for container in $(spindb list --json | jq -r '.[] | select(.engine=="postgresql") | .name'); do
  spindb backup "$container" --output ./backups/
done

# Start all stopped containers
spindb list --json | jq -r '.[] | select(.status=="stopped") | .name' | while read name; do
  spindb start "$name"
done

# Check if container is running
if spindb info mydb --json | jq -e '.status == "running"' > /dev/null; then
  echo "Container is running"
fi

# Create test database, run migrations, seed data
spindb create testdb --start --database app
spindb run testdb ./migrations/schema.sql --database app
spindb run testdb ./seeds/test-data.sql --database app

# Switch between database versions
spindb stop pgdb
spindb create pgdb-16 --db-version 16 --port 5433
spindb clone pgdb pgdb-backup
spindb start pgdb-16

# Clean up old engine versions
spindb engines                              # List installed
spindb engines delete postgresql 14         # Remove old version
spindb engines delete postgresql 15         # Remove another
```

### TestDatabase Helper

A reusable helper class for integration tests that manages SpinDB containers:

```javascript
// test/helpers/db.js
import { execSync } from 'node:child_process'
import pg from 'pg'

export class TestDatabase {
  constructor(name) {
    this.containerName = `test-${name}-${Date.now()}`
    this.connectionString = null
    this.client = null
  }

  async setup() {
    const output = execSync(
      `spindb create ${this.containerName} --start --json`,
      { encoding: 'utf-8' },
    )
    const result = JSON.parse(output)
    this.connectionString = result.connectionString
    this.client = new pg.Client({ connectionString: this.connectionString })
    await this.client.connect()
    return this.client
  }

  async run(sql) {
    return this.client.query(sql)
  }

  loadSchema(schemaPath) {
    execSync(`spindb run ${this.containerName} ${schemaPath}`)
  }

  async teardown() {
    if (this.client) await this.client.end()
    execSync(`spindb delete ${this.containerName} --force --yes`, {
      stdio: 'ignore',
    })
  }
}
```

Use in tests — each test file gets its own isolated database:

```javascript
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { TestDatabase } from './helpers/db.js'

describe('User Tests', () => {
  const db = new TestDatabase('users')

  before(async () => {
    await db.setup()
    db.loadSchema('./schema/users.sql')
  })

  after(async () => {
    await db.teardown()
  })

  it('should create user', async () => {
    const result = await db.run(
      `INSERT INTO users (email, name) VALUES ('test@example.com', 'Test') RETURNING *`,
    )
    assert.strictEqual(result.rows[0].email, 'test@example.com')
  })
})
```

### CI/CD Integration

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install SpinDB
        run: npm install -g spindb
      - name: Install database tools
        run: spindb deps install --engine postgresql
      - name: Run tests
        run: npm test
      - name: Show containers
        if: failure()
        run: spindb list
```

### package.json Scripts

```json
{
  "scripts": {
    "db:create": "spindb create myapp --start",
    "db:drop": "spindb delete myapp --force --yes",
    "db:reset": "npm run db:drop && npm run db:create && npm run db:migrate && npm run db:seed",
    "db:migrate": "spindb run myapp ./migrations/*.sql",
    "db:seed": "spindb run myapp ./seeds/dev-data.sql",
    "db:backup": "spindb backup myapp --format sql --output ./backups"
  }
}
```

### Snapshot Testing with Clones

Test migrations without risk by cloning:

```javascript
// scripts/test-migration.js
import { execSync } from 'node:child_process'

const PROD = 'production'
const TEST = 'migration-test-' + Date.now()

execSync(`spindb stop ${PROD}`)
execSync(`spindb clone ${PROD} ${TEST}`)
execSync(`spindb start ${TEST}`)
execSync(`spindb start ${PROD}`)

try {
  execSync(`spindb run ${TEST} ./migrations/005-add-users-table.sql`)
  execSync(`spindb run ${TEST} -c "SELECT * FROM users LIMIT 1"`)
  console.log('Migration successful!')
} catch (error) {
  console.error('Migration failed:', error.message)
} finally {
  execSync(`spindb delete ${TEST} --force --yes`)
}
```

## Development-Only Scripts

These scripts are for SpinDB development only. They use `pnpm start` to run the local source code.

```bash
# Generate test databases with sample data
pnpm generate:db <engine> [name] [--port <port>]

# Supported engines (with aliases):
pnpm generate:db postgresql    # postgres, pg
pnpm generate:db mysql
pnpm generate:db mariadb       # maria
pnpm generate:db mongodb       # mongo
pnpm generate:db ferretdb      # ferret
pnpm generate:db redis
pnpm generate:db valkey
pnpm generate:db clickhouse    # ch
pnpm generate:db sqlite        # lite (file-based, no --port)
pnpm generate:db duckdb        # duck (file-based, no --port)
pnpm generate:db qdrant        # qd (REST API)
pnpm generate:db meilisearch   # meili, ms (REST API)
pnpm generate:db couchdb       # couch (REST API)
pnpm generate:db cockroachdb   # crdb, cockroach
pnpm generate:db surrealdb     # surreal
pnpm generate:db questdb       # quest
pnpm generate:db typedb        # tdb
pnpm generate:db influxdb      # influx (REST API)
pnpm generate:db weaviate      # weav (REST/GraphQL API)
pnpm generate:db tigerbeetle   # tb

# Examples:
pnpm generate:db pg                      # Create "demo-postgresql" with seed data
pnpm generate:db pg mydb                 # Seed existing container "mydb"
pnpm generate:db mysql --port 3333       # Create on specific port
pnpm generate:db mongo mydb --port 27027 # Create "mydb" on port 27027

# Generate backup fixtures
pnpm generate:backup qdrant              # Generate Qdrant snapshot fixture
pnpm generate:backup qdrant my-snapshot  # With custom snapshot name

# Create demo containers for missing engines (quick bulk setup)
pnpm generate:missing                    # Create one demo-* container per missing engine
pnpm generate:missing --all              # Create demo containers for ALL engines
pnpm generate:missing --dry-run          # Preview what would be created

# Delete all demo containers (cleanup)
pnpm delete:demos                        # Stop and delete all demo-* containers
pnpm delete:demos --dry-run              # Preview what would be deleted
```

> **Note:** These scripts require running from the SpinDB project root and use the local development code via `pnpm start`.
>
> **`generate:missing`** is useful for quickly creating one container of each engine type for testing. It skips engines that already have containers (unless `--all` is used). If `demo-postgresql` exists, it creates `demo-postgresql-2`, etc. Containers are created but NOT started.
>
> **`delete:demos`** cleans up all containers with names starting with `demo-`. It stops running containers before deleting them.
