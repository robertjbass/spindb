import { Command } from 'commander'
import chalk from 'chalk'
import { existsSync } from 'fs'
import {
  configManager,
  POSTGRESQL_TOOLS,
  MYSQL_TOOLS,
  ENHANCED_SHELLS,
  ALL_TOOLS,
} from '../../core/config-manager'
import { updateManager } from '../../core/update-manager'
import { uiError, uiSuccess, header, uiInfo } from '../ui/theme'
import { getEngineIcon } from '../constants'
import { createSpinner } from '../ui/spinner'
import { handleSettings } from './menu/settings-handlers'
import type { BinaryTool } from '../../types'

// Helper to display a tool's config
function displayToolConfig(
  tool: BinaryTool,
  binaryConfig: { path: string; version?: string; source: string } | undefined,
): void {
  if (binaryConfig) {
    const sourceLabel =
      binaryConfig.source === 'system'
        ? chalk.blue('system')
        : binaryConfig.source === 'custom'
          ? chalk.yellow('custom')
          : chalk.green('bundled')
    const versionLabel = binaryConfig.version
      ? chalk.gray(` (v${binaryConfig.version})`)
      : ''
    console.log(
      `    ${chalk.cyan(tool.padEnd(15))} ${binaryConfig.path}${versionLabel} [${sourceLabel}]`,
    )
  } else {
    console.log(
      `    ${chalk.cyan(tool.padEnd(15))} ${chalk.gray('not detected')}`,
    )
  }
}

export const configCommand = new Command('config')
  .alias('configure')
  .description('Manage spindb configuration')
  .action(async () => {
    // If run as bare command in TTY mode, open interactive settings
    // Note: icon mode preference is loaded globally in cli/index.ts before any command runs
    if (process.stdin.isTTY) {
      await handleSettings()
    } else {
      // Non-interactive: show help
      console.log(configCommand.helpInformation())
    }
  })
  .addCommand(
    new Command('show')
      .description('Show current configuration')
      .option('--json', 'Output as JSON')
      .action(async (options: { json?: boolean }) => {
        try {
          const config = await configManager.getConfig()

          if (options.json) {
            console.log(JSON.stringify(config, null, 2))
            return
          }

          console.log()
          console.log(header('SpinDB Configuration'))
          console.log()

          // PostgreSQL tools
          console.log(chalk.bold(`  ${getEngineIcon('postgresql')}PostgreSQL Tools:`))
          console.log(chalk.gray('  ' + '─'.repeat(60)))
          for (const tool of POSTGRESQL_TOOLS) {
            displayToolConfig(tool, config.binaries[tool])
          }
          console.log()

          // MySQL tools
          console.log(chalk.bold(`  ${getEngineIcon('mysql')}MySQL Tools:`))
          console.log(chalk.gray('  ' + '─'.repeat(60)))
          for (const tool of MYSQL_TOOLS) {
            displayToolConfig(tool, config.binaries[tool])
          }
          console.log()

          // Enhanced shells
          console.log(chalk.bold('  ✨ Enhanced Shells (optional):'))
          console.log(chalk.gray('  ' + '─'.repeat(60)))
          for (const tool of ENHANCED_SHELLS) {
            displayToolConfig(tool, config.binaries[tool])
          }
          console.log()

          if (config.updatedAt) {
            const isStale = await configManager.isStale()
            const staleWarning = isStale
              ? chalk.yellow(' (stale - run config detect to refresh)')
              : ''
            console.log(
              chalk.gray(
                `  Last updated: ${new Date(config.updatedAt).toLocaleString()}${staleWarning}`,
              ),
            )
            console.log()
          }
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('detect')
      .description('Auto-detect all database tools on your system')
      .action(async () => {
        try {
          console.log()
          console.log(header('Detecting Database Tools'))
          console.log()

          const spinner = createSpinner('Searching for database tools...')
          spinner.start()

          // Clear existing configs to force re-detection
          await configManager.clearAllBinaries()

          const result = await configManager.initialize()

          spinner.succeed('Detection complete')
          console.log()

          // Helper to display category results
          async function displayCategory(
            title: string,
            icon: string,
            found: BinaryTool[],
            missing: BinaryTool[],
          ): Promise<void> {
            console.log(chalk.bold(`  ${icon} ${title}:`))

            if (found.length > 0) {
              for (const tool of found) {
                const config = await configManager.getBinaryConfig(tool)
                if (config) {
                  const versionLabel = config.version
                    ? chalk.gray(` (v${config.version})`)
                    : ''
                  console.log(
                    `    ${chalk.green('✓')} ${chalk.cyan(tool.padEnd(15))} ${config.path}${versionLabel}`,
                  )
                }
              }
            }

            if (missing.length > 0) {
              for (const tool of missing) {
                console.log(
                  `    ${chalk.gray('○')} ${chalk.gray(tool.padEnd(15))} not found`,
                )
              }
            }

            console.log()
          }

          await displayCategory(
            'PostgreSQL Tools',
            getEngineIcon('postgresql'),
            result.postgresql.found,
            result.postgresql.missing,
          )
          await displayCategory(
            'MySQL Tools',
            getEngineIcon('mysql'),
            result.mysql.found,
            result.mysql.missing,
          )
          await displayCategory(
            'Enhanced Shells (optional)',
            '✨',
            result.enhanced.found,
            result.enhanced.missing,
          )

          // Show install hints for missing required tools
          if (
            result.postgresql.missing.length > 0 ||
            result.mysql.missing.length > 0
          ) {
            console.log(chalk.gray('  Install missing tools:'))
            if (result.postgresql.missing.length > 0) {
              console.log(
                chalk.gray('    PostgreSQL: brew install postgresql@17'),
              )
            }
            if (result.mysql.missing.length > 0) {
              console.log(chalk.gray('    MySQL:      brew install mysql'))
            }
            console.log()
          }

          // Show enhanced shell hints
          if (result.enhanced.missing.length > 0) {
            console.log(chalk.gray('  Optional enhanced shells:'))
            if (result.enhanced.missing.includes('pgcli')) {
              console.log(chalk.gray('    pgcli: brew install pgcli'))
            }
            if (result.enhanced.missing.includes('mycli')) {
              console.log(chalk.gray('    mycli: brew install mycli'))
            }
            if (result.enhanced.missing.includes('usql')) {
              console.log(
                chalk.gray('    usql:  brew tap xo/xo && brew install usql'),
              )
            }
            console.log()
          }
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('set')
      .description('Set a custom binary path')
      .argument('<tool>', 'Tool name (psql, mysql, pgcli, etc.)')
      .argument('<path>', 'Path to the binary')
      .action(async (tool: string, path: string) => {
        try {
          // Validate tool name
          if (!ALL_TOOLS.includes(tool as BinaryTool)) {
            console.error(uiError(`Invalid tool: ${tool}`))
            console.log(chalk.gray(`  Valid tools: ${ALL_TOOLS.join(', ')}`))
            process.exit(1)
          }

          // Validate path exists
          if (!existsSync(path)) {
            console.error(uiError(`File not found: ${path}`))
            process.exit(1)
          }

          await configManager.setBinaryPath(tool as BinaryTool, path, 'custom')

          const config = await configManager.getBinaryConfig(tool as BinaryTool)
          const versionLabel = config?.version ? ` (v${config.version})` : ''

          console.log(uiSuccess(`Set ${tool} to: ${path}${versionLabel}`))
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('unset')
      .description('Remove a custom binary path')
      .argument('<tool>', 'Tool name (psql, mysql, pgcli, etc.)')
      .action(async (tool: string) => {
        try {
          // Validate tool name
          if (!ALL_TOOLS.includes(tool as BinaryTool)) {
            console.error(uiError(`Invalid tool: ${tool}`))
            console.log(chalk.gray(`  Valid tools: ${ALL_TOOLS.join(', ')}`))
            process.exit(1)
          }

          await configManager.clearBinaryPath(tool as BinaryTool)
          console.log(uiSuccess(`Removed ${tool} configuration`))
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('path')
      .description('Show the path for a specific tool')
      .argument('<tool>', 'Tool name (psql, mysql, pgcli, etc.)')
      .action(async (tool: string) => {
        try {
          // Validate tool name
          if (!ALL_TOOLS.includes(tool as BinaryTool)) {
            console.error(uiError(`Invalid tool: ${tool}`))
            console.log(chalk.gray(`  Valid tools: ${ALL_TOOLS.join(', ')}`))
            process.exit(1)
          }

          const path = await configManager.getBinaryPath(tool as BinaryTool)
          if (path) {
            console.log(path)
          } else {
            console.error(uiError(`${tool} not found`))
            console.log(
              chalk.gray(`  Run 'spindb config detect' to auto-detect tools`),
            )
            process.exit(1)
          }
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('update-check')
      .description('Enable or disable automatic update checks on startup')
      .argument('[state]', 'on or off (omit to show current status)')
      .action(async (state?: string) => {
        try {
          const cached = await updateManager.getCachedUpdateInfo()

          if (!state) {
            // Show current status
            const status = cached.autoCheckEnabled
              ? chalk.green('enabled')
              : chalk.yellow('disabled')
            console.log()
            console.log(`  Update checks on startup: ${status}`)
            console.log()
            console.log(chalk.gray('  Usage:'))
            console.log(
              chalk.gray('    spindb config update-check on   # Enable'),
            )
            console.log(
              chalk.gray('    spindb config update-check off  # Disable'),
            )
            console.log()
            return
          }

          if (state !== 'on' && state !== 'off') {
            console.error(uiError('Invalid state. Use "on" or "off"'))
            process.exit(1)
          }

          const enabled = state === 'on'
          await updateManager.setAutoCheckEnabled(enabled)

          if (enabled) {
            console.log(uiSuccess('Update checks enabled on startup'))
          } else {
            console.log(uiInfo('Update checks disabled on startup'))
            console.log(
              chalk.gray(
                '  You can still manually check with: spindb version --check',
              ),
            )
          }
        } catch (error) {
          const e = error as Error
          console.error(uiError(e.message))
          process.exit(1)
        }
      }),
  )
