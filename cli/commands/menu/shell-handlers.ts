import chalk from 'chalk'
import inquirer from 'inquirer'
import { spawn } from 'child_process'
import { escapeablePrompt } from '../../ui/prompts'
import { getPageSize } from '../../constants'
import { existsSync } from 'fs'
import { chmod, mkdir, writeFile, rm } from 'fs/promises'
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
import { portManager } from '../../../core/port-manager'
import { configManager } from '../../../core/config-manager'
import {
  getPgwebStatus,
  stopPgweb,
  PGWEB_VERSION,
} from '../../../core/pgweb-utils'
import {
  DBLAB_ENGINES,
  DBLAB_VERSION,
  getDblabArgs,
  getDblabPlatformSuffix,
} from '../../../core/dblab-utils'
import { getEngine } from '../../../engines'
import { isRemoteContainer } from '../../../types'
import { loadCredentials } from '../../../core/credential-manager'
import {
  redactConnectionString,
  parseConnectionString,
} from '../../../core/remote-container'
import { createSpinner } from '../../ui/spinner'
import { uiError, uiWarning, uiInfo, uiSuccess } from '../../ui/theme'
import { logDebug } from '../../../core/error-handler'
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

  // Remote containers: use stored connection string (full from credentials)
  let connectionString: string
  let displayString: string
  if (isRemoteContainer(config)) {
    const creds = await loadCredentials(config.name, config.engine, 'remote')
    connectionString =
      creds?.connectionString ?? config.remote?.connectionString ?? ''
    displayString = redactConnectionString(connectionString)
  } else {
    connectionString = engine.getConnectionString(config, database)
    displayString = connectionString
  }

  const copied = await platformService.copyToClipboard(connectionString)

  console.log()
  if (copied) {
    console.log(uiSuccess('Connection string copied to clipboard'))
    console.log(chalk.gray(`  ${displayString}`))
  } else {
    console.log(uiWarning('Could not copy to clipboard. Connection string:'))
    console.log(chalk.cyan(`  ${displayString}`))
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
  const isRemote = isRemoteContainer(config)
  // Use provided database or fall back to container's default
  const activeDatabase = database || config.database

  // For remote containers, use the stored remote connection string
  let connectionString: string
  if (isRemote) {
    const creds = await loadCredentials(config.name, config.engine, 'remote')
    connectionString =
      creds?.connectionString ?? config.remote?.connectionString ?? ''
  } else {
    connectionString = engine.getConnectionString(config, activeDatabase)
  }

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

  // REST API engines (no CLI shell) can't be used remotely via console
  if (
    isRemote &&
    ['qdrant', 'meilisearch', 'influxdb', 'weaviate', 'couchdb'].includes(
      config.engine,
    )
  ) {
    console.log()
    console.log(
      uiInfo('Console is not available for linked remote REST API databases.'),
    )
    console.log(
      chalk.gray("  Use your provider's web dashboard or API tools directly."),
    )
    console.log()
    await pressEnterToContinue()
    return
  }

  type ShellChoice =
    | 'default'
    | 'browser'
    | 'api-info'
    | 'install-webui'
    | 'pgweb'
    | 'install-pgweb'
    | 'stop-pgweb'
    | 'dblab'
    | 'install-dblab'
    | 'duckdb-ui'
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
    // InfluxDB uses influxdb3 query subcommand (same binary as server)
    defaultShellName = 'influxdb3 query'
    engineSpecificCli = null
    engineSpecificInstalled = false
    engineSpecificValue = null
    engineSpecificInstallValue = null
  } else if (config.engine === 'weaviate') {
    // Weaviate uses REST API, open web dashboard in browser
    defaultShellName = 'REST API'
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
  } else if (config.engine === 'tigerbeetle') {
    // TigerBeetle uses tigerbeetle repl command
    defaultShellName = 'tigerbeetle repl'
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
    // InfluxDB: influxdb3 query CLI + API info
    choices.push({
      name: `▸ Use default shell (influxdb3 query)`,
      value: 'default',
    })
    choices.push({
      name: `ℹ Show API info`,
      value: 'api-info',
    })
  } else if (config.engine === 'weaviate') {
    // Weaviate: REST API dashboard + API info
    choices.push({
      name: `◎ Open Dashboard in browser`,
      value: 'default',
    })
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
    // Non-REST-API engines: show default shell option
    choices.push({
      name: `▸ Use default shell (${defaultShellName})`,
      value: 'default',
    })
  }

  // Only show engine-specific CLI option if one exists (MongoDB's mongosh IS the default)
  if (engineSpecificCli !== null) {
    if (engineSpecificInstalled) {
      choices.push({
        name: `★ Use ${engineSpecificCli} (enhanced features, recommended)`,
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
        name: '★ Use usql (universal SQL client)',
        value: 'usql',
      })
    } else {
      choices.push({
        name: '↓ Install usql (universal SQL client)',
        value: 'install-usql',
      })
    }
  }

  // dblab visual TUI (supports PostgreSQL, MySQL, MariaDB, CockroachDB, SQLite, QuestDB)
  // Not available for remote containers (hardcodes local connection)
  if (DBLAB_ENGINES.has(config.engine) && !isRemote) {
    const dblabPath = await configManager.getBinaryPath('dblab')
    if (dblabPath) {
      choices.push({
        name: '★ Use dblab (visual TUI)',
        value: 'dblab',
      })
    } else {
      choices.push({
        name: '↓ Download dblab (visual TUI)',
        value: 'install-dblab',
      })
    }
  }

  // Web Panel section for engines with browser-based UIs (local only)
  if (config.engine === 'clickhouse' && !isRemote) {
    const httpPort = config.port + 1
    choices.push(new inquirer.Separator(chalk.gray(`───── Web Panel ─────`)))
    choices.push({
      name: `◎ Open Play UI (port ${httpPort})`,
      value: 'browser',
    })
  }

  if (config.engine === 'questdb' && !isRemote) {
    const httpPort = config.port + 188
    choices.push(new inquirer.Separator(chalk.gray(`───── Web Panel ─────`)))
    choices.push({
      name: `◎ Open Web Console (port ${httpPort})`,
      value: 'browser',
    })
  }

  if (config.engine === 'duckdb' && !isRemote) {
    choices.push(new inquirer.Separator(chalk.gray(`───── Web Panel ─────`)))
    choices.push({
      name: `◎ Open Web UI (built-in, port 4213)`,
      value: 'duckdb-ui',
    })
  }

  if (
    !isRemote &&
    (config.engine === 'postgresql' ||
      config.engine === 'cockroachdb' ||
      config.engine === 'ferretdb')
  ) {
    choices.push(new inquirer.Separator(chalk.gray(`───── Web Panel ─────`)))
    const pgwebPath = await configManager.getBinaryPath('pgweb')
    if (pgwebPath) {
      const pgwebStatus = await getPgwebStatus(containerName, config.engine)
      if (pgwebStatus.running) {
        choices.push({
          name: `◎ Open pgweb (port ${pgwebStatus.port})`,
          value: 'pgweb',
        })
        choices.push({
          name: `■ Stop pgweb`,
          value: 'stop-pgweb',
        })
      } else {
        choices.push({
          name: `◎ Open pgweb`,
          value: 'pgweb',
        })
      }
    } else {
      choices.push({
        name: `↓ Download pgweb`,
        value: 'install-pgweb',
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
      message: 'Select console option:',
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
    } else if (config.engine === 'questdb') {
      // QuestDB Web Console on HTTP port (PG port + 188)
      const httpPort = config.port + 188
      const consoleUrl = `http://127.0.0.1:${httpPort}`
      console.log()
      console.log(uiInfo(`Opening QuestDB Web Console in browser...`))
      console.log(chalk.gray(`  ${consoleUrl}`))
      console.log()
      openInBrowser(consoleUrl)
      await pressEnterToContinue()
    }
    return
  }

  // Handle DuckDB built-in Web UI (duckdb -ui)
  if (shellChoice === 'duckdb-ui') {
    const duckdbPath = await configManager.getBinaryPath('duckdb')
    if (!duckdbPath) {
      console.error(
        uiError(
          'DuckDB binary not found. Download it with: spindb engines download duckdb',
        ),
      )
      await pressEnterToContinue()
      return
    }

    console.log()
    console.log(uiInfo('Launching DuckDB Web UI...'))
    console.log(chalk.gray('  http://localhost:4213'))
    console.log()

    const uiProcess = spawn(duckdbPath, [config.database, '-ui'], {
      stdio: 'inherit',
    })

    await new Promise<void>((resolve) => {
      let settled = false
      const settle = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }

      uiProcess.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          console.log(uiWarning('DuckDB binary not found.'))
        } else {
          console.log(uiError(`Failed to start DuckDB UI: ${err.message}`))
        }
        settle()
      })

      uiProcess.on('close', () => {
        if (process.stdout.isTTY) {
          process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
        }
        settle()
      })
    })
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
          `  curl -H "Content-Type: application/json" http://127.0.0.1:${config.port}/api/v3/query_sql -d '{"db":"mydb","q":"SELECT 1"}'`,
        ),
      )
    } else if (config.engine === 'weaviate') {
      console.log(chalk.cyan('Weaviate REST API:'))
      console.log(chalk.white(`  HTTP: http://127.0.0.1:${config.port}`))
      console.log(chalk.white(`  gRPC: 127.0.0.1:${config.port + 1}`))
      console.log()
      console.log(chalk.gray('Example curl commands:'))
      console.log(
        chalk.gray(
          `  curl http://127.0.0.1:${config.port}/v1/.well-known/ready`,
        ),
      )
      console.log(
        chalk.gray(`  curl http://127.0.0.1:${config.port}/v1/schema`),
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

  // Handle dblab download → launch immediately after install
  if (shellChoice === 'install-dblab') {
    const dblabBinaryPath = await downloadDblabCli()
    if (dblabBinaryPath) {
      await launchDblab(config, activeDatabase)
    }
    return
  }

  // Handle dblab launch
  if (shellChoice === 'dblab') {
    await launchDblab(config, activeDatabase)
    return
  }

  // Handle pgweb download → launch immediately after install
  if (shellChoice === 'install-pgweb') {
    const pgwebBinaryPath = await downloadPgweb()
    if (pgwebBinaryPath) {
      await launchPgweb(containerName, config, activeDatabase)
    }
    return
  }

  // Handle pgweb launch
  if (shellChoice === 'pgweb') {
    await launchPgweb(containerName, config, activeDatabase)
    return
  }

  // Handle pgweb stop
  if (shellChoice === 'stop-pgweb') {
    await stopPgwebProcess(containerName, config.engine)
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

/**
 * Stop a running pgweb process for a container (with UI feedback)
 */
export async function stopPgwebProcess(
  containerName: string,
  engine: string,
): Promise<void> {
  const stopped = await stopPgweb(containerName, engine)

  console.log()
  if (stopped) {
    console.log(uiSuccess('pgweb stopped'))
  } else {
    console.log(uiInfo('pgweb is not running'))
  }
  console.log()
  await pressEnterToContinue()
}

/**
 * Download and install pgweb from GitHub releases
 */
async function downloadPgweb(): Promise<string | null> {
  console.log()
  const spinner = createSpinner('Downloading pgweb...')
  spinner.start()

  try {
    const platform = process.platform
    const arch = process.arch
    let suffix: string

    if (platform === 'darwin' && arch === 'arm64') {
      suffix = 'darwin_arm64'
    } else if (platform === 'darwin' && arch === 'x64') {
      suffix = 'darwin_amd64'
    } else if (platform === 'linux' && arch === 'arm64') {
      suffix = 'linux_arm64'
    } else if (platform === 'linux' && arch === 'x64') {
      suffix = 'linux_amd64'
    } else if (platform === 'win32' && arch === 'x64') {
      suffix = 'windows_amd64.exe'
    } else {
      throw new Error(`Unsupported platform: ${platform} ${arch}`)
    }

    const zipUrl = `https://github.com/sosedoff/pgweb/releases/download/v${PGWEB_VERSION}/pgweb_${suffix}.zip`

    spinner.text = `Downloading pgweb v${PGWEB_VERSION}...`

    const response = await fetch(zipUrl)
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download: ${response.status}`)
    }

    const isWin = platform === 'win32'
    const binaryName = isWin ? 'pgweb.exe' : 'pgweb'
    const platformArch = `${platform}-${arch}`
    const installDir = join(
      paths.bin,
      `pgweb-${PGWEB_VERSION}-${platformArch}`,
      'bin',
    )
    await mkdir(installDir, { recursive: true })

    const tempZip = join(paths.bin, 'pgweb-temp.zip')
    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(tempZip, buffer)

    spinner.text = 'Extracting pgweb...'

    try {
      const unzipper = await import('unzipper')
      const directory = await unzipper.Open.file(tempZip)

      const resolvedInstallDir = resolve(installDir)
      let extracted = false

      for (const entry of directory.files) {
        if (entry.type === 'Directory') continue

        // Zip-slip protection
        const targetPath = resolve(installDir, binaryName)
        if (!targetPath.startsWith(resolvedInstallDir + sep)) {
          continue
        }

        // The zip contains the binary (possibly named pgweb_<platform>_<arch> or pgweb_<platform>_<arch>.exe)
        const content = await entry.buffer()
        await writeFile(targetPath, content)
        extracted = true
        break // Only one file in the zip
      }

      if (!extracted) {
        throw new Error('Could not find pgweb binary in zip archive')
      }
    } finally {
      await rm(tempZip, { force: true })
    }

    const binaryPath = join(installDir, binaryName)

    // chmod on Unix
    if (!isWin) {
      await chmod(binaryPath, 0o755)
    }

    // Register in config
    await configManager.setBinaryPath('pgweb', binaryPath, 'bundled')

    spinner.succeed(`pgweb v${PGWEB_VERSION} installed`)
    console.log()

    return binaryPath
  } catch (error) {
    spinner.fail('Failed to download pgweb')
    console.error(uiError((error as Error).message))
    console.log()
    console.log(chalk.gray('You can manually download from:'))
    console.log(chalk.cyan('  https://github.com/sosedoff/pgweb/releases'))
    console.log()
    await pressEnterToContinue()
    return null
  }
}

/**
 * Download and install dblab from GitHub releases.
 * Exported as downloadDblabCli for use from the CLI connect command.
 */
export async function downloadDblabCli(): Promise<string | null> {
  console.log()
  const spinner = createSpinner('Downloading dblab...')
  spinner.start()

  try {
    const suffix = getDblabPlatformSuffix()
    const tarUrl = `https://github.com/danvergara/dblab/releases/download/v${DBLAB_VERSION}/dblab_${DBLAB_VERSION}_${suffix}.tar.gz`

    spinner.text = `Downloading dblab v${DBLAB_VERSION}...`

    const response = await fetch(tarUrl)
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download: ${response.status}`)
    }

    const isWin = process.platform === 'win32'
    const binaryName = isWin ? 'dblab.exe' : 'dblab'
    const platformArch = `${process.platform}-${process.arch}`
    const installDir = join(
      paths.bin,
      `dblab-${DBLAB_VERSION}-${platformArch}`,
      'bin',
    )
    await mkdir(installDir, { recursive: true })

    const tempTar = join(paths.bin, 'dblab-temp.tar.gz')
    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(tempTar, buffer)

    spinner.text = 'Extracting dblab...'

    try {
      const { spawnSync } = await import('child_process')
      const result = spawnSync('tar', ['-xzf', tempTar, '-C', installDir], {
        stdio: 'pipe',
      })
      if (result.status !== 0) {
        throw new Error(
          `tar extraction failed: ${result.stderr?.toString() || 'unknown error'}`,
        )
      }
    } finally {
      await rm(tempTar, { force: true })
    }

    const binaryPath = join(installDir, binaryName)

    if (!existsSync(binaryPath)) {
      throw new Error('Could not find dblab binary after extraction')
    }

    // chmod on Unix
    if (!isWin) {
      await chmod(binaryPath, 0o755)
    }

    // Register in config
    await configManager.setBinaryPath('dblab', binaryPath, 'bundled')

    spinner.succeed(`dblab v${DBLAB_VERSION} installed`)
    console.log()

    return binaryPath
  } catch (error) {
    spinner.fail('Failed to download dblab')
    console.error(uiError((error as Error).message))
    console.log()
    console.log(chalk.gray('You can manually download from:'))
    console.log(chalk.cyan('  https://github.com/danvergara/dblab/releases'))
    console.log()
    await pressEnterToContinue()
    return null
  }
}

/**
 * Launch dblab visual TUI for a container
 */
async function launchDblab(
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>,
  database: string,
): Promise<void> {
  const dblabPath = await configManager.getBinaryPath('dblab')
  if (!dblabPath) {
    console.error(uiError('dblab not found. Download it first.'))
    await pressEnterToContinue()
    return
  }

  const args = getDblabArgs(config, database)

  console.log()
  console.log(chalk.gray('  dblab keybindings:'))
  console.log(
    chalk.gray(
      '  Ctrl+Space: run query | Ctrl+H/J/K/L: navigate panels | Ctrl+S: structure view',
    ),
  )
  console.log()
  await escapeablePrompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to launch dblab...'),
    },
  ])

  const dblabProcess = spawn(dblabPath, args, {
    stdio: 'inherit',
  })

  await new Promise<void>((resolve) => {
    let settled = false

    const settle = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }

    dblabProcess.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.log(uiWarning('dblab not found on your system.'))
        console.log()
        console.log(chalk.gray('  Download it with:'))
        console.log(chalk.cyan('  spindb connect --install-dblab'))
      } else {
        console.log(uiError(`Failed to start dblab: ${err.message}`))
      }
      settle()
    })

    dblabProcess.on('close', () => {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
      }
      settle()
    })
  })
}

/**
 * Launch pgweb for a PostgreSQL-compatible container
 */
async function launchPgweb(
  containerName: string,
  config: NonNullable<Awaited<ReturnType<typeof containerManager.getConfig>>>,
  database: string,
): Promise<void> {
  const pgwebPath = await configManager.getBinaryPath('pgweb')
  if (!pgwebPath) {
    console.error(uiError('pgweb not found. Download it first.'))
    await pressEnterToContinue()
    return
  }

  const containerDir = paths.getContainerPath(containerName, {
    engine: config.engine,
  })
  const pidFile = join(containerDir, 'pgweb.pid')
  const portFile = join(containerDir, 'pgweb.port')

  // Check if already running — just open browser
  const status = await getPgwebStatus(containerName, config.engine)
  if (status.running && status.port) {
    const url = `http://127.0.0.1:${status.port}`
    console.log()
    console.log(uiInfo(`Opening pgweb`))
    console.log(chalk.gray(`  ${url}`))
    console.log()
    openInBrowser(url)
    await pressEnterToContinue()
    return
  }

  // Find available port starting at 8081
  let port = 8081
  while (!(await portManager.isPortAvailable(port)) && port < 8200) {
    port++
  }

  if (port >= 8200) {
    console.error(
      uiError(
        'Could not find an available port for pgweb (scanned 8081–8199). ' +
          'Check for other pgweb or server processes using those ports.',
      ),
    )
    await pressEnterToContinue()
    return
  }

  // Build connection URL
  let connectionUrl: string
  if (config.engine === 'ferretdb') {
    // FerretDB has a PostgreSQL backend on backendPort — always connects to 'ferretdb' database
    if (!config.backendPort) {
      console.log()
      console.error(
        uiError(
          'PostgreSQL backend port not set — restart the container first',
        ),
      )
      console.log()
      await pressEnterToContinue()
      return
    }
    connectionUrl = `postgresql://postgres@127.0.0.1:${config.backendPort}/ferretdb?sslmode=disable`
  } else if (config.engine === 'cockroachdb') {
    connectionUrl = `postgresql://root@127.0.0.1:${config.port}/${database}?sslmode=disable`
  } else {
    connectionUrl = `postgresql://postgres@127.0.0.1:${config.port}/${database}?sslmode=disable`
  }

  // Spawn pgweb detached
  const pgwebProcess = spawn(
    pgwebPath,
    ['--url', connectionUrl, '--bind', '127.0.0.1', '--listen', String(port)],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    },
  )

  pgwebProcess.unref()

  // Write PID and port files
  if (pgwebProcess.pid) {
    await writeFile(pidFile, String(pgwebProcess.pid))
    await writeFile(portFile, String(port))
  }

  // Brief wait for startup
  await new Promise((resolve) => setTimeout(resolve, 1000))

  const url = `http://127.0.0.1:${port}`
  console.log()
  console.log(uiSuccess(`pgweb started on ${url}`))
  console.log(chalk.gray(`  PID: ${pgwebProcess.pid}`))
  console.log()
  openInBrowser(url)
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

  const isRemote = isRemoteContainer(config)

  // Parse remote connection string for host/port/user/password
  let rHost = '127.0.0.1'
  let rPort = config.port
  let rUser = ''
  let rPass = ''
  if (isRemote) {
    try {
      const parsed = parseConnectionString(connectionString)
      rHost = parsed.host || config.remote?.host || '127.0.0.1'
      rPort = parsed.port || config.port
      rUser = parsed.username || ''
      rPass = parsed.password || ''
    } catch {
      /* use defaults */
    }
  }

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
    // mycli accepts connection strings directly
    shellCmd = 'mycli'
    if (isRemote) {
      shellArgs = [connectionString]
    } else {
      shellArgs = [
        '-h',
        '127.0.0.1',
        '-P',
        String(config.port),
        '-u',
        'root',
        database,
      ]
    }
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
    if (isRemote) {
      shellArgs = ['-h', rHost, '-P', String(rPort), '-u', rUser || 'root']
      if (rPass) shellArgs.push(`-p${rPass}`)
      shellArgs.push(database)
    } else {
      shellArgs = [
        '-u',
        'root',
        '-h',
        '127.0.0.1',
        '-P',
        String(config.port),
        database,
      ]
    }
    installHint = 'spindb engines download mysql'
  } else if (config.engine === 'mariadb') {
    // MariaDB uses downloaded binaries, not system PATH - get the actual path
    const mariadbPath = await configManager.getBinaryPath('mariadb')
    shellCmd = mariadbPath || 'mariadb'
    if (isRemote) {
      shellArgs = ['-h', rHost, '-P', String(rPort), '-u', rUser || 'root']
      if (rPass) shellArgs.push(`-p${rPass}`)
      shellArgs.push(database)
    } else {
      shellArgs = [
        '-u',
        'root',
        '-h',
        '127.0.0.1',
        '-P',
        String(config.port),
        database,
      ]
    }
    installHint = 'spindb engines download mariadb'
  } else if (config.engine === 'mongodb' || config.engine === 'ferretdb') {
    shellCmd = 'mongosh'
    shellArgs = [connectionString]
    installHint = 'brew install mongosh'
  } else if (shellType === 'iredis') {
    // iredis: enhanced Redis CLI
    shellCmd = 'iredis'
    if (isRemote) {
      shellArgs = ['-h', rHost, '-p', String(rPort)]
      if (rPass) shellArgs.push('-a', rPass)
      if (database) shellArgs.push('-n', database)
    } else {
      shellArgs = ['-h', '127.0.0.1', '-p', String(config.port), '-n', database]
    }
    installHint = 'brew install iredis'
  } else if (config.engine === 'redis') {
    // Default Redis shell
    shellCmd = 'redis-cli'
    if (isRemote) {
      shellArgs = ['-h', rHost, '-p', String(rPort)]
      if (rPass) shellArgs.push('-a', rPass)
      if (database) shellArgs.push('-n', database)
    } else {
      shellArgs = ['-h', '127.0.0.1', '-p', String(config.port), '-n', database]
    }
    installHint = 'brew install redis'
  } else if (config.engine === 'valkey') {
    // Default Valkey shell
    const valkeyCliPath = await configManager.getBinaryPath('valkey-cli')
    shellCmd = valkeyCliPath || 'valkey-cli'
    if (isRemote) {
      shellArgs = ['-h', rHost, '-p', String(rPort)]
      if (rPass) shellArgs.push('-a', rPass)
      if (database) shellArgs.push('-n', database)
    } else {
      shellArgs = ['-h', '127.0.0.1', '-p', String(config.port), '-n', database]
    }
    installHint = 'spindb engines download valkey'
  } else if (config.engine === 'clickhouse') {
    // ClickHouse uses a unified binary with subcommands
    const clickhousePath = await configManager.getBinaryPath('clickhouse')
    shellCmd = clickhousePath || 'clickhouse'
    shellArgs = [
      'client',
      '--host',
      isRemote ? rHost : '127.0.0.1',
      '--port',
      String(isRemote ? rPort : config.port),
      '--database',
      database,
    ]
    if (isRemote && rUser) shellArgs.push('--user', rUser)
    if (isRemote && rPass) shellArgs.push('--password', rPass)
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
  } else if (config.engine === 'weaviate') {
    // Weaviate: Open REST API root in browser
    const dashboardUrl = `http://127.0.0.1:${config.port}`
    console.log(uiInfo(`Opening Weaviate in browser...`))
    console.log(chalk.gray(`  ${dashboardUrl}`))
    console.log()
    openInBrowser(dashboardUrl)
    await pressEnterToContinue()
    return
  } else if (config.engine === 'influxdb') {
    // InfluxDB: influxdb3 query is one-shot (no REPL), use interactive loop
    const engine = getEngine(config.engine)
    const influxdbPath = await engine
      .getInfluxDBPath(config.version)
      .catch(() => null)
    if (!influxdbPath) {
      console.log(
        uiWarning('influxdb3 not found. Run: spindb engines download influxdb'),
      )
      await pressEnterToContinue()
      return
    }
    // Query available databases from the REST API
    let db = database || config.name
    try {
      const resp = await fetch(
        `http://127.0.0.1:${config.port}/api/v3/configure/database?format=json`,
      )
      if (resp.ok) {
        const databases = (await resp.json()) as Array<Record<string, string>>
        const dbNames = databases
          .map((d) => d['iox::database'] || d.name)
          .filter((n) => n && n !== '_internal')
        if (dbNames.length === 0) {
          console.log(
            uiWarning(
              'No databases exist yet. Write data first to create a database.',
            ),
          )
          console.log(
            chalk.gray(
              `  curl -X POST "http://127.0.0.1:${config.port}/api/v3/write_lp?db=${db}" -H "Content-Type: text/plain" -d 'measurement,tag=value field=1'`,
            ),
          )
          console.log()
          await pressEnterToContinue()
          return
        }
        if (!dbNames.includes(db)) {
          if (dbNames.length === 1) {
            db = dbNames[0]
          } else {
            const { chosenDb } = await escapeablePrompt<{ chosenDb: string }>([
              {
                type: 'list',
                name: 'chosenDb',
                message: 'Select database:',
                choices: dbNames,
              },
            ])
            db = chosenDb
          }
        }
      }
    } catch {
      // Server may not support this endpoint; proceed with default db
    }
    console.log(chalk.cyan(`InfluxDB SQL Console (${db})`))
    console.log(chalk.gray(`  Type SQL queries, or "exit" to quit.\n`))
    let running = true
    while (running) {
      const { sql } = await escapeablePrompt<{ sql: string }>([
        {
          type: 'input',
          name: 'sql',
          message: chalk.blue('sql>'),
        },
      ])
      const trimmed = (sql || '').trim()
      if (
        trimmed.toLowerCase() === 'exit' ||
        trimmed.toLowerCase() === 'quit'
      ) {
        running = false
        break
      }
      if (!trimmed) {
        continue
      }
      const queryProcess = spawn(
        influxdbPath,
        [
          'query',
          '--host',
          `http://127.0.0.1:${config.port}`,
          '--database',
          db,
          '--',
          trimmed,
        ],
        { stdio: 'inherit' },
      )
      await new Promise<void>((resolve) => {
        queryProcess.on('error', (err) => {
          console.error(uiError(`Query failed: ${err.message}`))
          resolve()
        })
        queryProcess.on('close', () => {
          logDebug('influxdb query process exited')
          resolve()
        })
      })
    }
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
    if (isRemote) {
      shellArgs = [
        'sql',
        '--endpoint',
        `ws://${rHost}:${rPort}`,
        '--namespace',
        namespace,
        '--database',
        database || 'default',
      ]
      if (rUser) shellArgs.push('--username', rUser)
      if (rPass) shellArgs.push('--password', rPass)
    } else {
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
    }
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
    if (isRemote) {
      // Use --url for remote connections (supports full connection strings)
      shellArgs = ['sql', '--url', connectionString]
    } else {
      shellArgs = [
        'sql',
        '--insecure',
        '--host',
        `127.0.0.1:${config.port}`,
        '--database',
        database,
      ]
    }
    installHint = 'spindb engines download cockroachdb'
  } else if (config.engine === 'questdb') {
    // QuestDB uses PostgreSQL wire protocol on port 8812
    shellCmd = 'psql'
    if (isRemote) {
      shellArgs = [connectionString]
    } else {
      // Default credentials: admin/quest
      const db = database || 'qdb'
      const questDbConnStr = `postgresql://admin:quest@127.0.0.1:${config.port}/${db}`
      shellArgs = [questDbConnStr]
    }
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
  } else if (config.engine === 'tigerbeetle') {
    // TigerBeetle uses tigerbeetle repl command
    const clusterId = 0
    const engine = getEngine(config.engine)
    const tigerbeetlePath = await engine
      .getTigerBeetlePath(config.version)
      .catch(() => null)
    shellCmd = tigerbeetlePath || 'tigerbeetle'
    shellArgs = [
      'repl',
      `--cluster=${clusterId}`,
      `--addresses=${isRemote ? rHost : '127.0.0.1'}:${isRemote ? rPort : config.port}`,
    ]
    installHint = 'spindb engines download tigerbeetle'
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
