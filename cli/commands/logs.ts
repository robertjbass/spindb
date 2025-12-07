import { Command } from 'commander'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { containerManager } from '../../core/container-manager'
import { paths } from '../../config/paths'
import { promptContainerSelect } from '../ui/prompts'
import { error, warning, info } from '../ui/theme'

function getLastNLines(content: string, n: number): string {
  const lines = content.split('\n')
  const nonEmptyLines =
    lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  return nonEmptyLines.slice(-n).join('\n')
}

export const logsCommand = new Command('logs')
  .description('View container logs')
  .argument('[name]', 'Container name')
  .option('-f, --follow', 'Follow log output (like tail -f)')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .option('--editor', 'Open logs in $EDITOR')
  .action(
    async (
      name: string | undefined,
      options: { follow?: boolean; lines?: string; editor?: boolean },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(warning('No containers found'))
            return
          }

          const selected = await promptContainerSelect(
            containers,
            'Select container:',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(error(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const logPath = paths.getContainerLogPath(config.name, {
          engine: config.engine,
        })

        if (!existsSync(logPath)) {
          console.log(
            info(
              `No log file found for "${containerName}". The container may not have been started yet.`,
            ),
          )
          return
        }

        if (options.editor) {
          const editorCmd = process.env.EDITOR || 'vi'
          const child = spawn(editorCmd, [logPath], {
            stdio: 'inherit',
          })

          await new Promise<void>((resolve, reject) => {
            child.on('close', (code) => {
              if (code === 0) {
                resolve()
              } else {
                reject(new Error(`Editor exited with code ${code}`))
              }
            })
            child.on('error', reject)
          })
          return
        }

        if (options.follow) {
          const lineCount = parseInt(options.lines || '50', 10)
          const child = spawn('tail', ['-n', String(lineCount), '-f', logPath], {
            stdio: 'inherit',
          })

          // Use named handler so we can remove it to prevent listener leaks
          const sigintHandler = () => {
            process.removeListener('SIGINT', sigintHandler)
            child.kill('SIGTERM')
            process.exit(0)
          }
          process.on('SIGINT', sigintHandler)

          await new Promise<void>((resolve) => {
            child.on('close', () => {
              process.removeListener('SIGINT', sigintHandler)
              resolve()
            })
          })
          return
        }

        const lineCount = parseInt(options.lines || '50', 10)
        const content = await readFile(logPath, 'utf-8')

        if (content.trim() === '') {
          console.log(info('Log file is empty'))
          return
        }

        const output = getLastNLines(content, lineCount)
        console.log(output)
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
