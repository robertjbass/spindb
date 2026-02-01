/**
 * Docker Exporter
 *
 * Generates Docker artifacts (Dockerfile, docker-compose.yml, entrypoint.sh, etc.)
 * for running SpinDB containers in Docker.
 *
 * Architecture: SpinDB runs inside the container and manages the database,
 * using the same hostdb binaries as local development.
 */

import { mkdir, writeFile, copyFile } from 'fs/promises'
import { join, basename } from 'path'
import { existsSync } from 'fs'
import { type ContainerConfig, Engine, isFileBasedEngine } from '../types'
import { engineDefaults } from '../config/engine-defaults'
import { getDefaultFormat, getBackupExtension } from '../config/backup-formats'
import { generateCredentials, type Credentials } from './credential-generator'
import { generateTLSCertificates, isOpenSSLAvailable } from './tls-generator'

export type DockerExportOptions = {
  // Output directory for the Docker artifacts
  outputDir: string
  // Override the external port (default: same as container port)
  port?: number
  // Include database backup (default: true)
  includeData?: boolean
  // Path to existing backup file to use instead of creating new one (single database)
  backupPath?: string
  // Paths to backup files for multiple databases
  backupPaths?: Array<{ database: string; path: string }>
  // Skip TLS certificate generation (default: false)
  skipTLS?: boolean
}

export type DockerExportResult = {
  outputDir: string
  credentials: Credentials
  port: number
  engine: Engine
  version: string
  database: string
  files: string[]
}

/**
 * Get the display name for an engine
 */
function getEngineDisplayName(engine: Engine): string {
  const displayNames: Record<Engine, string> = {
    [Engine.PostgreSQL]: 'PostgreSQL',
    [Engine.MySQL]: 'MySQL',
    [Engine.MariaDB]: 'MariaDB',
    [Engine.SQLite]: 'SQLite',
    [Engine.DuckDB]: 'DuckDB',
    [Engine.MongoDB]: 'MongoDB',
    [Engine.FerretDB]: 'FerretDB',
    [Engine.Redis]: 'Redis',
    [Engine.Valkey]: 'Valkey',
    [Engine.ClickHouse]: 'ClickHouse',
    [Engine.Qdrant]: 'Qdrant',
    [Engine.Meilisearch]: 'Meilisearch',
    [Engine.CouchDB]: 'CouchDB',
    [Engine.CockroachDB]: 'CockroachDB',
    [Engine.SurrealDB]: 'SurrealDB',
    [Engine.QuestDB]: 'QuestDB',
  }
  return displayNames[engine] || engine
}

/**
 * Get the connection string template for an engine
 * Includes placeholders for credentials and optionally TLS
 *
 * @param engine - Database engine
 * @param port - Port number
 * @param database - Database name
 * @param useTLS - Whether to include TLS parameters (default: true)
 */
function getConnectionStringTemplate(
  engine: Engine,
  port: number,
  database: string,
  useTLS = true,
): string {
  const defaults = engineDefaults[engine]

  switch (engine) {
    case Engine.PostgreSQL:
    case Engine.CockroachDB:
    case Engine.QuestDB:
      return useTLS
        ? `postgresql://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}?sslmode=require`
        : `postgresql://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.MySQL:
    case Engine.MariaDB:
      return useTLS
        ? `mysql://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}?ssl=true`
        : `mysql://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.MongoDB:
    case Engine.FerretDB:
      return useTLS
        ? `mongodb://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}?tls=true`
        : `mongodb://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.Redis:
    case Engine.Valkey:
      return useTLS
        ? `rediss://:\${SPINDB_PASSWORD}@<host>:${port}`
        : `redis://:\${SPINDB_PASSWORD}@<host>:${port}`

    case Engine.ClickHouse:
      return useTLS
        ? `clickhouse://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}?secure=true`
        : `clickhouse://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.Qdrant:
      return useTLS ? `https://<host>:${port}` : `http://<host>:${port}`

    case Engine.Meilisearch:
      return useTLS ? `https://<host>:${port}` : `http://<host>:${port}`

    case Engine.CouchDB:
      return useTLS
        ? `https://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`
        : `http://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}/${database}`

    case Engine.SurrealDB:
      return useTLS
        ? `wss://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}`
        : `ws://\${SPINDB_USER}:\${SPINDB_PASSWORD}@<host>:${port}`

    case Engine.SQLite:
    case Engine.DuckDB:
      return `File-based database (no network connection)`

    default:
      return `${defaults.connectionScheme}://<host>:${port}/${database}`
  }
}

/**
 * Generate the Dockerfile content
 */
function generateDockerfile(engine: Engine): string {
  return `# SpinDB Docker Container
# Runs SpinDB inside Docker to manage database lifecycle

FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install base dependencies
# libnuma1: Required by PostgreSQL binaries
# gosu: For running commands as non-root user
RUN apt-get update && apt-get install -y \\
    curl \\
    openssl \\
    ca-certificates \\
    gnupg \\
    libnuma1 \\
    gosu \\
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 LTS (matches SpinDB's engine requirements)
RUN mkdir -p /etc/apt/keyrings \\
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \\
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \\
    && apt-get update \\
    && apt-get install -y nodejs \\
    && rm -rf /var/lib/apt/lists/*

# Create spindb user (non-root for database processes)
RUN groupadd -r spindb && useradd -r -g spindb -d /home/spindb -m -s /bin/bash spindb

# Install pnpm and SpinDB globally
ENV PNPM_HOME="/home/spindb/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm \\
    && mkdir -p "$PNPM_HOME" \\
    && pnpm add -g spindb

# Create spindb directories with proper ownership
RUN mkdir -p /home/spindb/.spindb/containers /home/spindb/.spindb/bin /home/spindb/.spindb/certs /home/spindb/.spindb/init \\
    && chown -R spindb:spindb /home/spindb

# Copy TLS certificates
COPY --chown=spindb:spindb ./certs/ /home/spindb/.spindb/certs/

# Copy database backup/data
COPY --chown=spindb:spindb ./data/ /home/spindb/.spindb/init/

# Copy entrypoint script
COPY ./entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables (can be overridden)
ENV SPINDB_ENGINE=${engine}
ENV HOME=/home/spindb

# Expose database port
EXPOSE \${SPINDB_PORT:-${engineDefaults[engine].defaultPort}}

# Health check (run as spindb user)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \\
    CMD gosu spindb spindb list --json | grep -q '"status":"running"'

ENTRYPOINT ["/entrypoint.sh"]
`
}

/**
 * Generate the entrypoint.sh content
 */
function generateEntrypoint(
  engine: Engine,
  containerName: string,
  database: string,
  databases: string[],
  version: string,
  port: number,
  useTLS: boolean,
): string {
  const isFileBased = isFileBasedEngine(engine)

  // Engine-specific user creation commands
  let userCreationCommands = ''

  switch (engine) {
    case Engine.PostgreSQL:
      userCreationCommands = `
# Create user with password
echo "Creating database user..."
run_as_spindb spindb run "$CONTAINER_NAME" --database postgres <<EOF
DO \\$\\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$SPINDB_USER') THEN
    CREATE ROLE "$SPINDB_USER" WITH LOGIN PASSWORD '$SPINDB_PASSWORD' CREATEDB;
  ELSE
    ALTER ROLE "$SPINDB_USER" WITH PASSWORD '$SPINDB_PASSWORD';
  END IF;
END
\\$\\$;
GRANT ALL PRIVILEGES ON DATABASE "$DATABASE" TO "$SPINDB_USER";
EOF
`
      break

    case Engine.MySQL:
    case Engine.MariaDB:
      userCreationCommands = `
# Create user with password
echo "Creating database user..."
run_as_spindb spindb run "$CONTAINER_NAME" --database mysql <<EOF
CREATE USER IF NOT EXISTS '$SPINDB_USER'@'%' IDENTIFIED BY '$SPINDB_PASSWORD';
GRANT ALL PRIVILEGES ON \\\`$DATABASE\\\`.* TO '$SPINDB_USER'@'%';
FLUSH PRIVILEGES;
EOF
`
      break

    case Engine.MongoDB:
    case Engine.FerretDB:
      userCreationCommands = `
# Create user with password
echo "Creating database user..."
run_as_spindb spindb run "$CONTAINER_NAME" --database admin <<EOF
db.createUser({
  user: "$SPINDB_USER",
  pwd: "$SPINDB_PASSWORD",
  roles: [{ role: "readWrite", db: "$DATABASE" }]
});
EOF
`
      break

    case Engine.Redis:
    case Engine.Valkey:
      // Redis uses requirepass, configured at start time
      userCreationCommands = `
# Redis/Valkey authentication is configured at server start via --requirepass
echo "Authentication configured via server settings"
`
      break

    case Engine.ClickHouse:
      userCreationCommands = `
# Create user with password
echo "Creating database user..."
run_as_spindb spindb run "$CONTAINER_NAME" <<EOF
CREATE USER IF NOT EXISTS $SPINDB_USER IDENTIFIED BY '$SPINDB_PASSWORD';
GRANT ALL ON $DATABASE.* TO $SPINDB_USER;
EOF
`
      break

    case Engine.CouchDB:
      userCreationCommands = `
# CouchDB admin user is configured at server start
echo "Admin credentials configured via server settings"
`
      break

    case Engine.CockroachDB:
      userCreationCommands = `
# Create user with password
echo "Creating database user..."
run_as_spindb spindb run "$CONTAINER_NAME" --database defaultdb <<EOF
CREATE USER IF NOT EXISTS $SPINDB_USER WITH PASSWORD '$SPINDB_PASSWORD';
GRANT ALL ON DATABASE $DATABASE TO $SPINDB_USER;
EOF
`
      break

    case Engine.SurrealDB:
      userCreationCommands = `
# SurrealDB credentials are configured at server start
echo "Credentials configured via server settings"
`
      break

    case Engine.QuestDB:
      userCreationCommands = `
# QuestDB user is configured via config
echo "User configured via server settings"
`
      break

    case Engine.Qdrant:
    case Engine.Meilisearch:
      userCreationCommands = `
# API key is configured at server start
echo "API key configured via server settings"
`
      break

    default:
      userCreationCommands = `
echo "Credentials configured"
`
  }

  // Generate restore commands for all databases
  // Note: Uses /home/spindb/.spindb/init/ since container runs as spindb user
  const initDir = '/home/spindb/.spindb/init'
  const fileExt = engine === Engine.SQLite ? 'sqlite' : 'duckdb'
  const fileBasedDataPath = `/home/spindb/.spindb/containers/${engine}/${containerName}/${containerName}.${fileExt}`
  const restoreSection = isFileBased
    ? `
# File-based database - copy data file to the path used by spindb create --path
if ls ${initDir}/*.${fileExt} 1> /dev/null 2>&1; then
    echo "Copying database file..."
    cp ${initDir}/*.${fileExt} "${fileBasedDataPath}"
fi
`
    : databases.length > 1
      ? `
# Restore data for all databases
DATABASES="${databases.join(' ')}"
for DB in $DATABASES; do
    # Find backup file for this database (pattern: containerName-dbName.*)
    BACKUP_FILE=$(ls ${initDir}/${containerName}-$DB.* 2>/dev/null | head -1)
    if [ -n "$BACKUP_FILE" ]; then
        echo "Restoring database: $DB"
        # Add database to tracking if not already tracked
        run_as_spindb spindb databases add "$CONTAINER_NAME" "$DB" 2>/dev/null || true
        run_as_spindb spindb restore "$CONTAINER_NAME" "$BACKUP_FILE" --database "$DB" --force || echo "Restore of $DB completed with warnings"
    fi
done
`
      : `
# Restore data if backup exists
if ls ${initDir}/* 1> /dev/null 2>&1; then
    echo "Restoring data from backup..."
    BACKUP_FILE=$(ls ${initDir}/* | head -1)
    run_as_spindb spindb restore "$CONTAINER_NAME" "$BACKUP_FILE" --database "$DATABASE" --force || echo "Restore completed with warnings"
fi
`

  return `#!/bin/bash
set -e

# Container configuration (from environment variables)
CONTAINER_NAME="\${SPINDB_CONTAINER:-${containerName}}"
DATABASE="\${SPINDB_DATABASE:-${database}}"
ENGINE="\${SPINDB_ENGINE:-${engine}}"
VERSION="\${SPINDB_VERSION:-${version}}"
PORT="\${SPINDB_PORT:-${port}}"
SPINDB_USER="\${SPINDB_USER:-spindb}"
SPINDB_PASSWORD="\${SPINDB_PASSWORD:?Error: SPINDB_PASSWORD environment variable is required}"

# Export environment variables for the spindb user
export SPINDB_CONTAINER SPINDB_DATABASE SPINDB_ENGINE SPINDB_VERSION SPINDB_PORT SPINDB_USER SPINDB_PASSWORD

# Fix permissions on mounted volume (may have been created with root ownership)
echo "Setting up directories..."
chown -R spindb:spindb /home/spindb/.spindb 2>/dev/null || true

echo "========================================"
echo "SpinDB Docker Container"
echo "========================================"
echo "Engine: $ENGINE $VERSION"
echo "Container: $CONTAINER_NAME"
echo "Database: $DATABASE"
echo "Port: $PORT"
echo "========================================"

# Run all spindb commands as the spindb user (databases cannot run as root)
run_as_spindb() {
    gosu spindb "$@"
}

# Check if container already exists
if run_as_spindb spindb list --json 2>/dev/null | grep -q '"name":"'"$CONTAINER_NAME"'"'; then
    echo "Container '$CONTAINER_NAME' already exists"
else
    echo "Creating container '$CONTAINER_NAME'..."
    ${
      isFileBased
        ? `# File-based database: use deterministic path for database file
    run_as_spindb spindb create "$CONTAINER_NAME" --engine "$ENGINE" --db-version "$VERSION" --path "${fileBasedDataPath}" --force`
        : `run_as_spindb spindb create "$CONTAINER_NAME" --engine "$ENGINE" --db-version "$VERSION" --port "$PORT" --database "$DATABASE" --force`
    }
fi
${
  isFileBased
    ? `
# File-based database: no server to start, just verify file exists after restore
`
    : `
# Start the database
echo "Starting database..."
run_as_spindb spindb start "$CONTAINER_NAME"

# Wait for database to be ready
echo "Waiting for database to be ready..."
RETRIES=30
until run_as_spindb spindb list --json 2>/dev/null | grep -q '"status":"running"' || [ $RETRIES -eq 0 ]; do
    echo "Waiting for database... ($RETRIES attempts remaining)"
    sleep 2
    RETRIES=$((RETRIES-1))
done

if [ $RETRIES -eq 0 ]; then
    echo "Error: Database failed to start"
    exit 1
fi`
}

echo "Database is running!"
${userCreationCommands}
${restoreSection}
echo "========================================"
echo "SpinDB container ready!"
echo ""
echo "Connection: ${getConnectionStringTemplate(engine, port, database, useTLS).replace(/\$/g, '\\$')}"
echo "========================================"
${
  isFileBased
    ? `
# File-based database: just keep container alive (no server to monitor)
exec tail -f /dev/null`
    : `
# Keep container running
# Trap SIGTERM and SIGINT for graceful shutdown
trap "echo 'Shutting down...'; run_as_spindb spindb stop '$CONTAINER_NAME'; exit 0" SIGTERM SIGINT

# Keep the container running (as spindb user)
exec gosu spindb tail -f /dev/null &
while true; do
    sleep 60
    # Check if database is still running
    if ! run_as_spindb spindb list --json 2>/dev/null | grep -q '"status":"running"'; then
        echo "Database stopped unexpectedly, restarting..."
        run_as_spindb spindb start "$CONTAINER_NAME" || true
    fi
done`
}
`
}

/**
 * Generate docker-compose.yml content
 */
function generateDockerCompose(
  containerName: string,
  engine: Engine,
  version: string,
  port: number,
  database: string,
): string {
  return `name: spindb-${containerName}

services:
  ${containerName}:
    build: .
    container_name: spindb-${containerName}
    restart: unless-stopped
    environment:
      SPINDB_CONTAINER: \${CONTAINER_NAME:-${containerName}}
      SPINDB_ENGINE: \${ENGINE:-${engine}}
      SPINDB_VERSION: \${VERSION:-${version}}
      SPINDB_PORT: \${PORT:-${port}}
      SPINDB_DATABASE: \${DATABASE:-${database}}
      SPINDB_USER: \${SPINDB_USER:-spindb}
      SPINDB_PASSWORD: \${SPINDB_PASSWORD:?Set SPINDB_PASSWORD in .env file}
    ports:
      - "\${PORT:-${port}}:\${PORT:-${port}}"
    volumes:
      - spindb-data:/home/spindb/.spindb
    healthcheck:
      test: ["CMD", "gosu", "spindb", "spindb", "list", "--json"]
      interval: 30s
      timeout: 10s
      start_period: 60s
      retries: 3

volumes:
  spindb-data:
`
}

/**
 * Generate .env file content
 */
function generateEnvFile(
  containerName: string,
  engine: Engine,
  version: string,
  port: number,
  database: string,
  credentials: Credentials,
): string {
  return `# SpinDB Docker Configuration
# Generated by: spindb export docker

# Container settings
CONTAINER_NAME=${containerName}
ENGINE=${engine}
VERSION=${version}
PORT=${port}
DATABASE=${database}

# Credentials (auto-generated, change in production)
SPINDB_USER=${credentials.username}
SPINDB_PASSWORD=${credentials.password}
`
}

/**
 * Generate README.md content
 */
function generateReadme(
  containerName: string,
  engine: Engine,
  version: string,
  port: number,
  database: string,
  useTLS: boolean,
): string {
  const displayName = getEngineDisplayName(engine)
  const connectionTemplate = getConnectionStringTemplate(
    engine,
    port,
    database,
    useTLS,
  )

  return `# ${containerName} - SpinDB Docker Export

This directory contains a Docker-ready package for running your SpinDB ${displayName} container.

## Quick Start

\`\`\`bash
# Start the container
docker compose up -d

# View logs
docker compose logs -f

# Stop the container
docker compose down
\`\`\`

## Configuration

| Setting | Value |
|---------|-------|
| Engine | ${displayName} ${version} |
| Port | ${port} |
| Database | ${database} |
| Username | spindb |

## Connection String

\`\`\`
${connectionTemplate}
\`\`\`

Replace \`<host>\` with your server's hostname or IP address.
Replace \`\${SPINDB_USER}\` and \`\${SPINDB_PASSWORD}\` with the values from \`.env\`.

## Security Notes

- The \`.env\` file contains auto-generated credentials. **Change these in production.**
- TLS certificates in \`certs/\` are self-signed. For production, replace with valid certificates.
- The default \`spindb\` user has full access to the database. Create restricted users for applications.

## Files

| File | Description |
|------|-------------|
| \`Dockerfile\` | Docker image definition |
| \`docker-compose.yml\` | Container orchestration |
| \`.env\` | Environment variables and credentials |
| \`entrypoint.sh\` | Container startup script |
| \`certs/\` | TLS certificates |
| \`data/\` | Database backup for initialization |

## Customization

### Change Port

Edit \`.env\`:
\`\`\`
PORT=5433
\`\`\`

### Use Custom Certificates

Replace the files in \`certs/\`:
- \`server.crt\` - TLS certificate
- \`server.key\` - TLS private key

### Disable TLS

Edit \`entrypoint.sh\` and remove TLS-related flags (not recommended for production).

---

Generated by [SpinDB](https://github.com/robertjbass/spindb)
`
}

/**
 * Export a SpinDB container to Docker-ready artifacts
 */
export async function exportToDocker(
  container: ContainerConfig,
  options: DockerExportOptions,
): Promise<DockerExportResult> {
  const {
    outputDir,
    port = container.port,
    includeData = true,
    backupPath,
    backupPaths,
    skipTLS = false,
  } = options

  const engine = container.engine
  const version = container.version
  const database = container.database
  const containerName = container.name
  // Get all databases for the container
  const databases = container.databases || [database]

  // Create output directory structure
  await mkdir(outputDir, { recursive: true })
  await mkdir(join(outputDir, 'certs'), { recursive: true })
  await mkdir(join(outputDir, 'data'), { recursive: true })

  const files: string[] = []

  // Generate credentials
  const credentials = generateCredentials()

  // Generate TLS certificates (if openssl is available and not skipped)
  if (!skipTLS) {
    const hasOpenSSL = await isOpenSSLAvailable()
    if (hasOpenSSL) {
      await generateTLSCertificates({
        outputDir: join(outputDir, 'certs'),
        commonName: 'localhost',
        validDays: 365,
      })
      files.push('certs/server.crt', 'certs/server.key')
    }
  }

  // Copy backup files if provided (multiple databases)
  if (includeData && backupPaths && backupPaths.length > 0) {
    for (const bp of backupPaths) {
      if (existsSync(bp.path)) {
        const backupFilename = basename(bp.path)
        await copyFile(bp.path, join(outputDir, 'data', backupFilename))
        files.push(`data/${backupFilename}`)
      }
    }
  } else if (includeData && backupPath && existsSync(backupPath)) {
    // Single backup file (legacy support)
    const backupFilename = basename(backupPath)
    await copyFile(backupPath, join(outputDir, 'data', backupFilename))
    files.push(`data/${backupFilename}`)
  }

  // Generate Dockerfile
  const dockerfile = generateDockerfile(engine)
  await writeFile(join(outputDir, 'Dockerfile'), dockerfile)
  files.push('Dockerfile')

  // Generate entrypoint.sh
  const useTLS = !skipTLS
  const entrypoint = generateEntrypoint(
    engine,
    containerName,
    database,
    databases,
    version,
    port,
    useTLS,
  )
  await writeFile(join(outputDir, 'entrypoint.sh'), entrypoint, { mode: 0o755 })
  files.push('entrypoint.sh')

  // Generate docker-compose.yml
  const dockerCompose = generateDockerCompose(
    containerName,
    engine,
    version,
    port,
    database,
  )
  await writeFile(join(outputDir, 'docker-compose.yml'), dockerCompose)
  files.push('docker-compose.yml')

  // Generate .env file
  const envFile = generateEnvFile(
    containerName,
    engine,
    version,
    port,
    database,
    credentials,
  )
  await writeFile(join(outputDir, '.env'), envFile)
  files.push('.env')

  // Generate README.md
  const readme = generateReadme(
    containerName,
    engine,
    version,
    port,
    database,
    useTLS,
  )
  await writeFile(join(outputDir, 'README.md'), readme)
  files.push('README.md')

  return {
    outputDir,
    credentials,
    port,
    engine,
    version,
    database,
    files,
  }
}

/**
 * Get the backup file path that would be used for a container export
 */
export function getExportBackupPath(
  outputDir: string,
  containerName: string,
  database: string,
  engine: Engine,
): string {
  const format = getDefaultFormat(engine)
  const extension = getBackupExtension(engine, format)
  return join(outputDir, 'data', `${containerName}-${database}${extension}`)
}
