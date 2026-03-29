export function buildMariaDbEnv(password?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (password !== undefined) {
    env.MYSQL_PWD = password
  } else {
    delete env.MYSQL_PWD
  }
  return env
}
