export type MongoWireAuth = {
  username: string
  password: string
  authDatabase: string
}

export function normalizeMongoHost(bindAddress?: string): string {
  return bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress ?? '127.0.0.1'
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
