# Supabase Integration Plan

> **Status:** Deferred. Code was implemented on `feature/supabase` branch (Feb 2026) then removed. This document captures everything learned for future implementation.

## Key Decision: Treat as an Engine, Not a Service Layer

The initial implementation treated Supabase as an optional "service layer" that attached to existing PostgreSQL containers. **This was the wrong approach.** Supabase inherently requires:

- Database migrations (roles, schemas, extensions, grants)
- User management (GoTrue creates auth tables, manages sessions)
- Schema modifications (`ALTER DEFAULT PRIVILEGES`, RLS role hierarchy)

Bolting these onto an existing PostgreSQL container without the user expecting it is problematic. A user enabling Supabase on their database shouldn't be surprised by 5 new roles, 2 new schemas, and altered default privileges.

**If Supabase is added in the future, it should be a full engine** — `spindb create myapp --engine supabase` — so the user knows from creation that this database has Supabase's opinions baked in. The PostgreSQL underneath is an implementation detail, like how FerretDB wraps PostgreSQL for MongoDB compatibility.

## Architecture (Future Engine Approach)

```
~/.spindb/containers/supabase/myapp/
├── container.json          # Engine: supabase, includes JWT config
├── data/                   # PostgreSQL data directory
└── supabase/               # Service PID files
    ├── gotrue.pid
    ├── postgrest.pid
    └── proxy.pid
```

Binaries:
```
~/.spindb/bin/
├── postgresql-17.4.0-darwin-arm64/    # PostgreSQL (dependency)
├── gotrue-2.185.1-linux-arm64/        # GoTrue auth service
└── postgrest-12.2.8-darwin-arm64/     # PostgREST API service
```

### Startup Order
1. PostgreSQL (database)
2. GoTrue (auth) → needs PostgreSQL
3. PostgREST (REST API) → needs PostgreSQL + authenticator role
4. API proxy (HTTP routing) → needs GoTrue + PostgREST

### Shutdown Order (reverse)
1. API proxy
2. PostgREST
3. GoTrue
4. PostgreSQL

## Binary Sources

### GoTrue (Authentication)

- **Repository:** `supabase/auth` (formerly `supabase/gotrue`)
- **Binary name in archive:** `auth` (NOT `gotrue`)
- **Archive format:** `.tar.gz`
- **Platform support:** Linux only (arm64, x64). No macOS or Windows builds from GitHub.
- **URL pattern:** `https://github.com/supabase/auth/releases/download/v{version}/auth-v{version}-{arch}.tar.gz`
- **Arch mapping:** `linux-arm64` → `arm64`, `linux-x64` → `x86`
- **macOS/Windows:** Would need cross-compilation via hostdb

### PostgREST (REST API)

- **Repository:** `PostgREST/postgrest`
- **Archive format:** `.tar.xz` (Unix), `.zip` (Windows)
- **Platform support:** macOS arm64, Linux arm64/x64, Windows x64
- **Tag format:** `vX.Y` NOT `vX.Y.Z` — trailing `.0` is stripped (e.g., version `12.2.0` → tag `v12.2`)
- **URL pattern:** `https://github.com/PostgREST/postgrest/releases/download/v{tag}/postgrest-v{tag}-{platform}.{ext}`
- **Platform mapping:**
  - `darwin-arm64` → `macos-aarch64`
  - `linux-x64` → `linux-static-x86-64`
  - `linux-arm64` → `linux-static-aarch64`
  - `win32-x64` → `windows-x86-64`

### Tested Version Combinations

| GoTrue | PostgREST | Status |
|--------|-----------|--------|
| 2.186.0 | 12.2.8 | Compatible |
| 2.185.1 | 12.2.8 | Compatible |

## PostgreSQL Migrations Required

When creating a Supabase engine container, these migrations run automatically during `spindb create`:

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Roles (Supabase RLS hierarchy)
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE supabase_admin NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;

-- Role hierarchy
GRANT anon TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role TO authenticator;
GRANT supabase_admin TO authenticator;

-- Schemas
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_admin;
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_admin;

-- Public schema grants
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO supabase_admin;

-- Default privileges (tables created in public are auto-exposed via PostgREST)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
```

All statements must be idempotent (`IF NOT EXISTS`, `DO $$ BEGIN ... END $$` for roles).

## JWT Generation

Uses Node.js built-in `crypto` — no external dependencies, Bun-compatible:

```typescript
function generateJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = base64url(
    createHmac('sha256', secret).update(`${header}.${body}`).digest()
  )
  return `${header}.${body}.${signature}`
}
```

- **JWT secret:** 256-bit random hex (`crypto.randomBytes(32).toString('hex')`)
- **Anon key:** `{ role: 'anon', iss: 'supabase', exp: +10 years }`
- **Service role key:** `{ role: 'service_role', iss: 'supabase', exp: +10 years }`
- **On clone:** Regenerate all secrets (JWT secret, anon key, service role key)

## Service Configuration

### GoTrue Environment Variables

```
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgresql://supabase_admin@127.0.0.1:{port}/{database}?sslmode=disable
GOTRUE_API_HOST=127.0.0.1
GOTRUE_API_PORT={gotruePort}
GOTRUE_JWT_SECRET={jwtSecret}
GOTRUE_SITE_URL=http://127.0.0.1:{proxyPort}
GOTRUE_EXTERNAL_EMAIL_ENABLED=true
GOTRUE_MAILER_AUTOCONFIRM=true
GOTRUE_DISABLE_SIGNUP=false
```

### PostgREST Environment Variables

```
PGRST_DB_URI=postgresql://authenticator@127.0.0.1:{port}/{database}?sslmode=disable
PGRST_DB_SCHEMAS=public,storage
PGRST_DB_ANON_ROLE=anon
PGRST_JWT_SECRET={jwtSecret}
PGRST_SERVER_PORT={postgrestPort}
PGRST_SERVER_HOST=127.0.0.1
```

## API Proxy

Lightweight Node.js HTTP server (no dependencies, Bun-compatible):

| Route | Target |
|-------|--------|
| `/auth/v1/*` | GoTrue (strips `/auth/v1` prefix) |
| `/rest/v1/*` | PostgREST (strips `/rest/v1` prefix) |
| `/*` | Studio fallback (future) |

Uses `http.createServer()` only. Spawned as a detached process via tsx.

## Default Ports

| Service | Default | Range |
|---------|---------|-------|
| Proxy (API gateway) | 54321 | 54321-54420 |
| Studio (web UI) | 54323 | 54323-54422 |
| GoTrue (auth) | 54324 | 54424-54523 |
| PostgREST (REST) | 54325 | 54524-54623 |
| pg_meta (metadata) | 54326 | 54624-54723 |

## Gotchas Discovered

1. **GoTrue is Linux-only** from GitHub releases. macOS/Windows need hostdb cross-compilation or build-from-source.
2. **PostgREST tags strip `.0`** — version `12.2.0` uses tag `v12.2`, not `v12.2.0`.
3. **GoTrue binary is named `auth`** in the archive, not `gotrue`.
4. **`spawnAsync` throws on non-zero exit** — no `.code` property on the result. Don't check return codes, just catch.
5. **All spawned services MUST use `stdio: ['ignore', 'ignore', 'ignore']`** — SpinDB-wide requirement to prevent file descriptor leaks.
6. **Health checks:** HTTP GET polling with 30-second timeout, 500ms interval.
7. **Temp files on Windows:** Use `os.tmpdir()`, NOT `process.env.TMPDIR || '/tmp'`.
8. **`authenticator` role must exist** before PostgREST starts — migration order matters.

## Implementation Checklist (When Ready)

If implementing as a full engine:

1. Follow [ENGINE_CHECKLIST.md](../ENGINE_CHECKLIST.md) for the 20+ file checklist
2. Engine name: `supabase`, alias: `supa`
3. PostgreSQL is a dependency — download PostgreSQL binary alongside Supabase services
4. `spindb create myapp --engine supabase` initializes PG + runs migrations + generates JWT
5. `spindb start myapp` starts PG → GoTrue → PostgREST → proxy (sequential, health-checked)
6. `spindb stop myapp` stops in reverse order
7. `spindb connect myapp` opens psql (default) or shows REST API info
8. Default port: PostgreSQL port (e.g., 5432), Supabase services on 54321+
9. Backup/restore: pg_dump/pg_restore (same as PostgreSQL engine)
10. Docker export: PostgreSQL + GoTrue + PostgREST + proxy in single container

## Deferred Components

- **Supabase Studio** — Next.js standalone app, needs pg_meta running. Complex to package.
- **pg_meta** — PostgreSQL metadata API (Node.js). Needed by Studio.
- **Supabase Storage** — File storage service.
- **Supabase Realtime** — WebSocket subscriptions (Elixir app, no standalone binary — likely never viable for SpinDB).
