# SpinDB Deployment Guide

This document covers deploying SpinDB containers to production environments using Docker.

## Overview

SpinDB can export local containers to Docker-ready packages. The exported package runs SpinDB inside Docker, using the same hostdb binaries as local development. This ensures consistency between development and production environments.

**Why SpinDB-in-Docker (not official Docker images)?**

1. **Custom binaries**: Many engines use custom hostdb builds with no official Docker images (FerretDB + postgresql-documentdb, custom Valkey builds, patched binaries)
2. **Consistency**: Same binary management locally AND in production
3. **Single abstraction**: Learn SpinDB once, deploy anywhere
4. **All engines work**: Including file-based databases (SQLite, DuckDB)

## Important: Development Tool Disclaimer

**SpinDB is currently a development tool.** While it can produce production-ready Docker images with TLS encryption and authentication, it is not recommended for production deployments at this time. Use SpinDB for:

- Local development environments
- CI/CD testing pipelines
- Staging environments
- Learning and experimentation

For production databases, consider managed services like AWS RDS, Google Cloud SQL, Neon, Supabase, or PlanetScale.

---

## EXPORT FOR DOCKER

This section provides a complete walkthrough for exporting a SpinDB container to a Docker image that can be deployed anywhere Docker runs (EC2, DigitalOcean, Kubernetes, etc.).

### Step 1: Export Your Container

```bash
# Export with all data (default)
spindb export docker mydb -o ./mydb-docker

# Export schema only (no data)
spindb export docker mydb -o ./mydb-docker --no-data

# Export with custom port
spindb export docker mydb -o ./mydb-docker -p 5433
```

**Schema-only vs Full Data Export:**

| Flag | What's Included | Use Case |
|------|-----------------|----------|
| *(default)* | Schema + all data | Staging, demos, full clones |
| `--no-data` | Schema only (empty tables) | Fresh deployments, CI/CD |
| `--no-tls` | Skip TLS certificates | Internal networks, testing |

### Step 2: Build the Docker Image

```bash
cd ./mydb-docker

# Build the image
docker compose build

# Or build without cache (recommended for fresh builds)
docker compose build --no-cache
```

### Step 3: Start the Container

```bash
# Start in detached mode
docker compose up -d

# View logs to monitor startup
docker logs -f spindb-mydb

# Wait for "SpinDB container ready!" message
```

The container will:
1. Download the database engine from hostdb
2. Initialize the database cluster
3. Configure network access for external connections
4. Create the `spindb` user with the generated password
5. Restore your data (if not using `--no-data`)
6. Start accepting connections

### Step 4: Connect from External Clients

Once the container shows "SpinDB container ready!", you can connect from any PostgreSQL client:

**Connection Details** (from `.env` file):
```bash
# View your credentials
cat .env

# Example output:
# SPINDB_USER=spindb
# SPINDB_PASSWORD=TENFLCPOUVghbAzkoc1B
# PORT=5432
# DATABASE=mydb
```

**Connection String:**
```
postgresql://spindb:<password>@localhost:5432/mydb
```

**Connect with psql:**
```bash
PGPASSWORD=TENFLCPOUVghbAzkoc1B psql -h localhost -p 5432 -U spindb -d mydb
```

**Connect with TablePlus, DBeaver, or other GUI clients:**
- Host: `localhost` (or your server's IP)
- Port: `5432` (or your custom port)
- User: `spindb`
- Password: *(from .env file)*
- Database: `mydb`
- SSL: Optional (self-signed certs provided)

### Step 5: Deploy to a Remote Server

To deploy to an EC2 instance, DigitalOcean droplet, or any server with Docker:

```bash
# Copy the export directory to your server
scp -r ./mydb-docker user@your-server:~/

# SSH into the server
ssh user@your-server

# Build and run
cd ~/mydb-docker
docker compose up -d
```

Then connect using your server's public IP:
```
postgresql://spindb:<password>@your-server-ip:5432/mydb
```

### Complete Example: Export and Deploy

```bash
# 1. Create and populate a local database
spindb create myapp --start
spindb run myapp ./schema.sql
spindb run myapp ./seed-data.sql

# 2. Export to Docker
spindb export docker myapp -o ./myapp-deploy

# 3. Build and run locally to test
cd ./myapp-deploy
docker compose build --no-cache
docker compose up -d

# 4. Verify connection works
source .env
PGPASSWORD=$SPINDB_PASSWORD psql -h localhost -p 5432 -U $SPINDB_USER -d $DATABASE -c "SELECT 1"

# 5. Stop local test
docker compose down

# 6. Deploy to production server
scp -r . user@prod-server:~/myapp-deploy
ssh user@prod-server "cd ~/myapp-deploy && docker compose up -d"
```

### Docker Compose Commands Reference

```bash
# Start container
docker compose up -d

# Stop container
docker compose down

# View logs
docker compose logs -f

# Restart container
docker compose restart

# Rebuild after changes
docker compose build --no-cache && docker compose up -d

# Check container status
docker compose ps

# Execute commands inside container
docker compose exec spindb-mydb spindb list
```

---

## Quick Start

```bash
# Export a container to Docker
spindb export docker mydb

# Output:
# ✔ Exported mydb to Docker
#
#   PostgreSQL 17
#   Port: 5432
#   Database: mydb
#
#   Generated Credentials
#   ────────────────────────
#   Username: spindb
#   Password: xK9#mP2$vL7nQ4wR
#   ────────────────────────
#
#   Save these credentials now - stored in .env
#
#   Output: ~/.spindb/containers/postgresql/mydb/docker
#
#   To run:
#     cd "~/.spindb/containers/postgresql/mydb/docker" && docker-compose up -d
```

## Command Options

```bash
spindb export docker <container> [options]

Options:
  -o, --output <dir>   Output directory (default: ~/.spindb/containers/{engine}/{name}/docker)
  -p, --port <number>  Override external port (default: engine's standard port)
  -f, --force          Overwrite existing output directory
  --no-data            Skip including database backup
  --no-tls             Skip TLS certificate generation
  -c, --copy           Copy password to clipboard
  -j, --json           JSON output mode
```

**Port selection:** By default, the Docker container uses the engine's standard port (e.g., 5432 for PostgreSQL). If your local container uses a different port, you'll be prompted to choose which port the Docker container should use. Use `-p` to explicitly set a port.

## Generated Files

```text
~/.spindb/containers/{engine}/{name}/docker/
├── Dockerfile           # Docker image definition
├── docker-compose.yml   # Container orchestration
├── .env                 # Environment variables and credentials
├── entrypoint.sh        # Container startup script
├── certs/               # TLS certificates (if not skipped)
│   ├── server.crt
│   └── server.key
├── data/                # Database backup for initialization
│   └── backup.sql       # (or engine-specific format)
└── README.md            # Usage instructions
```

## Architecture

```text
┌─────────────────────────────────────────────┐
│  Docker Container (Ubuntu 22.04)            │
│                                             │
│  ┌────────────────────────────────-─────┐   │
│  │  SpinDB                              │   │
│  │  - Downloads hostdb binaries         │   │
│  │  - Manages database lifecycle        │   │
│  │  - Configures TLS certificates       │   │
│  └──────────────┬──────────────────-────┘   │
│                 │                           │
│  ┌──────────────▼──────────────────-────┐   │
│  │  Database Engine                     │   │
│  │  (PostgreSQL, MySQL, MongoDB, etc)   │   │
│  │  - Native TLS enabled                │   │
│  │  - Password authentication           │   │
│  │  Data: /home/spindb/.spindb/         │   │
│  └─────────────────────────────────-────┘   │
└─────────────────────────────────────────────┘
         │
         ▼ Port (TLS encrypted)

    Application connects with:
    postgresql://spindb:pass@host:5432/db?sslmode=require
```

## TLS Configuration

Each engine has native TLS support. SpinDB configures it automatically:

| Engine | TLS Config | Connection String |
|--------|------------|-------------------|
| PostgreSQL | `ssl = on` + certs | `?sslmode=require` |
| MySQL | `require_secure_transport = ON` | `?ssl=true` |
| MariaDB | `require_secure_transport = ON` | `?ssl=true` |
| MongoDB | `--tlsMode requireTLS` | `?tls=true` |
| FerretDB | Backend PostgreSQL TLS | `?tls=true` |
| Redis | `tls-port` + `tls-cert-file` | `rediss://` (double s) |
| Valkey | `tls-port` + `tls-cert-file` | `rediss://` |
| ClickHouse | `<https_port>` + certs | `?secure=true` |
| Qdrant | `--tls-cert` + `--tls-key` | HTTPS endpoint |
| Meilisearch | Behind reverse proxy | HTTPS endpoint |
| CouchDB | `[ssl]` section | `https://` |
| CockroachDB | `--certs-dir` flag | `?sslmode=require` |
| SurrealDB | `--web-crt` + `--web-key` | `wss://` or `https://` |
| QuestDB | `pg.net.tls.*` | `?sslmode=require` |

**Note:** For production, replace the self-signed certificates in `certs/` with valid certificates from a trusted CA.

## Credentials

Each export generates a unique `spindb` user with a random 16-character password. Credentials are stored in `.env`:

```bash
# Container settings
CONTAINER_NAME=mydb
ENGINE=postgresql
VERSION=17
PORT=5432
DATABASE=mydb

# Credentials (auto-generated, change in production)
SPINDB_USER=spindb
SPINDB_PASSWORD=xK9#mP2$vL7nQ4wR
```

**Engine-specific authentication:**

| Engine | Auth Mechanism | Notes |
|--------|----------------|-------|
| PostgreSQL | `spindb` user + password | Created via SQL after start |
| MySQL/MariaDB | `spindb` user + password | Created via SQL after start |
| MongoDB/FerretDB | `spindb` user + password | Created via mongosh |
| Redis/Valkey | Password only | `--requirepass` flag |
| ClickHouse | `spindb` user + password | Created via SQL |
| Qdrant | API key | `--api-key` flag |
| Meilisearch | Master key | `--master-key` flag |
| CouchDB | `spindb` admin + password | Created via API |
| CockroachDB | `spindb` user + password | Created via SQL |
| SurrealDB | `spindb` user + password | `--user --pass` flags |
| QuestDB | `spindb` user + password | PostgreSQL wire auth |

## Connection Strings

After deploying, connect using the TLS-enabled connection string:

```text
PostgreSQL:   postgresql://spindb:PASSWORD@HOST:5432/mydb?sslmode=require
MySQL:        mysql://spindb:PASSWORD@HOST:3306/mydb?ssl=true
MongoDB:      mongodb://spindb:PASSWORD@HOST:27017/mydb?tls=true
Redis:        rediss://:PASSWORD@HOST:6379
CockroachDB:  postgresql://spindb:PASSWORD@HOST:26257/mydb?sslmode=require
```

Replace:
- `HOST` with your server's hostname or IP
- `PASSWORD` with the value from `.env`
- Port number as configured

## Running the Container

### Basic Usage

```bash
# Navigate to the export directory (shown in export output)
cd ~/.spindb/containers/postgresql/mydb/docker
docker-compose up -d
```

### View Logs

```bash
docker-compose logs -f
```

### Stop Container

```bash
docker-compose down
```

### Rebuild After Changes

```bash
docker-compose build --no-cache
docker-compose up -d
```

### Container Restarts

The container is idempotent - restarting won't recreate the database or duplicate configuration:

```bash
# Safe to restart anytime
docker compose restart

# After restart, data persists and credentials remain valid
# Logs will show "Container already exists" and "skipping data restore"
```

### Run Commands Inside the Container

Database CLI tools (psql, mysql, mongosh, etc.) are available inside the container via login shell:

```bash
# Check tool availability
docker exec spindb-mydb bash -l -c "which psql && psql --version"

# Run psql inside container (uses container's SPINDB_PASSWORD env var)
docker exec spindb-mydb bash -l -c 'PGPASSWORD=$SPINDB_PASSWORD psql -h localhost -U spindb -d mydb'

# Run a query
docker exec spindb-mydb bash -l -c 'PGPASSWORD=$SPINDB_PASSWORD psql -h localhost -U spindb -d mydb -c "SELECT COUNT(*) FROM users"'

# MySQL example
docker exec spindb-mydb bash -l -c 'mysql -h localhost -u spindb -p$SPINDB_PASSWORD mydb'

# MongoDB example
docker exec spindb-mydb bash -l -c 'mongosh "mongodb://spindb:$SPINDB_PASSWORD@localhost:27017/mydb"'
```

> **Note:** Use `bash -l` (login shell) to ensure PATH includes the database binaries. Without `-l`, commands like `psql` won't be found.

## Customization

### Change Port

Edit `.env`:
```bash
PORT=5433
```

### Use Custom TLS Certificates

Replace files in `certs/`:
```bash
cp /path/to/your/server.crt certs/server.crt
cp /path/to/your/server.key certs/server.key
```

### Modify Startup Script

Edit `entrypoint.sh` for custom initialization logic.

### Persist Data Across Rebuilds

The `docker-compose.yml` uses a named volume for persistence:
```yaml
volumes:
  spindb-data:
```

Data persists across container restarts and rebuilds.

## File-Based Databases

SQLite and DuckDB are file-based databases (no server process). When exported:

- The database file is included in `data/`
- Container startup copies the file to the appropriate location
- **Network access requires additional configuration** (e.g., LibSQL for SQLite)

For Phase 1, file-based databases work inside the container but may require extra work for remote network access.

## Health Checks

The container includes automatic health checking:

```yaml
healthcheck:
  test: ["CMD", "spindb", "list", "--json"]
  interval: 30s
  timeout: 10s
  start_period: 60s
  retries: 3
```

SpinDB monitors the database and auto-restarts if it stops unexpectedly.

## Security Considerations

1. **Change default credentials** - The auto-generated password is for convenience; rotate in production
2. **Replace self-signed certificates** - Use certificates from a trusted CA for production
3. **Network security** - Use firewalls, VPNs, or private networks to restrict access
4. **Secrets management** - Consider using Docker secrets or external secret managers instead of `.env`

## Troubleshooting

### Container fails to start

Check logs for specific errors:
```bash
docker-compose logs
```

Common issues:
- Port already in use (change `PORT` in `.env`)
- Missing dependencies (rebuild the image)
- Insufficient permissions (check volume mounts)

### Database not accepting connections

1. Wait for startup to complete (check logs for "ready" message)
2. Verify port mapping: `docker-compose ps`
3. Check health status: `docker inspect --format='{{.State.Health.Status}}' <container>`

### TLS certificate errors

1. Verify certificates exist: `ls certs/`
2. Check certificate validity: `openssl x509 -in certs/server.crt -text -noout`
3. For self-signed certs, configure client to accept them or use `sslmode=require` (not `verify-full`)

## Future: Remote Deploy (Phase 2)

```bash
# Deploy directly to a remote server via SSH
spindb deploy mydb --host user@server

# Returns connection string after deployment
# postgresql://spindb:pass@server:5432/mydb?sslmode=require
```

This feature is planned for a future release.

## Future: Multi-Tenant (Phase 3)

- Managed server with dynamic port allocation
- Dashboard for monitoring
- Per-user isolation

This feature is planned for a future release.

## Future: Managed Service Exports (Phase 4)

Direct export to managed database services:

```bash
# Export to Neon (planned)
spindb export neon mydb --project my-neon-project

# Export to Supabase (planned)
spindb export supabase mydb --project my-supabase-project

# Export to PlanetScale (planned)
spindb export planetscale mydb --database my-db
```

These features are tentatively planned for future releases, allowing seamless migration from local development to production-ready managed services.
