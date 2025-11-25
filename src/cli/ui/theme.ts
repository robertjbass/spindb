import chalk from 'chalk'

/**
 * Color theme for spindb CLI
 */
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
    database: '🗄️',
    postgres: '🐘',
  },
}

/**
 * Format a header box
 */
export function header(text: string): string {
  const line = '─'.repeat(text.length + 4)
  return `
${chalk.cyan('┌' + line + '┐')}
${chalk.cyan('│')}  ${chalk.bold(text)}  ${chalk.cyan('│')}
${chalk.cyan('└' + line + '┘')}
`.trim()
}

/**
 * Format a success message
 */
export function success(message: string): string {
  return `${theme.icons.success} ${message}`
}

/**
 * Format an error message
 */
export function error(message: string): string {
  return `${theme.icons.error} ${chalk.red(message)}`
}

/**
 * Format a warning message
 */
export function warning(message: string): string {
  return `${theme.icons.warning} ${chalk.yellow(message)}`
}

/**
 * Format an info message
 */
export function info(message: string): string {
  return `${theme.icons.info} ${message}`
}

/**
 * Format a key-value pair
 */
export function keyValue(key: string, value: string): string {
  return `${chalk.gray(key + ':')} ${value}`
}

/**
 * Format a connection string box
 */
export function connectionBox(
  name: string,
  connectionString: string,
  port: number,
): string {
  return `
${chalk.cyan('┌─────────────────────────────────────────┐')}
${chalk.cyan('│')}  ${theme.icons.success} Container ${chalk.bold(name)} is ready!     ${chalk.cyan('│')}
${chalk.cyan('│')}                                         ${chalk.cyan('│')}
${chalk.cyan('│')}  ${chalk.gray('Connection string:')}                    ${chalk.cyan('│')}
${chalk.cyan('│')}  ${chalk.white(connectionString)}  ${chalk.cyan('│')}
${chalk.cyan('│')}                                         ${chalk.cyan('│')}
${chalk.cyan('│')}  ${chalk.gray('Port:')} ${chalk.green(String(port))}                              ${chalk.cyan('│')}
${chalk.cyan('└─────────────────────────────────────────┘')}
`.trim()
}
