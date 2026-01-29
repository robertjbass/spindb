# Database Pull Feature - Engine Support

Track implementation progress for the `spindb pull` command across all engines.

## Implementation Status

**Core implementation: ✅ Complete**
- `cli/commands/pull.ts` - CLI command with all options
- `core/pull-manager.ts` - Business logic with transaction support

**Modes:**
- ✅ Replace mode (default) - Backs up original, replaces with remote data
- ✅ Clone mode (`--as`) - Creates new database with remote data
- ✅ Dry run (`--dry-run`) - Preview changes without executing
- ✅ Post-pull scripts (`--post-script`) - Run custom scripts after pull
- ✅ JSON output (`--json`) - Machine-readable output

## Status Legend
- ✅ Implemented and tested
- 🚧 Implemented, needs testing
- ⏳ Planned
- ❌ Not applicable

## Engine Support Matrix

| Engine | Status | terminateConnections | dumpFromConnectionString | Notes |
|--------|--------|---------------------|-------------------------|-------|
| PostgreSQL | ✅ | pg_terminate_backend() | pg_dump -Fc | Full support, integration tested |
| MySQL | 🚧 | KILL CONNECTION | mysqldump | Implemented, needs pull command testing |
| MariaDB | 🚧 | KILL CONNECTION | mariadb-dump | Implemented, needs pull command testing |
| MongoDB | 🚧 | N/A (no-op) | mongodump --archive | Implemented, needs pull command testing |
| FerretDB | 🚧 | N/A (no-op) | pg_dump (backend) | Implemented, needs pull command testing |
| Redis | 🚧 | N/A (no-op) | BGSAVE -> copy | Implemented, needs pull command testing |
| Valkey | 🚧 | N/A (no-op) | BGSAVE -> copy | Implemented, needs pull command testing |
| SQLite | 🚧 | N/A (no-op) | File copy/HTTP download | Implemented, needs pull command testing |
| DuckDB | 🚧 | N/A (no-op) | File copy/HTTP download | Implemented, needs pull command testing |
| ClickHouse | 🚧 | N/A (no-op) | clickhouse-client | Implemented, needs pull command testing |
| Qdrant | 🚧 | N/A (no-op) | REST snapshot API | Implemented, needs pull command testing |
| Meilisearch | 🚧 | N/A (no-op) | REST snapshot API | Implemented, needs pull command testing |
| CouchDB | 🚧 | N/A (no-op) | _all_docs -> JSON | Implemented, needs pull command testing |
| CockroachDB | 🚧 | N/A (no-op) | cockroach dump | Implemented, needs pull command testing |
| SurrealDB | 🚧 | N/A (no-op) | surreal export | Implemented, needs pull command testing |
| QuestDB | 🚧 | N/A (no-op) | psql (PG wire) | Implemented, needs pull command testing |

## What's Missing

### Testing Needed

1. **End-to-end pull command tests** - Only PostgreSQL has integration tests for `dumpFromConnectionString`. Need to verify the full `spindb pull` workflow works for each engine.

2. **terminateConnections validation** - Only PostgreSQL, MySQL, and MariaDB have real implementations. Other engines use the default no-op, which may cause issues when dropping databases with active connections.

3. **Post-script testing** - The `SPINDB_CONTEXT` JSON file and legacy environment variables need verification across different script types (shell, TypeScript, Python).

4. **Error handling edge cases**:
   - Network timeouts during remote dump
   - Invalid credentials in connection string
   - Insufficient disk space for temp files
   - Transaction rollback on partial failures

### Future Enhancements

- [ ] Add `terminateConnections` implementations for engines that need it (ClickHouse, CockroachDB)
- [ ] Progress indicators during long remote dumps
- [ ] Support for compressed transfers
- [ ] Partial database sync (specific tables/collections)

## Implementation Notes

### PostgreSQL
- Uses `pg_dump -Fc` for custom format (compressed, fast)
- `pg_terminate_backend()` safely disconnects clients
- Implemented in v1.0.0

### MySQL/MariaDB
- `mysqldump` / `mariadb-dump` for SQL format
- `KILL CONNECTION id` to terminate sessions
- Must query `information_schema.processlist` first

### MongoDB
- `mongodump --archive` for single-file backup
- No connection termination needed (lock-free)
- `mongorestore --drop` handles overwrite

### File-Based (SQLite, DuckDB)
- Not applicable - use file copy operations instead
- Consider `spindb clone` for file-based containers

### REST API Engines (Qdrant, Meilisearch, CouchDB)
- Use snapshot/export API endpoints
- No connection termination concept
- May require server restart for some operations

## Command Usage

```bash
# Replace mode: Pull production into local database, backup original
spindb pull myapp --from postgresql://user:pass@prod.example.com/mydb

# Read URL from environment variable (recommended - keeps credentials out of shell history)
spindb pull myapp --from-env CLONE_FROM_DATABASE_URL

# Clone mode: Pull to new database (requires .env update)
spindb pull myapp --from-env PROD_DB_URL --as mydb_prod

# Preview what will happen
spindb pull myapp --from-env PROD_DB_URL --dry-run

# Target specific database
spindb pull myapp -d mydb --from-env PROD_DB_URL

# Run credential sync script after pull
spindb pull myapp --from-env PROD_DB_URL --post-script ./scripts/sync-credentials.ts

# Replace without backup (dangerous)
spindb pull myapp --from-env PROD_DB_URL --no-backup --force

# JSON output for scripting (includes connection URLs)
spindb pull myapp --from-env PROD_DB_URL --json
```

## Finding Containers

Use `spindb which` to find containers by port or URL:

```bash
# Find container by port
spindb which --port 5432

# Find container matching DATABASE_URL
spindb which --url "$DATABASE_URL"

# JSON output for scripting
spindb which --url "$DATABASE_URL" --json

# Use in scripts
CONTAINER=$(spindb which --url "$DATABASE_URL")
spindb pull "$CONTAINER" --from-env PROD_DB_URL
```

## JSON Output

The `--json` flag returns comprehensive information for scripting:

```json
{
  "success": true,
  "mode": "replace",
  "container": "myapp",
  "port": 5432,
  "database": "efficientdb",
  "databaseUrl": "postgresql://postgres@127.0.0.1:5432/efficientdb",
  "backupDatabase": "efficientdb_20260129_143052",
  "backupUrl": "postgresql://postgres@127.0.0.1:5432/efficientdb_20260129_143052",
  "source": "postgresql://user:***@prod.example.com/db",
  "message": "Pulled remote data into \"efficientdb\", backup at \"efficientdb_20260129_143052\""
}
```

## Post-Pull Scripts

Post-pull scripts receive a JSON context file via `SPINDB_CONTEXT` environment variable:

```json
{
  "container": "myapp",
  "engine": "postgresql",
  "mode": "replace",
  "port": 5432,
  "newDatabase": "efficientdb",
  "newUrl": "postgresql://postgres@127.0.0.1:5432/efficientdb",
  "originalDatabase": "efficientdb_20260129_143052",
  "originalUrl": "postgresql://postgres@127.0.0.1:5432/efficientdb_20260129_143052"
}
```

Legacy environment variables are also available:
- `SPINDB_CONTAINER` - Container name
- `SPINDB_DATABASE` - Target database with new data
- `SPINDB_BACKUP_DATABASE` - Backup database with original data
- `SPINDB_PORT` - Container port
- `SPINDB_ENGINE` - Engine type

---

## Example: Production Clone Script

This example shows a complete script for cloning production data locally with credential preservation. This pattern is common for development workflows.

### Simplified Version (using spindb pull + inline credential sync)

```typescript
#!/usr/bin/env tsx
/**
 * Clone Production Database to Local Development
 *
 * Usage:
 *   pnpm db:clone-prod              # Clone to {database}_prod
 *   pnpm db:clone-prod --replace    # Replace current database
 *   pnpm db:clone-prod --dry-run    # Preview changes
 */

import 'dotenv/config'
import chalk from 'chalk'
import { execSync, spawnSync } from 'child_process'

// Configuration from .env
const DATABASE_URL = process.env.DATABASE_URL!
const CLONE_FROM_DATABASE_URL = process.env.CLONE_FROM_DATABASE_URL!

// Parse args
const args = process.argv.slice(2)
const replaceOriginal = args.includes('--replace')
const dryRun = args.includes('--dry-run')

// Safety validation
function validateSafety(): void {
  const errors: string[] = []
  if (process.env.NODE_ENV !== 'development') errors.push('NODE_ENV must be "development"')
  if (!DATABASE_URL?.match(/localhost|127\.0\.0\.1/)) errors.push('DATABASE_URL must be localhost')
  if (process.env.VERCEL) errors.push('Cannot run on Vercel')
  if (!CLONE_FROM_DATABASE_URL) errors.push('CLONE_FROM_DATABASE_URL not set')

  if (errors.length) {
    errors.forEach(e => console.error(chalk.red(`✗ ${e}`)))
    process.exit(1)
  }
  console.log(chalk.green('✓ Safety checks passed'))
}

// Sync credentials from backup to new database
function syncCredentials(backupUrl: string, newUrl: string): void {
  console.log(chalk.dim('Syncing local credentials...'))

  // Get users with credentials from backup
  const usersJson = execSync(
    `psql "${backupUrl}" -t -A -c "SELECT json_agg(row_to_json(t)) FROM (SELECT email, hash, salt FROM users WHERE hash IS NOT NULL) t"`,
    { encoding: 'utf-8' }
  ).trim()

  if (!usersJson || usersJson === 'null') {
    console.log(chalk.dim('No users with credentials to sync'))
    return
  }

  const users = JSON.parse(usersJson) as Array<{ email: string; hash: string; salt: string }>

  for (const user of users) {
    execSync(
      `psql "${newUrl}" -c "UPDATE users SET hash='${user.hash}', salt='${user.salt}' WHERE email='${user.email}'"`,
      { stdio: 'pipe' }
    )
  }

  console.log(chalk.green(`✓ Synced credentials for ${users.length} users`))
}

async function main(): Promise<void> {
  console.log(chalk.cyan.bold('\n  Production Database Clone\n'))

  validateSafety()

  // Find container matching DATABASE_URL
  const container = execSync(`spindb which --url "${DATABASE_URL}"`, { encoding: 'utf-8' }).trim()
  console.log(chalk.green(`✓ Container: ${container}`))

  // Build pull command
  const pullArgs = ['pull', container, '--from-env', 'CLONE_FROM_DATABASE_URL']

  if (!replaceOriginal) {
    const dbName = new URL(DATABASE_URL).pathname.slice(1).split('?')[0]
    pullArgs.push('--as', `${dbName}_prod`)
  }

  if (dryRun) {
    pullArgs.push('--dry-run')
  }

  pullArgs.push('--json')

  // Execute pull
  console.log(chalk.dim(`\nPulling from remote...\n`))

  const result = spawnSync('spindb', pullArgs, { encoding: 'utf-8' })

  if (result.status !== 0) {
    console.error(chalk.red(result.stderr || result.stdout))
    process.exit(result.status || 1)
  }

  const pullResult = JSON.parse(result.stdout)

  if (!dryRun && pullResult.backupUrl) {
    // Sync credentials from backup to new database
    syncCredentials(pullResult.backupUrl, pullResult.databaseUrl)
  }

  console.log(chalk.green.bold('\n✓ Clone complete!'))
  console.log(chalk.dim(`  Database: ${pullResult.databaseUrl}`))
  if (pullResult.backupUrl) {
    console.log(chalk.dim(`  Backup:   ${pullResult.backupUrl}`))
  }
  console.log(chalk.bgYellow.black('\n ⚡ Restart your dev server to use the new data. \n'))
}

main().catch(e => {
  console.error(chalk.red(e.message))
  process.exit(1)
})
```

### Post-Script Version (using --post-script flag)

Alternatively, use a separate post-script for credential sync:

**clone-prod.sh:**
```bash
#!/bin/bash
set -e

# Find container and run pull with post-script
CONTAINER=$(spindb which --url "$DATABASE_URL")
spindb pull "$CONTAINER" \
  --from-env CLONE_FROM_DATABASE_URL \
  --post-script ./scripts/sync-credentials.ts \
  "$@"  # Pass through --replace, --dry-run, etc.
```

**scripts/sync-credentials.ts:**
```typescript
#!/usr/bin/env tsx
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

// Read context from SPINDB_CONTEXT
const ctx = JSON.parse(readFileSync(process.env.SPINDB_CONTEXT!, 'utf-8'))

if (!ctx.originalUrl) {
  console.log('No backup - skipping credential sync')
  process.exit(0)
}

// Get users from backup
const usersJson = execSync(
  `psql "${ctx.originalUrl}" -t -A -c "SELECT json_agg(row_to_json(t)) FROM (SELECT email, hash, salt FROM users WHERE hash IS NOT NULL) t"`,
  { encoding: 'utf-8' }
).trim()

if (!usersJson || usersJson === 'null') {
  console.log('No credentials to sync')
  process.exit(0)
}

const users = JSON.parse(usersJson)

for (const user of users) {
  execSync(
    `psql "${ctx.newUrl}" -c "UPDATE users SET hash='${user.hash}', salt='${user.salt}' WHERE email='${user.email}'"`,
    { stdio: 'pipe' }
  )
}

console.log(`✓ Synced credentials for ${users.length} users`)
```

### Key Differences

| Approach | Pros | Cons |
|----------|------|------|
| Inline (single script) | All logic in one file, easier to debug | More boilerplate |
| Post-script | Cleaner separation, reusable sync script | Two files to maintain |

Both approaches benefit from:
- `spindb which` for auto-detecting containers
- `--from-env` for secure credential handling
- `--json` output with connection URLs for easy scripting

---

## Version-Compatible Script Pattern

If your project needs to support both older (v0.27.x) and newer (v0.28.0+) SpinDB versions, use a version router pattern:

```
scripts/clone-prod-db/
├── index.ts              # Version router
├── clone-prod-db-v1.ts   # SpinDB <= 0.27.x (uses restore --from-url)
├── clone-prod-db-v2.ts   # SpinDB >= 0.28.0 (uses pull --from-env)
└── README.md
```

**index.ts (Version Router):**
```typescript
#!/usr/bin/env tsx
import { execSync, spawn } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function getSpinDBVersion(): { major: number; minor: number } | null {
  try {
    const output = execSync('spindb --version', { encoding: 'utf-8' }).trim()
    const match = output.match(/(\d+)\.(\d+)/)
    if (!match) return null
    return { major: parseInt(match[1]), minor: parseInt(match[2]) }
  } catch {
    return null
  }
}

function supportsNewPullAPI(v: { major: number; minor: number }): boolean {
  return v.major > 0 || (v.major === 0 && v.minor >= 28)
}

const version = getSpinDBVersion()
if (!version) {
  console.error('SpinDB not found! Install with: npm install -g spindb')
  process.exit(1)
}

const useV2 = supportsNewPullAPI(version)
const script = join(__dirname, useV2 ? 'clone-prod-db-v2.ts' : 'clone-prod-db-v1.ts')

console.log(`SpinDB ${version.major}.${version.minor} detected, using ${useV2 ? 'v2' : 'v1'} script`)

const proc = spawn('tsx', [script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})

proc.on('close', (code) => process.exit(code ?? 0))
```

This pattern allows gradual migration while maintaining backwards compatibility with older SpinDB versions.
