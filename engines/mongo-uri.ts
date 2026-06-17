export type MongoWireAuth = {
  username: string
  password: string
  authDatabase: string
}

export function normalizeMongoHost(bindAddress?: string): string {
  return bindAddress === '0.0.0.0' ? '127.0.0.1' : (bindAddress ?? '127.0.0.1')
}

/**
 * Resolve the candidate auth databases (mongo `authSource`) to try, in order.
 *
 * - An explicit `authSource` (persisted by a caller that provisioned the user
 *   elsewhere - e.g. a cloud that creates the root user in `admin` via
 *   MONGO_INITDB_ROOT) is authoritative: return it alone, no guessing.
 * - Otherwise fall back to `<database>` (spindb's own `createUser` puts the user
 *   in the target database) then `admin` (the MongoDB root-user convention), so
 *   backup/restore authenticate whether the user was created by spindb locally
 *   or by an external provisioner. Deduped, since `database` may be `admin`.
 */
export function resolveMongoAuthSources(options: {
  authSource?: string
  database?: string
}): string[] {
  if (options.authSource) {
    return [options.authSource]
  }
  const candidates = [options.database, 'admin'].filter((d): d is string => !!d)
  return candidates.length > 0 ? [...new Set(candidates)] : ['admin']
}

/**
 * Whether a mongodump/mongorestore failure looks like an authentication failure,
 * so the caller can retry against the next candidate authSource.
 */
export function isMongoAuthError(stderr: string): boolean {
  return /AuthenticationFailed|auth error|Authentication failed|not authorized|requires authentication|UserNotFound/i.test(
    stderr,
  )
}

export function buildMongoUri(
  port: number,
  database: string,
  auth: MongoWireAuth,
  host = '127.0.0.1',
): string {
  const credentials = `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@`
  const params = new URLSearchParams({
    authSource: auth.authDatabase,
  })

  return `mongodb://${credentials}${host}:${port}/${encodeURIComponent(database)}?${params.toString()}`
}
