export function validateTypedbConnectionString(input: string): string | null {
  const hostPortPattern = /^(?:[\w.-]+|\[[\da-fA-F:]+\]):\d+(?:\/.*)?$/
  const schemeHostPattern = /^(?:typedb|typedb-core|https?):\/\/[^/]+/
  if (!hostPortPattern.test(input) && !schemeHostPattern.test(input)) {
    return 'Connection string must be host:port, [IPv6]:port, typedb://, typedb-core://, or http(s):// with a host'
  }
  return null
}
