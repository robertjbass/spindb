# SpinDB

[![npm version](https://img.shields.io/npm/v/spindb.svg)](https://www.npmjs.com/package/spindb)
[![npm downloads](https://img.shields.io/npm/dm/spindb.svg)](https://www.npmjs.com/package/spindb)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](LICENSE)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#supported-engines--platforms)

**One CLI for all your local databases.**

SpinDB is a universal database management tool that combines a package manager, a unified API, and native client tooling for 20 different database engines—all from a single command-line interface. No Docker, no VMs, no platform-specific installers. Just databases, running natively on your machine.

```bash
npm install -g spindb

# PostgreSQL for your API
spindb create api-db

# MongoDB for analytics
spindb create analytics --engine mongodb

# Redis for caching
spindb create cache --engine redis

# All running side-by-side, all managed the same way
```

---

## Supported Engines & Platforms

SpinDB supports **20 database engines** across **5 platform architectures**—all with a consistent API.

| Engine | Type | macOS ARM | macOS Intel | Linux x64 | Linux ARM | Windows |
|--------|------|:---------:|:-----------:|:---------:|:---------:|:-------:|
| 🐘 **PostgreSQL** | Relational SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🐬 **MySQL** | Relational SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦭 **MariaDB** | Relational SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🪶 **SQLite** | Embedded SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦆 **DuckDB** | Embedded OLAP | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🍃 **MongoDB** | Document Store | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦔 **FerretDB** | Document Store | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| 🔴 **Redis** | Key-Value | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔷 **Valkey** | Key-Value | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🏠 **ClickHouse** | Columnar OLAP | ✅ | ✅ | ✅ | ✅ | ❌ |
| 🧭 **Qdrant** | Vector Search | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔍 **Meilisearch** | Full-Text Search | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🛋️ **CouchDB** | Document Store | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🪳 **CockroachDB** | Distributed SQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🌀 **SurrealDB** | Multi-Model | ✅ | ✅ | ✅ | ✅ | ✅ |
| ⏱️ **QuestDB** | Time-Series | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🤖 **TypeDB** | Knowledge Graph | ✅ | ✅ | ✅ | ✅ | ✅ |
| 📈 **InfluxDB** | Time-Series | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔮 **Weaviate** | Vector Database | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🐯 **TigerBeetle** | Financial Ledger | ✅ | ✅ | ✅ | ✅ | ✅ |

**100 combinations. One CLI. Zero configuration.**

> ClickHouse is available on Windows via WSL. FerretDB v1 is natively supported on Windows (uses plain PostgreSQL backend); v2 requires macOS/Linux.

---

## Quick Start

```bash
# Install
npm install -g spindb    # or: pnpm add -g spindb

# Create and start a PostgreSQL database
spindb create myapp --start --connect
```

That's it! Your PostgreSQL database is running on `localhost:5432`, and data persists in `~/.spindb/containers/postgresql/myapp/`.

---

## Basic Usage

### PostgreSQL

```bash
spindb create myapp                              # Create (default engine)
spindb start myapp                               # Start
spindb connect myapp                             # Open psql shell
spindb run myapp -c "SELECT version()"           # Run inline SQL
spindb run myapp ./schema.sql                    # Run SQL file
spindb backup myapp --format sql                 # Backup
spindb url myapp --copy                          # Copy connection string
```

### MongoDB

```bash
spindb create logs --engine mongodb --start
spindb run logs -c "db.users.insertOne({name: 'Alice'})"
spindb run logs -c "db.users.find().pretty()"
spindb connect logs                              # Open mongosh
spindb backup logs --format archive
```

### Redis

```bash
spindb create cache --engine redis --start
spindb run cache -c "SET mykey myvalue"
spindb run cache -c "GET mykey"
spindb connect cache                             # Open redis-cli
spindb connect cache --iredis                    # Enhanced shell
```

### InfluxDB

```bash
spindb create tsdata --engine influxdb --start
spindb run tsdata ./seed.lp                      # Seed with line protocol
spindb run tsdata -c "SHOW TABLES"               # Run inline SQL
spindb run tsdata ./queries.sql                   # Run SQL file
spindb connect tsdata                             # Interactive SQL console
```

> InfluxDB supports two file formats: `.lp` (line protocol) for writing data, `.sql` for queries.

### Weaviate

```bash
spindb create vectors --engine weaviate --start
spindb query vectors "GET /v1/schema"             # Query via REST API
spindb connect vectors                            # Open web dashboard
```

> Weaviate is an AI-native vector database. REST API on default port 8080, gRPC on port+1. Uses classes/collections.

### TigerBeetle

```bash
spindb create ledger --engine tigerbeetle --start
spindb connect ledger                            # Open REPL
```

> TigerBeetle is a high-performance financial ledger database. Custom binary protocol on default port 3000. Uses REPL for interaction.

### Enhanced Shells & Visual Tools

```bash
spindb connect myapp --pgcli                     # Enhanced PostgreSQL shell
spindb connect myapp --dblab                     # Visual TUI (table browser)
spindb connect mydb --mycli                      # Enhanced MySQL/MariaDB shell
spindb connect mydb --ui                         # Built-in Web UI (DuckDB)
```

### Any Engine

```bash
spindb create mydb --engine [postgresql|mysql|mariadb|mongodb|ferretdb|redis|valkey|clickhouse|sqlite|duckdb|qdrant|meilisearch|couchdb|cockroachdb|surrealdb|questdb|typedb|influxdb|weaviate|tigerbeetle]
spindb start mydb
spindb connect mydb
spindb backup mydb
spindb restore mydb backup.dump
spindb clone mydb mydb-copy
spindb delete mydb -f
```

Every engine works the same way. Learn one, use them all.

> See [CHEATSHEET.md](CHEATSHEET.md) for the complete command reference, connection strings, backup formats, scripting patterns, and more.

---

## Why SpinDB?

### The Problem with Current Tools

**Docker** is powerful but heavy—requires a daemon, runs containers in a VM (on macOS/Windows), and adds complexity for simple local databases.

**GUI tools** like DBngin and Postgres.app are great but platform-specific, don't support scripting, and lack a unified interface across engines.

**System package managers** (brew, apt, etc.) work but create version conflicts, require manual configuration, and don't provide consistent management across databases.

### SpinDB's Approach

SpinDB runs databases as **native processes** with **isolated data directories**:

- **No Docker daemon or VM overhead** - Direct process execution
- **No system installation conflicts** - Each database version lives in `~/.spindb/bin/`
- **No manual configuration** - Databases start with sensible defaults
- **Cross-platform consistency** - Same commands work on macOS, Linux, and Windows
- **Multi-version support** - Run PostgreSQL 14 and 18 side-by-side
- **Unified interface** - Manage PostgreSQL, MongoDB, and Redis the same way

### Comparison: Database GUI Tools

*For developers who prefer visual interfaces or use macOS-native tools.*

| Feature | SpinDB | DBngin | Postgres.app | Laragon |
|---------|--------|--------|--------------|---------|
| **Engines supported** | 20 | 3 (PG/MySQL/Redis) | 1 (PostgreSQL) | 4 (PG/MySQL/MariaDB/MongoDB) |
| CLI-first | ✅ | ❌ GUI-only | ❌ GUI-only | ⚠️ Limited CLI |
| Multi-version support | ✅ | ✅ | ✅ | ✅ |
| Built-in backup/restore | ✅ | ✅ | ❌ | ⚠️ Manual |
| Clone databases | ✅ | ✅ | ❌ | ❌ |
| macOS | ✅ | ✅ | ✅ | ❌ |
| Linux | ✅ | ❌ | ❌ | ❌ |
| Windows | ✅ | ❌ | ❌ | ✅ |
| Free for commercial use | ❌ | ✅ | ✅ | ✅ |

### Comparison: Docker & Containers

*For developers already using containerization.*

| Feature | SpinDB | Docker Desktop | Podman | OrbStack |
|---------|--------|----------------|--------|----------|
| **Engines supported** | 20 unified | Any (manual setup) | Any (manual setup) | Any (manual setup) |
| Daemon required | ❌ | ✅ | ❌ (rootless) | ✅ |
| Resource overhead | Native | VM + containers | VM + containers | VM + containers |
| Built-in backup/restore | ✅ | ❌ Manual | ❌ Manual | ❌ Manual |
| Connection strings | ✅ Auto-generated | ❌ Manual | ❌ Manual | ❌ Manual |
| Version switching | ✅ Instant | ⚠️ Pull images | ⚠️ Pull images | ⚠️ Pull images |
| Database-specific CLI | ✅ Included | ❌ Exec into container | ❌ Exec into container | ❌ Exec into container |
| Prod parity | ⚠️ Native binaries | ✅ Exact images | ✅ Exact images | ✅ Exact images |
| Free for commercial use | ❌ | ⚠️ Paid for orgs | ✅ | ⚠️ Paid tiers |

### Comparison: Package Managers

*For developers who "just install" databases system-wide.*

| Feature | SpinDB | Homebrew | apt/winget | asdf-vm |
|---------|--------|----------|------------|---------|
| **Engines supported** | 20 unified | Many (separate formulas) | Many (separate packages) | Many (plugins) |
| Multi-version side-by-side | ✅ | ⚠️ Complex | ❌ | ✅ |
| Isolated data directories | ✅ | ❌ System-wide | ❌ System-wide | ❌ |
| Built-in backup/restore | ✅ | ❌ | ❌ | ❌ |
| Unified CLI across engines | ✅ | ❌ | ❌ | ❌ |
| No root/sudo required | ✅ | ✅ | ❌ | ✅ |
| macOS | ✅ | ✅ | ❌ | ✅ |
| Linux | ✅ | ✅ | ✅ | ✅ |
| Windows | ✅ | ❌ | ✅ (winget) | ⚠️ WSL |
| Free for commercial use | ❌ | ✅ | ✅ | ✅ |

> **Note on licensing:** SpinDB requires a commercial license for business use. For personal projects, education, research, nonprofits, and government use, SpinDB is free. See [License](#license) for details.

---

## How It Works

SpinDB uses "container" terminology loosely—there's no Docker involved. When you create a container, SpinDB:

1. **Downloads database binaries** from [hostdb](https://github.com/robertjbass/hostdb) or uses system installations
2. **Creates isolated data directories** at `~/.spindb/containers/{engine}/{name}/`
3. **Runs databases as native processes** on your machine

### Storage Layout

```bash
~/.spindb/
├── bin/                                    # Downloaded binaries
│   ├── postgresql-18.1.0-darwin-arm64/     # ~45 MB
│   ├── mysql-9.0.1-darwin-arm64/           # ~200 MB
│   └── mongodb-8.0-darwin-arm64/           # ~200 MB
├── containers/                             # Server-based databases
│   ├── postgresql/
│   │   └── myapp/
│   │       ├── container.json
│   │       ├── data/
│   │       ├── credentials/              # User credential .env.<username> files
│   │       └── postgres.log
│   ├── mysql/
│   └── mongodb/
├── logs/                                   # SpinDB error logs
└── config.json                             # Tool paths and settings

# File-based databases (SQLite, DuckDB) store in project directories
./myproject/
└── app.sqlite                              # Created with: spindb create app -e sqlite
```

### Data Persistence

Databases run as **native processes**, and **data persists across restarts**. Your data is never deleted unless you explicitly run `spindb delete`.

### Export to Docker

SpinDB doesn't require Docker for local development, but it can repackage your database as a Docker image for deployment:

```bash
spindb export docker mydb -o ./deploy
cd ./deploy && docker compose build --no-cache && docker compose up -d
```

See [DEPLOY.md](DEPLOY.md) for comprehensive deployment documentation.

---

## Limitations

- **Local only** - Databases bind to `127.0.0.1`. Remote connection support planned for v1.1.
- **ClickHouse Windows** - Not supported (hostdb doesn't build for Windows).
- **FerretDB Windows** - v1 supported natively (plain PostgreSQL backend). v2 not supported (postgresql-documentdb has startup issues); use WSL for v2.
- **Qdrant, Meilisearch, CouchDB, Weaviate** - Use REST API instead of CLI shell. Access via HTTP at the configured port.
- **TigerBeetle** - Custom binary protocol only. No SQL or REST API. Interact via REPL (`spindb connect`) or client libraries.

---

## Troubleshooting

### Port Already in Use

```bash
spindb create mydb --port 5433
```

### Container Won't Start

```bash
spindb logs mydb
```

### Client Tool Not Found

```bash
spindb deps install
spindb deps check
```

### Health Check

```bash
spindb doctor          # Interactive health check
spindb doctor --fix    # Auto-fix all issues
```

### Reset Everything

```bash
rm -rf ~/.spindb
```

This deletes all containers, binaries, and configuration. Use with caution.

---

## Roadmap

See [TODO.md](TODO.md) for the complete roadmap and future plans.

---

## Use Cases

### Migration & Portability

- **Cloud Migration Pipeline** - Create a SpinDB container, restore from an existing database, export to Docker, deploy to any cloud provider
- **Cross-Platform Migration** - Move databases between ARM Mac, x64 Linux, Windows, and Apple Silicon transparently via backup/restore
- **MongoDB to FerretDB** - Test MongoDB-to-FerretDB migration locally before infrastructure changes

### Development Workflow

- **Multiple Database Versions** - Run PostgreSQL 14 and 18 side-by-side for compatibility testing
- **Git-Triggered Database Branching** - Use git hooks to clone database state per branch
- **Environment Synchronization** - Pull production data locally for realistic development
- **Rapid Prototyping** - Spin up PostgreSQL, MongoDB, and Redis in minutes, compare patterns, delete without cleanup

### Testing & CI/CD

- **Ephemeral Test Databases** - Fresh database instances for each test run with automatic teardown
- **Schema Migration Testing** - Clone production, run migrations, validate, iterate without risk
- **Data Validation** - Use DuckDB or PostgreSQL to validate data pipelines with aggregate queries

### Platform Gaps

- **Redis/Valkey on Windows** - No official Windows builds exist; SpinDB provides them
- **ClickHouse on macOS** - No Homebrew complexity
- **FerretDB anywhere** - MongoDB-compatible without Docker

### Embedding & Integration

- **LLM Agent Integration** - Connect AI agents to databases via CLI with JSON output mode
- **AI Tool Embedding** - Qdrant for vector search, DuckDB for analytics, SQLite for conversation history
- **Desktop Applications** - Ship relocatable database binaries inside apps

### Deployment

- **Local-to-Cloud** - Export to Docker image, push to registry, deploy to any container platform
- **Production Data Anonymization** - Clone production, anonymize, develop safely
- **Disaster Recovery Practice** - Practice restore workflows without production risk

### Infrastructure

SpinDB can serve as the database layer for larger systems:

- **Backend-as-a-Service** - A database-agnostic Neon/Supabase-style platform using SpinDB primitives (`create`, `clone`, `backup`, `restore`)
- **Desktop GUI** - A cross-platform database management app (Tauri/Electron) wrapping SpinDB
- **Team Environments** - Export/import container configurations for consistent team setups

---

## Contributing

We welcome contributions! SpinDB is built with:

- **Runtime:** Node.js 18+ with TypeScript
- **Execution:** `tsx` for direct TypeScript execution
- **Package Manager:** pnpm (strictly enforced)
- **CLI Framework:** Commander.js
- **Interactive UI:** Inquirer.js, Chalk, Ora

See [TODO.md](TODO.md#contributing) for development setup, PR requirements, and testing guidelines.

See [ARCHITECTURE.md](ARCHITECTURE.md) for project architecture details.

See [CLAUDE.md](CLAUDE.md) for AI-assisted development context.

See [ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md) for adding new database engines.

---

## Acknowledgments

SpinDB is powered by:

- **[hostdb](https://github.com/robertjbass/hostdb)** - Pre-compiled database binaries for 20 engines across all major platforms. Makes Docker-free multi-version database support possible.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE)

SpinDB is **free** for:
- Personal use and hobby projects
- Educational institutions and students
- Academic and scientific research
- Nonprofit organizations
- Government agencies

**Commercial use requires a separate license.** For commercial licensing inquiries, please open an issue or contact the maintainer.

---

## Links

- **GitHub:** [github.com/robertjbass/spindb](https://github.com/robertjbass/spindb)
- **npm:** [npmjs.com/package/spindb](https://www.npmjs.com/package/spindb)
- **hostdb:** [github.com/robertjbass/hostdb](https://github.com/robertjbass/hostdb)
- **Issues:** [github.com/robertjbass/spindb/issues](https://github.com/robertjbass/spindb/issues)

---

**Questions? Found a bug? Have a feature request?**

Open an issue: [github.com/robertjbass/spindb/issues](https://github.com/robertjbass/spindb/issues)
