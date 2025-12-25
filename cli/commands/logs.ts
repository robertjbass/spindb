import { Command } from 'commander'
import { spawn } from 'child_process'
import { existsSync, watch, createReadStream } from 'fs'
import { readFile, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { containerManager } from '../../core/container-manager'
import { paths } from '../../config/paths'
import { promptContainerSelect } from '../ui/prompts'
import { uiError, uiWarning, uiInfo } from '../ui/theme'

function getLastNLines(content: string, n: number): string {
  const lines = content.split('\n')
  const nonEmptyLines =
    lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  return nonEmptyLines.slice(-n).join('\n')
}

/**
 * Cross-platform file following (replaces Unix `tail -f`)
 * Uses Node.js fs.watch to monitor file changes and streams new content
 */
async function followFile(
  filePath: string,
  initialLines: number,
): Promise<void> {
  // Read and display initial content
  const content = await readFile(filePath, 'utf-8')
  const initial = getLastNLines(content, initialLines)
  if (initial) {
    console.log(initial)
  }

  // Track file position
  let fileSize = (await stat(filePath)).size

  // Watch for changes
  const watcher = watch(filePath, async (eventType) => {
    if (eventType === 'change') {
      try {
        const newSize = (await stat(filePath)).size

        if (newSize > fileSize) {
          // Read only the new content
          const stream = createReadStream(filePath, {
            start: fileSize,
            encoding: 'utf-8',
          })

          const rl = createInterface({ input: stream })

          for await (const line of rl) {
            console.log(line)
          }

          fileSize = newSize
        } else if (newSize < fileSize) {
          // File was truncated (log rotation), reset position
          fileSize = newSize
        }
      } catch {
        // File might be temporarily unavailable, ignore
      }
    }
  })

  // Handle Ctrl+C gracefully
  const cleanup = () => {
    watcher.close()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)

  // Keep process alive
  await new Promise<void>(() => {
    // Never resolves - runs until Ctrl+C
  })
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
            console.log(uiWarning('No containers found'))
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
          console.error(uiError(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const logPath = paths.getContainerLogPath(config.name, {
          engine: config.engine,
        })

        if (!existsSync(logPath)) {
          console.log(
            uiInfo(
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
          // Use cross-platform file following (works on Windows, macOS, Linux)
          await followFile(logPath, lineCount)
          return
        }

        const lineCount = parseInt(options.lines || '50', 10)
        const content = await readFile(logPath, 'utf-8')

        if (content.trim() === '') {
          console.log(uiInfo('Log file is empty'))
          return
        }

        const output = getLastNLines(content, lineCount)
        console.log(output)
      } catch (error) {
        const e = error as Error
        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
