import chalk from 'chalk'
import inquirer from 'inquirer'
import { spawn } from 'child_process'
import { escapeablePrompt } from '../../ui/prompts'
import { getPageSize } from '../../constants'
import { existsSync } from 'fs'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join, dirname, resolve, sep } from 'path'
import { containerManager } from '../../../core/container-manager'
import {
  isUsqlInstalled,
  isPgcliInstalled,
  isMycliInstalled,
  isLitecliInstalled,
  isIredisInstalled,
  detectPackageManager,
  installUsql,
  installPgcli,
  installMycli,
  installLitecli,
  installIredis,
  getUsqlManualInstructions,
  getPgcliManualInstructions,
  getMycliManualInstructions,
  getLitecliManualInstructions,
  getIredisManualInstructions,
} from '../../../core/dependency-manager'
import { platformService } from '../../../core/platform-service'
import { configManager } from '../../../core/config-manager'
import { getEngine } from '../../../engines'
import { createSpinner } from '../../ui/spinner'
import { uiError, uiWarning, uiInfo, uiSuccess } from '../../ui/theme'
import { pressEnterToContinue } from './shared'
import { paths } from '../../../config/paths'
import { getEngineConfig } from '../../../config/engines-registry'
import { getConsoleBaseArgs } from '../../../engines/typedb/cli-utils'

/**
 * Open a URL in the system's default browser
 */
function openInBrowser(url: string): void {
  const platform = process.platform
  let cmd: string
  let args: string[]

  if (platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else if (platform === 'win32') {
    cmd = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    // Linux and others
    cmd = 'xdg-open'
    args = [url]
  }

  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
}

export async function handleCopyConnectionString(
  containerName: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)
  // Use provided database or fall back to container's default
  const connectionString = engine.getConnectionString(config, database)

  const copied = await platformService.copyToClipboard(connectionString)

  console.log()
  if (copied) {
    console.log(uiSuccess('Connection string copied to clipboard'))
    console.log(chalk.gray(`  ${connectionString}`))
  } else {
    console.log(uiWarning('Could not copy to clipboard. Connection string:'))
    console.log(chalk.cyan(`  ${connectionString}`))
  }
  console.log()

  await escapeablePrompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to continue...'),
    },
  ])
}

export async function handleOpenShell(
  containerName: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    console.error(uiError(`Container "${containerName}" not found`))
    return
  }

  const engine = getEngine(config.engine)
  // Use provided database or fall back to container's default
  const activeDatabase = database || config.database
  const connectionString = engine.getConnectionString(config, activeDatabase)

  const shellCheckSpinner = createSpinner('Checking available shells...')
  shellCheckSpinner.start()

  const [
    usqlInstalled,
    pgcliInstalled,
    mycliInstalled,
    litecliInstalled,
    iredisInstalled,
  ] = await Promise.all([
    isUsqlInstalled(),
    isPgcliInstalled(),
    isMycliInstalled(),
    isLitecliInstalled(),
    isIredisInstalled(),
  ])

  shellCheckSpinner.stop()
  // Clear the spinner line
  process.stdout.write('\x1b[1A\x1b[2K')

  type ShellChoice =
    | 'default'
    | 'browser'
    | 'api-info'
    | 'install-webui'
    | 'usql'
    | 'install-usql'
    | 'pgcli'
    | 'install-pgcli'
    | 'mycli'
    | 'install-mycli'
    | 'litecli'
    | 'install-litecli'
    | 'iredis'
    | 'install-iredis'
    | 'back'

  // Engine-specific shell names
  let defaultShellName: string
  let engineSpecificCli: string | null
  let engineSpecificInstalled: boolean
  let engineSpecificValue: ShellChoice | null
  let engineSpecificInstallValue: ShellChoice | null

  if (config.engine === 'sqlite') {
    defaultShellName = 'sqlite3'
    engineSpecificCli = 'litecli'
    engineSpecificInstalled = litecliInstalled
    engineSpecificValue = 'litecli'
    engineSpecificInstallValue = 'install-litecli'
  } else if (config.engine === 'duckdb') {
    defaultShellName = 'duckdb'
    // DuckDB has no separate enhanced CLI tool
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'mysql') {
    defaultShellName = 'mysql'
    engineSpecificCli = 'mycli'
    engineSpecificInstalled = mycliInstalled
    engineSpecificValue = 'mycli'
    engineSpecificInstallValue = 'install-mycli'
  } else if (config.engine === 'mariadb') {
    defaultShellName = 'mariadb'
    engineSpecificCli = 'mycli'
    engineSpecificInstalled = mycliInstalled
    engineSpecificValue = 'mycli'
    engineSpecificInstallValue = 'install-mycli'
  } else if (config.engine === 'mongodb' || config.engine === 'ferretdb') {
    defaultShellName = 'mongosh'
    // mongosh IS the enhanced shell for MongoDB/FerretDB (no separate enhanced CLI like pgcli/mycli)
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'redis') {
    defaultShellName = 'redis-cli'
    engineSpecificCli = 'iredis'
    engineSpecificInstalled = iredisInstalled
    engineSpecificValue = 'iredis'
    engineSpecificInstallValue = 'install-iredis'
  } else if (config.engine === 'valkey') {
    defaultShellName = 'valkey-cli'
    engineSpecificCli = 'iredis' // iredis is protocol-compatible with Valkey
    engineSpecificInstalled = iredisInstalled
    engineSpecificValue = 'iredis'
    engineSpecificInstallValue = 'install-iredis'
  } else if (config.engine === 'clickhouse') {
    defaultShellName = 'clickhouse client'
    // ClickHouse client is bundled, no separate enhanced CLI
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'qdrant') {
    // Qdrant uses REST API, open dashboard in browser
    defaultShellName = 'Web Dashboard'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'meilisearch') {
    // Meilisearch uses REST API, open dashboard in browser
    defaultShellName = 'Web Dashboard'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'influxdb') {
    // InfluxDB uses REST API, no interactive shell
    defaultShellName = 'Web Dashboard'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'couchdb') {
    // CouchDB uses REST API, open Fauxton dashboard in browser
    defaultShellName = 'Fauxton Dashboard'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'surrealdb') {
    // SurrealDB uses surreal sql command
    defaultShellName = 'surreal sql'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'questdb') {
    // QuestDB uses PostgreSQL wire protocol, can use psql or Web Console
    // Note: Don't recommend pgcli for QuestDB - pgcli uses PostgreSQL functions
    // like unnest() that QuestDB doesn't support, causing autocompletion errors
    defaultShellName = 'psql'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'cockroachdb') {
    // CockroachDB uses cockroach sql command
    defaultShellName = 'cockroach sql'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'typedb') {
    // TypeDB uses typedb console
    defaultShellName = 'typedb console'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else {
    defaultShellName = 'psql'
    engineSpecificCli = 'pgcli'
    engineSpecificInstalled = pgcliInstalled
    engineSpecificValue = 'pgcli'
    engineSpecificInstallValue = 'install-pgcli'
  }

  // Check if Qdrant Web UI is installed by verifying actual Web UI files exist
  // (not just an empty static directory)
  let qdrantWebUiInstalled = false
  if (config.engine === 'qdrant') {
    const containerDir = paths.getContainerPath(config.name, {
      engine: 'qdrant',
    })
    const staticDir = join(containerDir, 'static')
    // Check for index.html which is always present in a valid Web UI install
    qdrantWebUiInstalled = existsSync(join(staticDir, 'index.html'))
  }

  const choices: Array<
    { name: string; value: ShellChoice } | inquirer.Separator
  > = []

  // For Qdrant: show either "Open Web UI" or "Download Web UI" based on installation status
  if (config.engine === 'qdrant') {
    if (qdrantWebUiInstalled) {
      choices.push({
        name: `◎ Open Web UI in browser`,
        value: 'default',
      })
    } else {
      choices.push({
        name: `↓ Download Web UI (enables dashboard)`,
        value: 'install-webui',
      })
    }
    // Always show API info option for Qdrant
    choices.push({
      name: `ℹ Show API info`,
      value: 'api-info',
    })
  } else if (config.engine === 'meilisearch') {
    // Meilisearch: dashboard is built-in at root URL
    choices.push({
      name: `◎ Open Dashboard in browser`,
      value: 'default',
    })
    // Always show API info option for Meilisearch
    choices.push({
      name: `ℹ Show API info`,
      value: 'api-info',
    })
  } else if (config.engine === 'influxdb') {
    // InfluxDB: REST API only, no interactive shell
    choices.push({
      name: `◎ Open Dashboard in browser`,
      value: 'default',
    })
    // Always show API info option for InfluxDB
    choices.push({
      name: `ℹ Show API info`,
      value: 'api-info',
    })
  } else if (config.engine === 'couchdb') {
    // CouchDB: Fauxton dashboard is built-in at /_utils
    choices.push({
      name: `◎ Open Fauxton Dashboard in browser`,
      value: 'default',
    })
    // Always show API info option for CouchDB
    choices.push({
      name: `ℹ Show API info`,
      value: 'api-info',
    })
  } else {
    // Non-Qdrant/Meilisearch/CouchDB engines: show default shell option
    choices.push({
      name: `>_ Use default shell (${defaultShellName})`,
      value: 'default',
    })
  }

  // Add browser option for ClickHouse (Play UI on HTTP port = native port + 1)
  if (config.engine === 'clickhouse') {
    const httpPort = config.port + 1
    choices.push({
      name: `◎ Open Play UI in browser (port ${httpPort})`,
      value: 'browser',
    })
  }

  // Only show engine-specific CLI option if one exists (MongoDB's mongosh IS the default)
  if (engineSpecificCli !== null) {
    if (engineSpecificInstalled) {
      choices.push({
        name: `⚡ Use ${engineSpecificCli} (enhanced features, recommended)`,
        value: engineSpecificValue!,
      })
    } else {
      choices.push({
        name: `↓ Install ${engineSpecificCli} (enhanced features, recommended)`,
        value: engineSpecificInstallValue!,
      })
    }
  }

  // usql supports SQL databases - skip for non-SQL engines
  const engineConfig = await getEngineConfig(config.engine)
  if (engineConfig.queryLanguage === 'sql') {
    if (usqlInstalled) {
      choices.push({
        name: '⚡ Use usql (universal SQL client)',
        value: 'usql',
      })
    } else {
      choices.push({
        name: '↓ Install usql (universal SQL client)',
        value: 'install-usql',
      })
    }
  }

  choices.push(new inquirer.Separator())
  choices.push({
    name: `${chalk.blue('←')} Back`,
    value: 'back',
  })

  const { shellChoice } = await escapeablePrompt<{ shellChoice: ShellChoice }>([
    {
      type: 'list',
      name: 'shellChoice',
      message: 'Select shell option:',
      choices,
      pageSize: getPageSize(),
    },
  ])

  if (shellChoice === 'back') {
    return
  }

  // Handle browser option for ClickHouse Play UI
  if (shellChoice === 'browser') {
    if (config.engine === 'clickhouse') {
      // ClickHouse HTTP port is native port + 1 (e.g., 9000 -> 9001)
      const httpPort = config.port + 1
      const playUrl = `http://127.0.0.1:${httpPort}/play`
      console.log()
      console.log(uiInfo(`Opening ClickHouse Play UI in browser...`))
      console.log(chalk.gray(`  ${playUrl}`))
      console.log()
      openInBrowser(playUrl)
      await pressEnterToContinue()
    }
    return
  }

  // Handle Qdrant/Meilisearch API info display
  if (shellChoice === 'api-info') {
    console.log()
    if (config.engine === 'qdrant') {
      console.log(chalk.cyan('Qdrant REST API:'))
      console.log(chalk.white(`  HTTP: http://127.0.0.1:${config.port}`))
      console.log(chalk.white(`  gRPC: 127.0.0.1:${config.port + 1}`))
      console.log()
      console.log(chalk.gray('Example curl commands:'))
      console.log(
        chalk.gray(`  curl http://127.0.0.1:${config.port}/collections`),
      )
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/healthz`))
    } else if (config.engine === 'meilisearch') {
      console.log(chalk.cyan('Meilisearch REST API:'))
      console.log(chalk.white(`  HTTP: http://127.0.0.1:${config.port}`))
      console.log()
      console.log(chalk.gray('Example curl commands:'))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/indexes`))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/health`))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/stats`))
    } else if (config.engine === 'influxdb') {
      console.log(chalk.cyan('InfluxDB REST API:'))
      console.log(chalk.white(`  HTTP: http://127.0.0.1:${config.port}`))
      console.log()
      console.log(chalk.gray('Example curl commands:'))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/health`))
      console.log(
        chalk.gray(
          `  curl http://127.0.0.1:${config.port}/api/v3/query_sql -d '{"q": "SELECT 1"}'`,
        ),
      )
    } else if (config.engine === 'couchdb') {
      console.log(chalk.cyan('CouchDB REST API:'))
      console.log(chalk.white(`  HTTP: http://127.0.0.1:${config.port}`))
      console.log(
        chalk.white(`  Fauxton: http://127.0.0.1:${config.port}/_utils`),
      )
      console.log()
      console.log(chalk.cyan('Credentials:'))
      console.log(chalk.white(`  Username: admin`))
      console.log(chalk.white(`  Password: admin`))
      console.log()
      console.log(chalk.gray('Example curl commands:'))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}`))
      console.log(chalk.gray(`  curl http://127.0.0.1:${config.port}/_all_dbs`))
      console.log(
        chalk.gray(`  curl -X PUT http://127.0.0.1:${config.port}/mydb`),
      )
    }
    console.log()
    await pressEnterToContinue()
    return
  }

  if (shellChoice === 'install-pgcli') {
    console.log()
    console.log(uiInfo('Installing pgcli for enhanced PostgreSQL shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installPgcli(pm)
      if (result.success) {
        console.log(uiSuccess('pgcli installed successfully!'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'pgcli',
          activeDatabase,
        )
      } else {
        console.error(uiError(`Failed to install pgcli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getPgcliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getPgcliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-mycli') {
    console.log()
    console.log(uiInfo('Installing mycli for enhanced MySQL shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installMycli(pm)
      if (result.success) {
        console.log(uiSuccess('mycli installed successfully!'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'mycli',
          activeDatabase,
        )
      } else {
        console.error(uiError(`Failed to install mycli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getMycliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getMycliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-usql') {
    console.log()
    console.log(uiInfo('Installing usql for enhanced shell experience...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installUsql(pm)
      if (result.success) {
        console.log(uiSuccess('usql installed successfully!'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'usql',
          activeDatabase,
        )
      } else {
        console.error(uiError(`Failed to install usql: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getUsqlManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getUsqlManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-litecli') {
    console.log()
    console.log(uiInfo('Installing litecli for enhanced SQLite shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installLitecli(pm)
      if (result.success) {
        console.log(uiSuccess('litecli installed successfully!'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'litecli',
          activeDatabase,
        )
      } else {
        console.error(uiError(`Failed to install litecli: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getLitecliManualInstructions()) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getLitecliManualInstructions()) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  if (shellChoice === 'install-iredis') {
    console.log()
    console.log(uiInfo('Installing iredis for enhanced Redis shell...'))
    const pm = await detectPackageManager()
    if (pm) {
      const result = await installIredis(pm)
      if (result.success) {
        console.log(uiSuccess('iredis installed successfully!'))
        console.log()
        await launchShell(
          containerName,
          config,
          connectionString,
          'iredis',
          activeDatabase,
        )
      } else {
        console.error(uiError(`Failed to install iredis: ${result.error}`))
        console.log()
        console.log(chalk.gray('Manual installation:'))
        for (const instruction of getIredisManualInstructions(
          platformService.getPlatformInfo().platform,
        )) {
          console.log(chalk.cyan(`  ${instruction}`))
        }
        console.log()
        await pressEnterToContinue()
      }
    } else {
      console.error(uiError('No supported package manager found'))
      console.log()
      console.log(chalk.gray('Manual installation:'))
      for (const instruction of getIredisManualInstructions(
        platformService.getPlatformInfo().platform,
      )) {
        console.log(chalk.cyan(`  ${instruction}`))
      }
      console.log()
      await pressEnterToContinue()
    }
    return
  }

  // Handle install-webui option for Qdrant
  if (shellChoice === 'install-webui') {
    if (config.engine === 'qdrant') {
      await downloadQdrantWebUI(config.name)
    }
    return
  }

  await launchShell(
    containerName,
    config,
    connectionString,
    shellChoice,
    activeDatabase,
  )
}

/**
 * Download and install Qdrant Web UI from GitHub releases
 */
async function downloadQdrantWebUI(containerName: string): Promise<void> {
  console.log()
  const spinner = createSpinner('Downloading Qdrant Web UI...')
  spinner.start()

  try {
    // Get latest release info from GitHub
    const releaseUrl =
      'https://api.github.com/repos/qdrant/qdrant-web-ui/releases/latest'
    const releaseResponse = await fetch(releaseUrl, {
      headers: { 'User-Agent': 'spindb' },
    })

    if (!releaseResponse.ok) {
      throw new Error(`Failed to fetch release info: ${releaseResponse.status}`)
    }

    const releaseData = (await releaseResponse.json()) as {
      assets: Array<{ name: string; browser_download_url: string }>
      tag_name: string
    }

    // Find dist-qdrant.zip asset
    const zipAsset = releaseData.assets.find(
      (a) => a.name === 'dist-qdrant.zip',
    )
    if (!zipAsset) {
      throw new Error('Could not find dist-qdrant.zip in latest release')
    }

    spinner.text = `Downloading Qdrant Web UI ${releaseData.tag_name}...`

    // Download the zip file
    const downloadResponse = await fetch(zipAsset.browser_download_url)
    if (!downloadResponse.ok || !downloadResponse.body) {
      throw new Error(`Failed to download: ${downloadResponse.status}`)
    }

    // Get container directory and create static folder
    const containerDir = paths.getContainerPath(containerName, {
      engine: 'qdrant',
    })
    const staticDir = join(containerDir, 'static')

    // Remove existing static dir if present
    await rm(staticDir, { recursive: true, force: true })
    await mkdir(staticDir, { recursive: true })

    spinner.text = 'Extracting Web UI...'

    // Save and extract zip
    const tempZip = join(containerDir, 'webui-temp.zip')
    const buffer = Buffer.from(await downloadResponse.arrayBuffer())
    await writeFile(tempZip, buffer)

    try {
      // Extract zip - the zip contains a 'dist' folder, we need its contents
      const unzipper = await import('unzipper')
      const directory = await unzipper.Open.file(tempZip)

      // Resolve staticDir to absolute path for zip-slip protection
      const resolvedStaticDir = resolve(staticDir)

      for (const entry of directory.files) {
        // Skip directories and files not in dist/
        if (entry.type === 'Directory') continue
        if (!entry.path.startsWith('dist/')) continue

        // Remove 'dist/' prefix to get relative path
        const relativePath = entry.path.replace(/^dist\//, '')
        if (!relativePath) continue

        // Zip-slip protection: ensure resolved path is within staticDir
        // Use path.sep for platform-safe comparison (backslash on Windows, forward slash on Unix)
        const targetPath = resolve(staticDir, relativePath)
        if (!targetPath.startsWith(resolvedStaticDir + sep)) {
          // Path traversal attempt - skip this entry
          continue
        }

        const targetDir = dirname(targetPath)
        await mkdir(targetDir, { recursive: true })
        const content = await entry.buffer()
        await writeFile(targetPath, content)
      }
    } finally {
      // Clean up temp zip even if extraction fails
      await rm(tempZip, { force: true })
    }

    spinner.succeed(`Qdrant Web UI ${releaseData.tag_name} installed`)
    console.log()
    console.log(uiWarning('Restart Qdrant for the Web UI to take effect:'))
    console.log(
      chalk.gray(
        `  spindb stop ${containerName} && spindb start ${containerName}`,
      ),
    )
    console.log()
  } catch (error) {
    spinner.fail('Failed to download Qdrant Web UI')
    console.error(uiError((error as Error).message))
    console.log()
    console.log(chalk.gray('You can manually download from:'))
    console.log(
      chalk.cyan('  https://github.com/qdrant/qdrant-web-ui/releases'),
    )
    console.log(chalk.gray(`\nExtract dist-qdrant.zip contents to:`))
    console.log(
      chalk.cyan(
        `  ${paths.getContainerPath(containerName, { engine: 'qdrant' })}/static/`,
      ),
    )
    console.log()
  }

  await pressEnterToContinue()
}

async function launchShell(
  containerName: string,
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>,
  connectionString: string,
  shellType: 'default' | 'usql' | 'pgcli' | 'mycli' | 'litecli' | 'iredis',
  database: string,
): Promise<void> {
  console.log(uiInfo(`Connecting to ${containerName}...`))
  console.log()

  let shellCmd: string
  let shellArgs: string[]
  let installHint: string
  let spawnCwd: string | undefined

  if (shellType === 'pgcli') {
    // pgcli accepts connection strings
    shellCmd = 'pgcli'
    shellArgs = [connectionString]
    installHint = 'brew install pgcli'
  } else if (shellType === 'mycli') {
    // mycli: mycli -h host -P port -u user database
    shellCmd = 'mycli'
    shellArgs = [
      '-h',
      '127.0.0.1',
      '-P',
      String(config.port),
      '-u',
      'root',
      database,
    ]
    installHint = 'brew install mycli'
  } else if (shellType === 'litecli') {
    // litecli takes the database file path directly
    shellCmd = 'litecli'
    shellArgs = [config.database]
    installHint = 'brew install litecli'
  } else if (shellType === 'usql') {
    // usql accepts connection strings directly for PostgreSQL, MySQL, and SQLite
    shellCmd = 'usql'
    shellArgs = [connectionString]
    installHint = 'brew tap xo/xo && brew install xo/xo/usql'
  } else if (config.engine === 'sqlite') {
    // Default SQLite shell
    shellCmd = 'sqlite3'
    shellArgs = [config.database]
    installHint = 'brew install sqlite3'
  } else if (config.engine === 'duckdb') {
    // DuckDB shell
    const duckdbPath = await configManager.getBinaryPath('duckdb')
    shellCmd = duckdbPath || 'duckdb'
    shellArgs = [config.database]
    installHint = 'spindb engines download duckdb'
  } else if (config.engine === 'mysql') {
    // MySQL uses downloaded binaries - get the actual path
    const mysqlPath = await configManager.getBinaryPath('mysql')
    shellCmd = mysqlPath || 'mysql'
    shellArgs = [
      '-u',
      'root',
      '-h',
      '127.0.0.1',
      '-P',
      String(config.port),
      database,
    ]
    installHint = 'spindb engines download mysql'
  } else if (config.engine === 'mariadb') {
    // MariaDB uses downloaded binaries, not system PATH - get the actual path
    const mariadbPath = await configManager.getBinaryPath('mariadb')
    shellCmd = mariadbPath || 'mariadb'
    shellArgs = [
      '-u',
      'root',
      '-h',
      '127.0.0.1',
      '-P',
      String(config.port),
      database,
    ]
    installHint = 'spindb engines download mariadb'
  } else if (config.engine === 'mongodb' || config.engine === 'ferretdb') {
    shellCmd = 'mongosh'
    shellArgs = [connectionString]
    installHint = 'brew install mongosh'
  } else if (shellType === 'iredis') {
    // iredis: enhanced Redis CLI
    shellCmd = 'iredis'
    shellArgs = ['-h', '127.0.0.1', '-p', String(config.port), '-n', database]
    installHint = 'brew install iredis'
  } else if (config.engine === 'redis') {
    // Default Redis shell
    shellCmd = 'redis-cli'
    shellArgs = ['-h', '127.0.0.1', '-p', String(config.port), '-n', database]
    installHint = 'brew install redis'
  } else if (config.engine === 'valkey') {
    // Default Valkey shell
    const valkeyCliPath = await configManager.getBinaryPath('valkey-cli')
    shellCmd = valkeyCliPath || 'valkey-cli'
    shellArgs = ['-h', '127.0.0.1', '-p', String(config.port), '-n', database]
    installHint = 'spindb engines download valkey'
  } else if (config.engine === 'clickhouse') {
    // ClickHouse uses a unified binary with subcommands
    const clickhousePath = await configManager.getBinaryPath('clickhouse')
    shellCmd = clickhousePath || 'clickhouse'
    shellArgs = [
      'client',
      '--host',
      '127.0.0.1',
      '--port',
      String(config.port),
      '--database',
      database,
    ]
    installHint = 'spindb engines download clickhouse'
  } else if (config.engine === 'qdrant') {
    // Qdrant: Open Web UI in browser (only shown when Web UI is installed)
    const dashboardUrl = `http://127.0.0.1:${config.port}/dashboard`
    console.log(uiInfo(`Opening Qdrant Dashboard in browser...`))
    console.log(chalk.gray(`  ${dashboardUrl}`))
    console.log()
    openInBrowser(dashboardUrl)
    await pressEnterToContinue()
    return
  } else if (config.engine === 'meilisearch') {
    // Meilisearch: Open dashboard in browser (served at root URL)
    const dashboardUrl = `http://127.0.0.1:${config.port}`
    console.log(uiInfo(`Opening Meilisearch Dashboard in browser...`))
    console.log(chalk.gray(`  ${dashboardUrl}`))
    console.log()
    openInBrowser(dashboardUrl)
    await pressEnterToContinue()
    return
  } else if (config.engine === 'influxdb') {
    // InfluxDB: Open dashboard in browser (served at root URL)
    const dashboardUrl = `http://127.0.0.1:${config.port}`
    console.log(uiInfo(`Opening InfluxDB Dashboard in browser...`))
    console.log(chalk.gray(`  ${dashboardUrl}`))
    console.log()
    openInBrowser(dashboardUrl)
    await pressEnterToContinue()
    return
  } else if (config.engine === 'couchdb') {
    // CouchDB: Open Fauxton dashboard in browser (served at /_utils)
    const dashboardUrl = `http://127.0.0.1:${config.port}/_utils`
    console.log()
    console.log(chalk.cyan('CouchDB Fauxton Dashboard'))
    console.log(chalk.gray(`  ${dashboardUrl}`))
    console.log()
    console.log(chalk.cyan('Credentials (if prompted):'))
    console.log(chalk.white(`  Username: admin`))
    console.log(chalk.white(`  Password: admin`))
    console.log()

    // Prompt before opening so user can see credentials
    await escapeablePrompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('Press Enter to open in browser...'),
      },
    ])

    openInBrowser(dashboardUrl)
    return
  } else if (config.engine === 'surrealdb') {
    // SurrealDB uses surreal sql command
    const engine = getEngine(config.engine)
    const surrealPath = await engine
      .getSurrealPath(config.version)
      .catch(() => 'surreal')
    const namespace = config.name.replace(/-/g, '_')
    shellCmd = surrealPath
    shellArgs = [
      'sql',
      '--endpoint',
      `ws://127.0.0.1:${config.port}`,
      '--namespace',
      namespace,
      '--database',
      database || 'default',
      '--username',
      'root',
      '--password',
      'root',
    ]
    installHint = 'spindb engines download surrealdb'
    // SurrealDB writes history.txt to cwd - use container directory
    spawnCwd = join(paths.containers, 'surrealdb', config.name)
  } else if (config.engine === 'cockroachdb') {
    // CockroachDB uses cockroach sql command
    const engine = getEngine(config.engine)
    const cockroachPath = await engine
      .getCockroachPath(config.version)
      .catch(() => 'cockroach')
    shellCmd = cockroachPath
    shellArgs = [
      'sql',
      '--insecure',
      '--host',
      `127.0.0.1:${config.port}`,
      '--database',
      database,
    ]
    installHint = 'spindb engines download cockroachdb'
  } else if (config.engine === 'questdb') {
    // QuestDB uses PostgreSQL wire protocol on port 8812
    // Default credentials: admin/quest
    shellCmd = 'psql'
    const db = database || 'qdb'
    // QuestDB connection string with explicit password
    const questDbConnStr = `postgresql://admin:quest@127.0.0.1:${config.port}/${db}`
    shellArgs = [questDbConnStr]
    installHint = 'brew install libpq && brew link --force libpq'
  } else if (config.engine === 'typedb') {
    // TypeDB uses typedb console with address and tls-disabled flags
    const engine = getEngine(config.engine)
    const consolePath = await engine
      .getTypeDBConsolePath(config.version)
      .catch(() => null)
    if (consolePath) {
      shellCmd = consolePath
      shellArgs = getConsoleBaseArgs(config.port)
    } else {
      // Fallback: use the typedb launcher with 'console' subcommand
      shellCmd = 'typedb'
      shellArgs = ['console', ...getConsoleBaseArgs(config.port)]
    }
    installHint = 'spindb engines download typedb'
  } else {
    // PostgreSQL default shell - look up downloaded binary path
    const psqlPath = await configManager.getBinaryPath('psql')
    shellCmd = psqlPath || 'psql'
    shellArgs = [connectionString]
    installHint = 'spindb engines download postgresql'
  }

  const shellProcess = spawn(shellCmd, shellArgs, {
    stdio: 'inherit',
    cwd: spawnCwd,
  })

  await new Promise<void>((resolve) => {
    let settled = false

    const settle = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }

    shellProcess.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.log(uiWarning(`${shellCmd} not found on your system.`))
        console.log()
        console.log(chalk.gray('  Connect manually with:'))
        console.log(chalk.cyan(`  ${connectionString}`))
        console.log()
        console.log(chalk.gray(`  Install ${shellCmd}:`))
        console.log(chalk.cyan(`  ${installHint}`))
      } else {
        console.log(uiError(`Failed to start ${shellCmd}: ${err.message}`))
      }
      settle()
    })

    shellProcess.on('close', () => {
      // Clear terminal to remove any residual graphics from shells (e.g., usql logo)
      // Use aggressive ANSI sequences: clear screen + scrollback + reset cursor
      // Only emit ANSI escape codes when output is a TTY
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
      }
      settle()
    })
  })
}
