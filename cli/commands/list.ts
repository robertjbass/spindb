import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { dirname, basename } from 'path'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { uiInfo, uiError, formatBytes } from '../ui/theme'
import { getEngineIcon } from '../constants'
import { Engine, isFileBasedEngine, isRemoteContainer } from '../../types'
import type { ContainerConfig } from '../../types'
import {
  scanForUnregisteredFiles,
  deriveContainerName,
  getRegistryForEngine,
  type UnregisteredFile,
} from '../../engines/file-based-utils'
import { getEngineMetadata } from '../helpers'

type UnregisteredFileWithEngine = UnregisteredFile & { engine: Engine }

/**
 * Prompt user about unregistered file-based database files in CWD
 * Returns true if user registered any files (refresh needed)
 */
async function promptUnregisteredFiles(): Promise<boolean> {
  const [sqliteFiles, duckdbFiles] = await Promise.all([
    scanForUnregisteredFiles(Engine.SQLite),
    scanForUnregisteredFiles(Engine.DuckDB),
  ])

  const unregistered: UnregisteredFileWithEngine[] = [
    ...sqliteFiles.map((f) => ({ ...f, engine: Engine.SQLite as Engine })),
    ...duckdbFiles.map((f) => ({ ...f, engine: Engine.DuckDB as Engine })),
  ]

  if (unregistered.length === 0) {
    return false
  }

  let anyRegistered = false

  for (let i = 0; i < unregistered.length; i++) {
    const file = unregistered[i]
    const engineLabel = file.engine === Engine.SQLite ? 'SQLite' : 'DuckDB'
    const prompt =
      unregistered.length > 1 ? `[${i + 1} of ${unregistered.length}] ` : ''

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: `${prompt}Unregistered ${engineLabel} database "${file.fileName}" found in current directory. Register with SpinDB?`,
        choices: [
          { name: 'Yes', value: 'yes' },
          { name: 'No', value: 'no' },
          { name: "No - don't ask again for this folder", value: 'ignore' },
        ],
      },
    ])

    if (action === 'yes') {
      const registry = getRegistryForEngine(file.engine)
      const suggestedName = deriveContainerName(
        file.fileName,
        file.engine as Engine.SQLite | Engine.DuckDB,
      )
      const { containerName } = await inquirer.prompt<{
        containerName: string
      }>([
        {
          type: 'input',
          name: 'containerName',
          message: 'Container name:',
          default: suggestedName,
          validate: (input: string) => {
            if (!input) return 'Name is required'
            if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(input)) {
              return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores'
            }
            return true
          },
        },
      ])

      // Check if name already exists
      if (await registry.exists(containerName)) {
        console.log(
          chalk.yellow(
            `  Container "${containerName}" already exists. Skipping.`,
          ),
        )
        continue
      }

      await registry.add({
        name: containerName,
        filePath: file.absolutePath,
        created: new Date().toISOString(),
      })
      console.log(
        chalk.green(`  Registered "${file.fileName}" as "${containerName}"`),
      )
      anyRegistered = true
    } else if (action === 'ignore') {
      await getRegistryForEngine(file.engine).addIgnoreFolder(
        dirname(file.absolutePath),
      )
      console.log(chalk.gray('  Folder will be ignored in future scans.'))
      break // Exit early
    }
  }

  if (anyRegistered) {
    console.log() // Add spacing before list
  }

  return anyRegistered
}

async function getContainerSize(
  container: ContainerConfig,
): Promise<number | null> {
  // File-based engines can always get size (it's just file size)
  if (isFileBasedEngine(container.engine)) {
    try {
      const engine = getEngine(container.engine)
      return await engine.getDatabaseSize(container)
    } catch {
      return null
    }
  }

  // Server databases need to be running
  if (container.status !== 'running') {
    return null
  }
  try {
    const engine = getEngine(container.engine)
    return await engine.getDatabaseSize(container)
  } catch {
    return null
  }
}

export const listCommand = new Command('list')
  .alias('ls')
  .description('List all containers')
  .option('--json', 'Output as JSON')
  .option('--no-scan', 'Skip scanning for unregistered database files in CWD')
  .action(async (options: { json?: boolean; scan?: boolean }) => {
    try {
      // Scan for unregistered file-based database files in CWD (unless JSON mode or --no-scan)
      if (!options.json && options.scan !== false) {
        await promptUnregisteredFiles()
      }

      const containers = await containerManager.list()

      if (options.json) {
        const containersWithSize = await Promise.all(
          containers.map(async (container) => ({
            ...container,
            ...(await getEngineMetadata(container.engine)),
            sizeBytes: await getContainerSize(container),
            ...(container.remote ? { remote: container.remote } : {}),
          })),
        )
        console.log(JSON.stringify(containersWithSize, null, 2))
        return
      }

      if (containers.length === 0) {
        console.log(
          uiInfo('No containers found. Create one with: spindb create'),
        )
        return
      }

      const sizes = await Promise.all(containers.map(getContainerSize))

      console.log()
      console.log(
        chalk.gray('  ') +
          chalk.bold.white('NAME'.padEnd(20)) +
          chalk.bold.white('ENGINE'.padEnd(18)) +
          chalk.bold.white('VERSION'.padEnd(10)) +
          chalk.bold.white('PORT'.padEnd(8)) +
          chalk.bold.white('SIZE'.padEnd(10)) +
          chalk.bold.white('STATUS'),
      )
      console.log(chalk.gray('  ' + '─'.repeat(76)))

      for (let i = 0; i < containers.length; i++) {
        const container = containers[i]
        const size = sizes[i]

        // Status labels based on container type
        let statusDisplay: string
        if (isRemoteContainer(container)) {
          statusDisplay = chalk.magenta('↔ linked')
        } else if (isFileBasedEngine(container.engine)) {
          statusDisplay =
            container.status === 'running'
              ? chalk.blue('🔵 available')
              : chalk.gray('⚪ missing')
        } else {
          statusDisplay =
            container.status === 'running'
              ? chalk.green('● running')
              : chalk.gray('○ stopped')
        }

        // getEngineIcon() includes trailing space - pad engine name separately to avoid ANSI code length issues
        const engineIcon = getEngineIcon(container.engine)
        const engineName = container.engine.padEnd(13)

        const sizeDisplay = size !== null ? formatBytes(size) : '—'

        // File-based engines show truncated file name, remote shows host, others show port
        let portOrPath: string
        if (isRemoteContainer(container)) {
          // Prefer provider name (more informative), fall back to truncated host
          const provider = container.remote?.provider
          const host = container.remote?.host ?? ''
          portOrPath = provider
            ? provider.length > 8
              ? provider.slice(0, 7) + '…'
              : provider
            : host.length > 8
              ? host.slice(0, 7) + '…'
              : host
        } else if (isFileBasedEngine(container.engine)) {
          const fileName = basename(container.database)
          // Truncate if longer than 8 chars to fit in 8-char column
          portOrPath =
            fileName.length > 8 ? fileName.slice(0, 7) + '…' : fileName
        } else {
          portOrPath = String(container.port)
        }

        console.log(
          chalk.gray('  ') +
            chalk.cyan(container.name.padEnd(20)) +
            engineIcon +
            chalk.white(engineName) +
            chalk.yellow(container.version.padEnd(10)) +
            chalk.green(portOrPath.padEnd(8)) +
            chalk.magenta(sizeDisplay.padEnd(10)) +
            statusDisplay,
        )
      }

      console.log()

      const remoteContainers = containers.filter((c) => isRemoteContainer(c))
      const localContainers = containers.filter((c) => !isRemoteContainer(c))
      const serverContainers = localContainers.filter(
        (c) => !isFileBasedEngine(c.engine),
      )
      const fileBasedContainers = localContainers.filter((c) =>
        isFileBasedEngine(c.engine),
      )

      const running = serverContainers.filter(
        (c) => c.status === 'running',
      ).length
      const stopped = serverContainers.filter(
        (c) => c.status !== 'running',
      ).length
      const available = fileBasedContainers.filter(
        (c) => c.status === 'running',
      ).length
      const missing = fileBasedContainers.filter(
        (c) => c.status !== 'running',
      ).length

      const parts: string[] = []
      if (serverContainers.length > 0) {
        parts.push(`${running} running, ${stopped} stopped`)
      }
      if (fileBasedContainers.length > 0) {
        parts.push(
          `${available} file-based available${missing > 0 ? `, ${missing} missing` : ''}`,
        )
      }
      if (remoteContainers.length > 0) {
        parts.push(`${remoteContainers.length} linked`)
      }

      console.log(
        chalk.gray(`  ${containers.length} container(s): ${parts.join('; ')}`),
      )
      console.log()
    } catch (error) {
      const e = error as Error
      if (options.json) {
        console.log(JSON.stringify({ error: e.message }))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })
