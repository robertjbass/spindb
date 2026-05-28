# Known Limitations

Tracked limitations in spindb that we intend to lift later. Each entry states
the limitation, where it lives in the code, the impact, and what "done" looks
like.

---

## Remote dump/restore works only for the Postgres and MySQL wire protocols

**Limitation.** `spindb restore <name> --from-url <connection-string>` (and the
`pull` path) connect to an EXTERNAL database, dump it, and load it into a
managed container. Today this only works when the source speaks the PostgreSQL
or MySQL wire protocol. The CLI hard-gates the URL scheme to `postgresql://`,
`postgres://`, and `mysql://` (`cli/commands/restore.ts:194-225`).

**Why it looks more supported than it is.** `dumpFromConnectionString` is
declared on the base engine (`engines/base-engine.ts:270`) and implemented in
every engine directory (all ~22). That makes it look like every engine can dump
from a remote source. In practice, only two implementations perform a real dump
against an arbitrary hosted provider:

- **PostgreSQL** (`engines/postgresql/index.ts`, `engines/postgresql/remote-version.ts`):
  detects the remote server version, selects a version-matched `pg_dump`, and
  dumps over the connection string. Works for ANY Postgres-wire host: Neon,
  Supabase, RDS, Aurora, Cloud SQL, Render, Railway, Heroku, CockroachDB, etc.
- **MySQL / MariaDB** (`engines/mysql/index.ts`, `engines/mariadb/index.ts`):
  `mysqldump` from the parsed connection string.

Every other engine's `dumpFromConnectionString` assumes a LOCAL or
self-managed instance, or is effectively a stub. Concrete example: libSQL
(`engines/libsql/index.ts:618`) parses the connection string as
`http://host:port` (default port 8080), builds a temporary LOCAL container
config, and calls the local backup path. It does NOT speak Turso's
authenticated remote `libsql://` protocol and never sends an auth token, so a
hosted Turso database cannot be imported. The same shape (local-only or stub)
applies to MongoDB, Redis, Valkey, ClickHouse, SurrealDB, CouchDB, FerretDB,
InfluxDB, TypeDB, Qdrant, Meilisearch, DuckDB, SQLite, QuestDB, Weaviate, and
TigerBeetle.

**Impact.** Downstream, Layerbase's "migrate from an external database" feature
(see `~/dev/layerbase-cloud/plans/active/migrate-from-external-db.md`) can
support any Postgres-wire or MySQL-wire provider for free, but CANNOT yet
import from Turso (libSQL), MongoDB Atlas, Upstash Redis, or any other
non-PG/MySQL hosted source.

**Done when (per engine).**

1. Implement a real `dumpFromConnectionString` that connects to the HOSTED form
   of the engine: correct remote protocol, TLS, and auth (e.g. Turso auth
   tokens, MongoDB Atlas SRV + SCRAM, Upstash REST/TLS), using the engine's
   native dump tool (`mongodump`, `redis-cli --rdb` / replica sync,
   `clickhouse-client` remote, etc.).
2. Relax the scheme gate in `cli/commands/restore.ts` (and the `pull` path) to
   admit that engine's remote scheme once its remote dump is implemented.
3. Add a real-binary test against a LIVE hosted instance of that engine before
   enabling it (we have been burned by stub paths that pass unit tests but fail
   against real providers).

Until all engines are covered, keep the scheme gate authoritative: it is the
single place that decides which sources are actually supported.
