# SpinDB Deployment Guide

This document covers deploying SpinDB containers to production environments using Docker.

## Overview

SpinDB can export local containers to Docker-ready packages. The exported package runs SpinDB inside Docker, using the same hostdb binaries as local development. This ensures consistency between development and production environments.

**Why SpinDB-in-Docker (not official Docker images)?**

1. **Custom binaries**: Many engines use custom hostdb builds with no official Docker images (FerretDB + postgresql-documentdb, custom Valkey builds, patched binaries)
2. **Consistency**: Same binary management locally AND in production
3. **Single abstraction**: Learn SpinDB once, deploy anywhere
4. **All engines work**: Including file-based databases (SQLite, DuckDB)

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

```
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

```
┌─────────────────────────────────────────────┐
│  Docker Container (Ubuntu 22.04)            │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  SpinDB                              │   │
│  │  - Downloads hostdb binaries         │   │
│  │  - Manages database lifecycle        │   │
│  │  - Configures TLS certificates       │   │
│  └──────────────┬──────────────────────┘   │
│                 │                           │
│  ┌──────────────▼──────────────────────┐   │
│  │  Database Engine                     │   │
│  │  (PostgreSQL, MySQL, MongoDB, etc)   │   │
│  │  - Native TLS enabled                │   │
│  │  - Password authentication           │   │
│  │  Data: /root/.spindb/containers/     │   │
│  └─────────────────────────────────────┘   │
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

```
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
