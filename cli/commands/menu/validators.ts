export function validateTypedbConnectionString(input: string): string | null {
  const hostPortPattern = /^[\w.-]+:\d+(?:\/.*)?$/
  if (
    !input.startsWith('typedb://') &&
    !input.startsWith('typedb-core://') &&
    !input.startsWith('http://') &&
    !input.startsWith('https://') &&
    !hostPortPattern.test(input)
  ) {
    return 'Connection string must be host:port, typedb://, typedb-core://, or http(s)://'
  }
  return null
}
