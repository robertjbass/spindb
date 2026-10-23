# Standalone DocumentDB 1.0

Tracker: https://github.com/Layerbase-LLC/layerbase-cloud/issues/3359

The native bundle combines the official GA Rust MongoDB wire gateway, PostgreSQL
17.11 and DocumentDB extensions. This is separate from the FerretDB
`postgresql-documentdb` backend. No runtime Docker dependency.

Initial support: Linux x64 and ARM64 with glibc 2.35 or newer. macOS, Windows,
and Docker export are unavailable until qualified. Explicit `--bind 0.0.0.0`
is available for trusted container networks behind a TLS terminator. The gateway
listener does not terminate TLS itself. Localhost remains the default. The gateway
requires SCRAM client authentication. SpinDB creates a random administrator
credential and saves it with its normal credential manager; `spindb url` returns
the connection URI. `--no-auth` is refused. Telemetry is disabled.

The backend accepts only peer-authenticated connections through an owner-private
Unix socket. It has no TCP listener. The bundle's exact component versions are
verified before startup and recorded in the data directory, so branch/reset and
rename preserve them. Unknown data and mismatched or missing pins are refused.

Use the existing MongoDB client tools (`mongosh`, `mongodump`, `mongorestore`),
installed with `spindb engines download mongodb 8`, then:

```sh
spindb create documents --engine documentdb --db-version 1 --database app
spindb start documents
spindb query documents 'db.items.insertOne({name: "example", quantity: 42})'
spindb url documents
```

`tests/integration/documentdb.test.ts` exercises the real CLI: authenticated
queries, persisted restart, branch isolation/reset, archive backup/restore,
stopped rename, exact-pin refusal and recovery. It accepts
`DOCUMENTDB_TEST_CLI` for a compiled or installed CLI entry point,
`DOCUMENTDB_TEST_BUNDLE` for an explicitly supplied candidate artifact, and
`DOCUMENTDB_TEST_MONGODB_BUNDLE`/`DOCUMENTDB_TEST_MONGODB_VERSION` to reuse clients.
It uses an isolated temporary home and leaves failed fixtures for diagnostics.

Published archives: https://github.com/robertjbass/hostdb/releases/tag/documentdb-1.0.0.
The normal integration test uses a fresh isolated home and downloads the exact
runtime from the registry. Candidate overrides are optional; release CI uses
published packages and actual downloads.

Cloud administrator provisioning uses `spindb users create NAME USER --database admin --password-stdin`. This is an owner-only local operation through PostgreSQL's private socket, matching upstream gateway-admin tooling. It grants full DocumentDB administrator access, validates the exact runtime pin and refuses an existing unrelated PostgreSQL role. Database-scoped user grants remain unsupported. Passwords supplied on stdin do not appear in process arguments.

## macOS ARM64 release candidate

The native-platform feature branch prepares Mac discovery and a manual candidate
qualification job. It is not a published platform release. HostDB PR257 must
pass native authentication, CRUD and persistence first; then dispatch
`qualify-documentdb.yml` with its `candidate_run` to exercise the compiled CLI's
branch/reset, backup/restore, rename and exact-pin checks. Publish HostDB and pin
that verified npm release before promoting this branch. Windows remains blocked
pending native gateway/backend qualification (HostDB issue134 / PR258).
