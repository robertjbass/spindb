export type MongoWireAuth = {
  username: string
  password: string
  authDatabase: string
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
