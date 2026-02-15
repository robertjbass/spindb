import chalk from 'chalk'

export const theme = {
  // Brand colors
  primary: chalk.cyan,
  secondary: chalk.gray,
  accent: chalk.magenta,

  // Status colors
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,

  // Text styles
  bold: chalk.bold,
  dim: chalk.dim,
  italic: chalk.italic,

  // Semantic helpers
  containerName: chalk.cyan.bold,
  version: chalk.yellow,
  port: chalk.green,
  path: chalk.gray,
  command: chalk.cyan,

  // Status badges
  running: chalk.green.bold('● running'),
  stopped: chalk.gray('○ stopped'),
  created: chalk.blue('◐ created'),

  // Icons
  icons: {
    success: chalk.green('✔'),
    error: chalk.red('✖'),
    warning: chalk.yellow('⚠'),
    info: chalk.blue('ℹ'),
    arrow: chalk.cyan('→'),
    bullet: chalk.gray('•'),
  },
}

export function header(text: string): string {
  return `${chalk.bold(text)}\n${chalk.gray('─'.repeat(40))}`
}

export function uiSuccess(message: string): string {
  return `${theme.icons.success} ${message}`
}

export function uiError(message: string): string {
  return `${theme.icons.error} ${chalk.red(message)}`
}

export function uiWarning(message: string): string {
  return `${theme.icons.warning} ${chalk.yellow(message)}`
}

export function uiInfo(message: string): string {
  return `${theme.icons.info} ${message}`
}

export function keyValue(key: string, value: string): string {
  return `${chalk.gray(key + ':')} ${value}`
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '')
}

function padToWidth(str: string, width: number): string {
  const visibleLength = stripAnsi(str).length
  const padding = Math.max(0, width - visibleLength)
  return str + ' '.repeat(padding)
}

export function box(lines: string[], padding: number = 2): string {
  // Calculate max visible width
  const maxWidth = Math.max(...lines.map((line) => stripAnsi(line).length))
  const innerWidth = maxWidth + padding * 2
  const horizontalLine = '─'.repeat(innerWidth)

  const boxLines = [chalk.cyan('┌' + horizontalLine + '┐')]

  for (const line of lines) {
    const paddedLine = padToWidth(line, maxWidth)
    boxLines.push(
      chalk.cyan('│') +
        ' '.repeat(padding) +
        paddedLine +
        ' '.repeat(padding) +
        chalk.cyan('│'),
    )
  }

  boxLines.push(chalk.cyan('└' + horizontalLine + '┘'))

  return boxLines.join('\n')
}

export function connectionBox(
  name: string,
  connectionString: string,
  port: number,
): string {
  const lines = [
    `${theme.icons.success} Container ${chalk.bold(name)} is ready!`,
    '',
    chalk.gray('Connection string:'),
    chalk.white(connectionString),
    '',
    `${chalk.gray('Port:')} ${chalk.green(String(port))}`,
  ]

  return box(lines)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
  )
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(1)} ${units[i]}`
}
