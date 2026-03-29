type RedisCliAuth = {
  username?: string
  password?: string
}

function getRedisCliErrorMarkers(): RegExp[] {
  return [
    /^ERR\b/m,
    /\bNOAUTH\b/,
    /\bWRONGPASS\b/,
    /\bNOPERM\b/,
    /\bACL\b/,
  ]
}

export function shouldPassRedisCliUsername(username?: string): username is string {
  if (!username) {
    return false
  }

  const trimmed = username.trim()
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'default'
}

export function buildRedisCliArgs(
  port: number,
  auth?: RedisCliAuth,
  database?: string,
): string[] {
  const args = ['-h', '127.0.0.1', '-p', String(port)]

  if (database !== undefined) {
    args.push('-n', database)
  }

  if (shouldPassRedisCliUsername(auth?.username)) {
    args.push('--user', auth.username)
  }

  return args
}

export function buildRedisCliEnv(auth?: RedisCliAuth): NodeJS.ProcessEnv {
  const env = { ...process.env }

  if (auth?.password) {
    env.REDISCLI_AUTH = auth.password
  } else {
    delete env.REDISCLI_AUTH
  }

  return env
}

export function hasRedisCliError(
  stdout: string,
  stderr: string,
  inspectStdout: boolean,
): boolean {
  const patterns = getRedisCliErrorMarkers()
  const stderrText = stderr.trim()
  if (patterns.some((pattern) => pattern.test(stderrText))) {
    return true
  }

  if (!inspectStdout) {
    return false
  }

  const stdoutText = stdout.trim()
  return patterns.some((pattern) => pattern.test(stdoutText))
}

export type { RedisCliAuth }
