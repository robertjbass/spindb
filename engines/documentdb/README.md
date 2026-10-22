# Standalone DocumentDB 1.0

Implementation in progress. This engine is not yet registered or released.

Tracker: https://github.com/Layerbase-LLC/layerbase-cloud/issues/3359

The official GA bundle contains PostgreSQL, DocumentDB extensions, and a Rust
MongoDB wire gateway. It is not the existing FerretDB PostgreSQL-DocumentDB
backend. HostDB must publish the qualified bundle before SpinDB's dependency
is changed to consume it.

The native backend will listen only on an owner-private Unix socket. The
current upstream gateway requires peer authentication to PostgreSQL; MongoDB
clients authenticate separately. Initial configuration limits the gateway to
loopback until remote TLS is qualified. No runtime Docker requirement.

Remaining: native binary qualification, lifecycle integration, MongoDB clients,
backup/restore, branch/reset, exact-pin recovery, platform CI, and registry/UI
integration. Configuration unit checks do not prove those lifecycle gates.
