// Redis 7.0+ and every Valkey release default these three to `no`, which
// refuses CONFIG SET of protected paths (dir, dbfilename, ...), MODULE LOAD
// and DEBUG for every client. Writing them explicitly pins that refusal
// against a future default change or a hand-edited config, and keeps the
// intent visible in the generated file. Values equal the defaults, so a
// server that loads them behaves exactly as before.
export const HARDENING_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ['enable-protected-configs', 'no'],
  ['enable-module-command', 'no'],
  ['enable-debug-command', 'no'],
]

export const HARDENING_DIRECTIVES_BLOCK =
  '# Refuse CONFIG SET of protected paths, MODULE and DEBUG for all clients\n' +
  HARDENING_DIRECTIVES.map(([key, value]) => `${key} ${value}\n`).join('')

// Config-file engines patch existing configs on restart and never regenerate
// them, so a directive the file lacks is appended. A directive already present
// is left as it is, whatever its value: an operator who chose a value keeps it.
export function appendMissingHardeningDirectives(config: string): string {
  const missing = HARDENING_DIRECTIVES.filter(
    ([key]) => !new RegExp(`^\\s*${key}\\s`, 'mi').test(config),
  )
  if (missing.length === 0) return config
  const separator = config.endsWith('\n') ? '' : '\n'
  return (
    config +
    separator +
    missing.map(([key, value]) => `${key} ${value}\n`).join('')
  )
}
