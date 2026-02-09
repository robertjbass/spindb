export function validateTypedbConnectionString(input: string): string | null {
  const hostPortPattern = /^(?:[\w.-]+|\[[\da-fA-F:]+\]):\d+(?:\/.*)?$/
  if (
    !input.startsWith('typedb://') &&
    !input.startsWith('typedb-core://') &&
    !input.startsWith('http://') &&
    !input.startsWith('https://') &&
    !hostPortPattern.test(input)
  ) {
    return 'Connection string must be host:port, [IPv6]:port, typedb://, typedb-core://, or http(s)://'
  }
  return null
}
