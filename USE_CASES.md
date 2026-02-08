# SpinDB Use Cases

## What is SpinDB?

**SpinDB is a universal database manager that runs any database locally without Docker.**

One command. Any database. Any platform.

```bash
spindb create myapp --engine postgresql
spindb create cache --engine redis
spindb create vectors --engine qdrant
```

### Core Features

| Feature | Description |
|---------|-------------|
| **Multi-Engine** | 17 databases: PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey, ClickHouse, SQLite, DuckDB, Qdrant, Meilisearch, CouchDB, CockroachDB, SurrealDB, FerretDB, QuestDB, TypeDB |
| **Zero Config** | No configuration files. No environment variables. Just create and start. |
| **Cross-Platform** | Native binaries for macOS, Linux, and Windows. ARM and x64. |
| **Version Control** | Run multiple versions simultaneously. Clone databases. Branch for features. |
| **Backup & Restore** | One command backup. Restore from local files or remote connection strings. |
| **Docker Export** | Convert any SpinDB container to a production-ready Docker image. |

### What SpinDB Replaces

SpinDB consolidates the functionality of multiple single-purpose tools:

| Tool | Platform | Databases | SpinDB Advantage |
|------|----------|-----------|------------------|
| [DBngin](https://dbngin.com/) | macOS | PostgreSQL, MySQL, Redis | + 13 more engines, cross-platform |
| [Postgres.app](https://postgresapp.com/) | macOS | PostgreSQL only | + 15 more engines, cross-platform |
| [XAMPP](https://www.apachefriends.org/) | All | MySQL, MariaDB | + 14 more engines, no Apache bundling |
| [MAMP](https://www.mamp.info/) | macOS/Windows | MySQL | + 15 more engines, no web server bundling |
| [Laragon](https://laragon.org/) | Windows | MySQL, PostgreSQL, MongoDB, Redis | + 12 more engines, cross-platform |
| [ServBay](https://servbay.com/) | macOS | PostgreSQL, MySQL, MariaDB, MongoDB, Redis | + 11 more engines, cross-platform |
| [Homebrew](https://brew.sh/) | macOS/Linux | Various | Version isolation, no conflicts, portable |
| Docker Compose | All | Any | Native performance, simpler setup, smaller footprint |

**The pitch:** Instead of installing 5 different apps to manage your databases, install one.

---

## Use Cases

### Migration & Portability

#### Cloud Migration Pipeline
Migrate an existing database (local or on-premises) to the cloud:
1. Create a new SpinDB container
2. Restore from the existing database's connection string
3. Export to Docker image
4. Deploy to any cloud provider

*Future: Add a layer to replace SpinDB binaries with pure Docker implementations for production.*

#### Cross-Platform Database Migration
Move databases between operating systems and architectures:
- ARM Mac → x64 Linux server
- Windows dev machine → Linux production
- Intel Mac → Apple Silicon Mac

SpinDB's backup/restore handles binary format differences transparently.

#### MongoDB ↔ FerretDB Migration
Test MongoDB-to-FerretDB migration locally. Validate application compatibility with FerretDB's PostgreSQL-backed MongoDB implementation before infrastructure changes.

### Platform Gaps

#### Native Binaries Where None Exist
- **Redis/Valkey on Windows** - No official Windows builds exist
- **ClickHouse on macOS** - No Homebrew complexity
- **FerretDB anywhere** - MongoDB-compatible without Docker

#### "Works on My Machine" Without Docker
Eliminate database inconsistencies across environments without Docker overhead:
- **Same database, any OS** - PostgreSQL on Windows = PostgreSQL on macOS = PostgreSQL on Linux
- **Same database, any architecture** - ARM and x64 developers share identical behavior
- **Version parity** - Everyone runs the exact same version, not "whatever Homebrew installed"
- **Native performance** - No virtualization layers
- **Portable backups** - Backup on one machine, restore on another regardless of platform

### Development Workflow

#### Multiple Database Versions
Run different versions simultaneously:
- Test compatibility across PostgreSQL 14, 15, 16, 17, and 18
- Validate migration scripts before upgrading production
- Reproduce version-specific bugs

#### Git-Triggered Database Branching
Use git hooks to branch databases automatically:
- Pre-checkout hook clones current database state
- Switch branches without polluting data
- Post-merge hook resets to known state

#### Environment Synchronization
Keep dev databases synchronized with production/staging:
- Reproduce production bugs with production-like data
- Test against realistic data volumes
- Validate schema migrations before deployment

#### Rapid Prototyping
Evaluate different engines before committing:
- Spin up PostgreSQL, MongoDB, and Redis in minutes
- Compare query patterns and performance
- Delete and recreate without cleanup

### Testing & CI/CD

#### Ephemeral Test Databases
- Unit tests get fresh database instances
- Integration tests run against real databases, not mocks
- Parallel test suites each get their own database
- Complete teardown after test runs

#### Data Validation
Use DuckDB or PostgreSQL to validate data pipelines:
- Load CSV/Parquet for schema validation
- Run aggregate queries for integrity checks
- Compare datasets across environments

#### Schema Migration Testing
- Clone production database locally
- Run migration scripts
- Validate application behavior
- Iterate without risk

### Embedding & Integration

#### Embedded Database Binaries
Ship complete database binaries inside applications:
- Desktop apps with local data storage
- CLI tools requiring temporary databases
- Development environments with built-in databases

SpinDB provides relocatable binaries for all supported platforms.

#### LLM Agent Integration
Connect AI agents to databases via CLI instead of MCP:
- Simpler than MCP server setup
- Works with any agent framework
- Scriptable via shell commands
- JSON output mode for programmatic access

#### AI Tool Embedding
- **Qdrant** for vector storage and semantic search
- **DuckDB** for CSV/Parquet analysis
- **SQLite** for conversation history
- No external dependencies for end users

### Accessibility

#### Zero-Config Database Access
Anyone can run databases regardless of skill level:
- No Docker knowledge required
- No manual binary management
- No configuration files
- Single command to create and start

#### Learning & Education
- Try MongoDB without Atlas accounts
- Learn PostgreSQL without Linux administration
- Explore vector databases (Qdrant, Meilisearch)
- Compare SQL vs document vs key-value paradigms

#### AI-Assisted Development
For developers building with AI assistance:
- AI can generate `spindb create` commands
- No context-switching to learn database installation
- Focus on application logic, not infrastructure

### Deployment

#### Local-to-Cloud
- Export local database to Docker image
- Push to container registry
- Deploy to any container platform
- Configuration travels with the app

#### Production Data Anonymization
Clone production → anonymize → develop safely:
- Restore production backup locally
- Run anonymization scripts
- Develop against realistic but safe data

#### Disaster Recovery Practice
- Practice restore workflows without production risk
- Validate backup integrity
- Train team members on recovery

### Multi-Project Development

#### Monorepo Service Isolation
Each microservice gets its own database:
- No port conflicts
- Independent version requirements
- Clean data separation
- Easy individual resets

#### Client Project Separation
Consultants and agencies:
- Each client has isolated databases
- No cross-contamination
- Easy archive and restore
- Context switching without reconfiguration

---

## Future Enhancements

Planned features that expand SpinDB's capabilities:

| Feature | Description |
|---------|-------------|
| **Schema-aware dummy data** | Introspect schema, understand foreign keys and constraints, generate realistic test datasets automatically |
| **TypeScript type generation** | Codegen types from table definitions for type-safe database access |
| **Database benchmarks** | Built-in tools to compare query performance across engines |
| **Automatic production sync** | Scheduled pulls from production with anonymization |
| **Team sharing** | Export/import container configurations for team consistency |
| **Extension testing** | Isolated environments for PostgreSQL extensions, Redis modules |

---

## Infrastructure

SpinDB is distributed as a **single binary** with no runtime dependencies. This makes it a foundational primitive for building larger systems.

### As a Platform Foundation

SpinDB can serve as the database layer for:

#### Backend-as-a-Service Platform
A Neon/Supabase-style platform, but database-agnostic:

| Capability | SpinDB Primitive |
|------------|------------------|
| Instant provisioning | `spindb create` |
| Database branching | `spindb clone` |
| Point-in-time restore | `spindb backup` / `spindb restore` |
| Connection pooling | Future: built-in pgbouncer-style proxy |
| Multi-engine support | PostgreSQL, MySQL, MongoDB, Redis, etc. |

Unlike Neon (PostgreSQL-only) or PlanetScale (MySQL-only), a SpinDB-backed platform supports **all 17 database engines** with unified management.

#### Desktop Application Backend
**Layerbase** - a modern replacement for legacy database GUI tools:

| Legacy Tool | Limitations | Layerbase + SpinDB |
|-------------|-------------|-------------------|
| [DBngin](https://dbngin.com/) | macOS only, 3 engines | Cross-platform, 17 engines |
| [Postgres.app](https://postgresapp.com/) | macOS only, PostgreSQL only | Cross-platform, 17 engines |
| [XAMPP](https://www.apachefriends.org/) | Bundles Apache/PHP, MySQL focus | Database-only, modern UI |
| [MAMP](https://www.mamp.info/) | Web server bundling, limited engines | Database-only, all engines |
| [Laragon](https://laragon.org/) | Windows only | Cross-platform |
| [ServBay](https://servbay.com/) | macOS only, bundles web servers | Cross-platform, database-only |
| [TablePlus](https://tableplus.com/) | Client only, no database management | Full lifecycle management |
| [DBeaver](https://dbeaver.io/) | Client only, no database management | Full lifecycle management |

Layerbase would provide:
- Native desktop UI (Electron/Tauri) wrapping SpinDB
- Visual database creation, start/stop, backup/restore
- Connection string generation and clipboard copy
- Integration with TablePlus, DBeaver, DataGrip for querying
- One-click Docker export for deployment

### Technical Integration

SpinDB exposes all functionality via:
- **CLI** - Full scriptability for automation
- **JSON output** - `--json` flag on all commands for programmatic access
- **Exit codes** - Proper error handling for CI/CD integration
- **Relocatable binaries** - Embed in other applications without installation

```bash
# Programmatic access example
spindb list --json | jq '.[] | select(.status == "running")'
spindb url mydb --json | jq -r '.url'
```

### Why This Matters

The database tooling market is fragmented:
- **Cloud platforms** (Neon, PlanetScale, Supabase) - Expensive, vendor lock-in, single-engine
- **Desktop tools** (DBngin, Postgres.app) - Platform-specific, limited engines
- **Docker** - Heavyweight, complex for simple use cases
- **Package managers** (Homebrew, apt) - Version conflicts, no isolation

SpinDB unifies local database management into a single tool that can power:
1. Individual developer workflows
2. Team development environments
3. CI/CD pipelines
4. Desktop applications
5. Cloud platforms

**One primitive. Unlimited applications.**
