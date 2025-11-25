import { Command } from 'commander'
import chalk from 'chalk'
import { existsSync } from 'fs'
import { configManager } from '@/core/config-manager'
import { error, success, header } from '@/cli/ui/theme'
import { createSpinner } from '@/cli/ui/spinner'
import type { BinaryTool } from '@/types'

const VALID_TOOLS: BinaryTool[] = [
  'psql',
  'pg_dump',
  'pg_restore',
  'pg_basebackup',
]

export const configCommand = new Command('config')
  .description('Manage spindb configuration')
  .addCommand(
    new Command('show')
      .description('Show current configuration')
      .action(async () => {
        try {
          const config = await configManager.getConfig()

          console.log()
          console.log(header('SpinDB Configuration'))
          console.log()

          console.log(chalk.bold('  Binary Paths:'))
          console.log(chalk.gray('  ' + '─'.repeat(50)))

          for (const tool of VALID_TOOLS) {
            const binaryConfig = config.binaries[tool]
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
                `  ${chalk.cyan(tool.padEnd(15))} ${binaryConfig.path}${versionLabel} [${sourceLabel}]`,
              )
            } else {
              console.log(
                `  ${chalk.cyan(tool.padEnd(15))} ${chalk.gray('not configured')}`,
              )
            }
          }

          console.log()

          if (config.updatedAt) {
            console.log(
              chalk.gray(
                `  Last updated: ${new Date(config.updatedAt).toLocaleString()}`,
              ),
            )
            console.log()
          }
        } catch (err) {
          const e = err as Error
          console.error(error(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('detect')
      .description('Auto-detect PostgreSQL client tools on your system')
      .action(async () => {
        try {
          console.log()
          console.log(header('Detecting PostgreSQL Tools'))
          console.log()

          const spinner = createSpinner(
            'Searching for PostgreSQL client tools...',
          )
          spinner.start()

          // Clear existing configs to force re-detection
          await configManager.clearAllBinaries()

          const { found, missing } = await configManager.initialize()

          spinner.succeed('Detection complete')
          console.log()

          if (found.length > 0) {
            console.log(chalk.bold('  Found:'))
            for (const tool of found) {
              const config = await configManager.getBinaryConfig(tool)
              if (config) {
                const versionLabel = config.version
                  ? chalk.gray(` (v${config.version})`)
                  : ''
                console.log(
                  `  ${chalk.green('✓')} ${chalk.cyan(tool.padEnd(15))} ${config.path}${versionLabel}`,
                )
              }
            }
            console.log()
          }

          if (missing.length > 0) {
            console.log(chalk.bold('  Not found:'))
            for (const tool of missing) {
              console.log(`  ${chalk.red('✗')} ${chalk.cyan(tool)}`)
            }
            console.log()
            console.log(chalk.gray('  Install missing tools:'))
            console.log(
              chalk.gray(
                '    macOS:  brew install libpq && brew link --force libpq',
              ),
            )
            console.log(chalk.gray('    Ubuntu: apt install postgresql-client'))
            console.log()
          }
        } catch (err) {
          const e = err as Error
          console.error(error(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('set')
      .description('Set a custom binary path')
      .argument('<tool>', `Tool name (${VALID_TOOLS.join(', ')})`)
      .argument('<path>', 'Path to the binary')
      .action(async (tool: string, path: string) => {
        try {
          // Validate tool name
          if (!VALID_TOOLS.includes(tool as BinaryTool)) {
            console.error(error(`Invalid tool: ${tool}`))
            console.log(chalk.gray(`  Valid tools: ${VALID_TOOLS.join(', ')}`))
            process.exit(1)
          }

          // Validate path exists
          if (!existsSync(path)) {
            console.error(error(`File not found: ${path}`))
            process.exit(1)
          }

          await configManager.setBinaryPath(tool as BinaryTool, path, 'custom')

          const config = await configManager.getBinaryConfig(tool as BinaryTool)
          const versionLabel = config?.version ? ` (v${config.version})` : ''

          console.log(success(`Set ${tool} to: ${path}${versionLabel}`))
        } catch (err) {
          const e = err as Error
          console.error(error(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('unset')
      .description('Remove a custom binary path')
      .argument('<tool>', `Tool name (${VALID_TOOLS.join(', ')})`)
      .action(async (tool: string) => {
        try {
          // Validate tool name
          if (!VALID_TOOLS.includes(tool as BinaryTool)) {
            console.error(error(`Invalid tool: ${tool}`))
            console.log(chalk.gray(`  Valid tools: ${VALID_TOOLS.join(', ')}`))
            process.exit(1)
          }

          await configManager.clearBinaryPath(tool as BinaryTool)
          console.log(success(`Removed ${tool} configuration`))
        } catch (err) {
          const e = err as Error
          console.error(error(e.message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('path')
      .description('Show the path for a specific tool')
      .argument('<tool>', `Tool name (${VALID_TOOLS.join(', ')})`)
      .action(async (tool: string) => {
        try {
          // Validate tool name
          if (!VALID_TOOLS.includes(tool as BinaryTool)) {
            console.error(error(`Invalid tool: ${tool}`))
            console.log(chalk.gray(`  Valid tools: ${VALID_TOOLS.join(', ')}`))
            process.exit(1)
          }

          const path = await configManager.getBinaryPath(tool as BinaryTool)
          if (path) {
            console.log(path)
          } else {
            console.error(error(`${tool} not found`))
            console.log(
              chalk.gray(`  Run 'spindb config detect' to auto-detect tools`),
            )
            process.exit(1)
          }
        } catch (err) {
          const e = err as Error
          console.error(error(e.message))
          process.exit(1)
        }
      }),
  )
