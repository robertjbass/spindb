export type SurrealAuthLevel = 'root' | 'namespace' | 'database'

export type LocalSurrealAuth = {
  username: string
  password: string
  authLevel: SurrealAuthLevel
}

function normalizeSurrealAuthLevel(
  value?: string | null,
): SurrealAuthLevel | null {
  if (!value) {
    return null
  }

  switch (value.toLowerCase()) {
    case 'root':
      return 'root'
    case 'namespace':
    case 'ns':
      return 'namespace'
    case 'database':
    case 'db':
      return 'database'
    default:
      return null
  }
}

export function getBootstrapSurrealAuth(): LocalSurrealAuth {
  return {
    username: 'root',
    password: 'root',
    authLevel: 'root',
  }
}

export function inferSurrealAuthLevel(options: {
  username: string
  database?: string
  connectionString?: string
}): SurrealAuthLevel {
  try {
    if (options.connectionString) {
      const url = new URL(options.connectionString)
      const explicit = normalizeSurrealAuthLevel(
        url.searchParams.get('authLevel'),
      )
      if (explicit) {
        return explicit
      }
    }
  } catch {
    // Fall back to heuristic inference below.
  }

  if (options.username === 'root') {
    return 'root'
  }

  return options.database ? 'database' : 'namespace'
}

export function addSurrealAuthArgs(
  args: string[],
  auth: LocalSurrealAuth,
): string[] {
  args.push(
    '--user',
    auth.username,
    '--pass',
    auth.password,
    '--auth-level',
    auth.authLevel,
  )
  return args
}

export function buildSurrealUserConnectionString(options: {
  username: string
  password: string
  port: number
  namespace: string
  database: string
  authLevel: SurrealAuthLevel
}): string {
  const url = new URL(
    `surrealdb://127.0.0.1:${options.port}/${encodeURIComponent(options.namespace)}/${encodeURIComponent(options.database)}`,
  )
  url.username = options.username
  url.password = options.password
  url.searchParams.set('authLevel', options.authLevel)
  return url.toString()
}

export function parseSurrealConnectionString(connectionString: string): {
  host: string
  port: number
  username: string
  password: string
  namespace: string
  database: string
  authLevel: SurrealAuthLevel
} {
  const url = new URL(connectionString)
  const pathParts = url.pathname.split('/').filter(Boolean)

  const namespace =
    pathParts[0] && pathParts[0] !== 'rpc'
      ? decodeURIComponent(pathParts[0])
      : url.searchParams.get('ns') || 'test'
  const database =
    pathParts[1] && pathParts[0] !== 'rpc'
      ? decodeURIComponent(pathParts[1])
      : url.searchParams.get('db') || 'test'

  return {
    host: url.hostname || '127.0.0.1',
    port: parseInt(url.port, 10) || 8000,
    username: decodeURIComponent(url.username || 'root'),
    password: decodeURIComponent(url.password || 'root'),
    namespace,
    database,
    authLevel: inferSurrealAuthLevel({
      username: decodeURIComponent(url.username || 'root'),
      database,
      connectionString,
    }),
  }
}
