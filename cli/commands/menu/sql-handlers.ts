import chalk from 'chalk'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { spawn } from 'child_process'
import { containerManager } from '../../../core/container-manager'
import { getMissingDependencies } from '../../../core/dependency-manager'
import { getEngine } from '../../../engines'
import { Engine } from '../../../types'
import { paths } from '../../../config/paths'
import { promptInstallDependencies, escapeablePrompt } from '../../ui/prompts'
import { uiError, uiWarning, uiInfo, uiSuccess } from '../../ui/theme'
import { pressEnterToContinue } from './shared'
import { followFile, getLastNLines } from '../../utils/file-follower'
import { getEngineConfig } from '../../../config/engines-registry'

export async function handleRunSql(
  containerName: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)

  let missingDeps = await getMissingDependencies(config.engine)
  if (missingDeps.length > 0) {
    console.log(
      uiWarning(`Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`),
    )

    const installed = await promptInstallDependencies(
      missingDeps[0].binary,
      config.engine,
    )

    if (!installed) {
      return
    }

    missingDeps = await getMissingDependencies(config.engine)
    if (missingDeps.length > 0) {
      console.log(
        uiError(
          `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
        ),
      )
      return
    }

    console.log(chalk.green('  ✓ All required tools are now available'))
    console.log()
  }

  // Strip quotes that terminals add when drag-and-dropping files
  const stripQuotes = (path: string) => path.replace(/^['"]|['"]$/g, '').trim()

  // Script type terminology derived from engines.json scriptFileLabel
  // e.g., "Run SQL file" → type: "SQL", "Run TypeQL file" → type: "TypeQL"
  const engineConfig = await getEngineConfig(config.engine)
  const scriptType = (engineConfig.scriptFileLabel ?? 'Script file')
    .replace(/^Run\s+/, '')
    .replace(/\s+file$/, '')

  // Prompt for file path (empty input = go back)
  console.log(
    chalk.gray(
      '  Drag & drop, enter path (abs or rel), or press Enter to go back (esc - main menu)',
    ),
  )
  const { filePath: rawFilePath } = await escapeablePrompt<{
    filePath: string
  }>([
    {
      type: 'input',
      name: 'filePath',
      message: `${scriptType} file path:`,
      validate: (input: string) => {
        if (!input) return true // Empty = go back
        const cleanPath = stripQuotes(input)
        if (!existsSync(cleanPath)) return 'File not found'
        return true
      },
    },
  ])

  if (!rawFilePath.trim()) {
    return
  }

  const filePath = stripQuotes(rawFilePath)

  // Use provided database or fall back to container's default
  let databaseName = database || config.database

  // InfluxDB: discover real databases (they're created implicitly on write)
  // Cannot use engine.listDatabases() here because it falls back to
  // container.database when the list is empty, hiding the "no databases"
  // state that we need to detect for the .lp warning.
  if (config.engine === Engine.InfluxDB) {
    try {
      const resp = await fetch(
        `http://127.0.0.1:${config.port}/api/v3/configure/database?format=json`,
      )
      if (resp.ok) {
        const databases = (await resp.json()) as Array<Record<string, string>>
        const dbNames = databases
          .map((d) => d['iox::database'] || d.name)
          .filter((n) => n && n !== '_internal')
        if (dbNames.length === 0 && !filePath.endsWith('.lp')) {
          console.log(
            uiWarning(
              'No databases exist yet. Seed data with a .lp file first.',
            ),
          )
          await pressEnterToContinue()
          return
        }
        if (!dbNames.includes(databaseName)) {
          if (dbNames.length === 1) {
            databaseName = dbNames[0]
          } else if (dbNames.length > 1) {
            const { chosenDb } = await escapeablePrompt<{ chosenDb: string }>([
              {
                type: 'list',
                name: 'chosenDb',
                message: 'Select database:',
                choices: dbNames,
              },
            ])
            databaseName = chosenDb
          }
        }
      }
    } catch {
      // Proceed with default
    }
  }

  console.log()
  console.log(uiInfo(`Running ${scriptType} file against "${databaseName}"...`))
  console.log()

  try {
    await engine.runScript(config, {
      file: filePath,
      database: databaseName,
    })
    console.log()
    console.log(uiSuccess(`${scriptType} file executed successfully`))
  } catch (error) {
    const e = error as Error
    console.log()
    console.log(uiError(`${scriptType} execution failed: ${e.message}`))
  }

  console.log()
  await pressEnterToContinue()
}

// View container logs with interactive options
export async function handleViewLogs(containerName: string): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
    return
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
    await pressEnterToContinue()
    return
  }

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'How would you like to view logs?',
      choices: [
        { name: 'View last 50 lines', value: 'tail-50' },
        { name: 'View last 100 lines', value: 'tail-100' },
        { name: 'Follow logs (live)', value: 'follow' },
        { name: 'Open in editor', value: 'editor' },
        { name: `${chalk.blue('←')} Back`, value: 'back' },
      ],
    },
  ])

  if (action === 'back') {
    return
  }

  if (action === 'editor') {
    const editorCmd = process.env.EDITOR || 'vi'
    const child = spawn(editorCmd, [logPath], { stdio: 'inherit' })
    await new Promise<void>((resolve) => {
      child.on('close', () => resolve())
    })
    return
  }

  if (action === 'follow') {
    console.log(chalk.gray('  Press Ctrl+C to stop following logs'))
    console.log()
    // Use cross-platform file following (works on Windows, macOS, Linux)
    await followFile(logPath, 50)
    return
  }

  // tail-50 or tail-100
  const lineCount = action === 'tail-100' ? 100 : 50
  const content = await readFile(logPath, 'utf-8')
  if (content.trim() === '') {
    console.log(uiInfo('Log file is empty'))
  } else {
    console.log(getLastNLines(content, lineCount))
  }
  console.log()
  await pressEnterToContinue()
}
