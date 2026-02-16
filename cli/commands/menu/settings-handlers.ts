import chalk from 'chalk'
import inquirer from 'inquirer'
import { configManager } from '../../../core/config-manager'
import { updateManager } from '../../../core/update-manager'
import { escapeablePrompt } from '../../ui/prompts'
import { header, uiSuccess, uiInfo } from '../../ui/theme'
import {
  setCachedIconMode,
  ENGINE_BRAND_COLORS,
  getPageSize,
} from '../../constants'
import { hasAnyInstalledEngines } from '../../helpers'
import { Engine, type IconMode } from '../../../types'
import { type MenuChoice, pressEnterToContinue } from './shared'
import { handleEngines } from './engine-handlers'
import { handleCheckUpdate, handleDoctor } from './update-handlers'

// Sample engines for icon preview
const PREVIEW_ENGINES = [
  Engine.PostgreSQL,
  Engine.MySQL,
  Engine.MongoDB,
  Engine.Redis,
  Engine.DuckDB,
]

/**
 * Generate a preview line showing how icons look in a specific mode.
 */
function generatePreviewLine(mode: IconMode): string {
  if (mode === 'ascii') {
    const ASCII_ICONS: Record<Engine, string> = {
      [Engine.PostgreSQL]: '[PG]',
      [Engine.MySQL]: '[MY]',
      [Engine.MariaDB]: '[MA]',
      [Engine.SQLite]: '[SL]',
      [Engine.DuckDB]: '[DK]',
      [Engine.MongoDB]: '[MG]',
      [Engine.FerretDB]: '[FD]',
      [Engine.Redis]: '[RD]',
      [Engine.Valkey]: '[VK]',
      [Engine.ClickHouse]: '[CH]',
      [Engine.Qdrant]: '[QD]',
      [Engine.Meilisearch]: '[MS]',
      [Engine.CouchDB]: '[CD]',
      [Engine.CockroachDB]: '[CR]',
      [Engine.SurrealDB]: '[SR]',
      [Engine.QuestDB]: '[QS]',
      [Engine.TypeDB]: '[TB]',
      [Engine.InfluxDB]: '[IX]',
      [Engine.Weaviate]: '[WV]',
    }
    const icons = PREVIEW_ENGINES.map((engine) => {
      const icon = ASCII_ICONS[engine] || '[??]'
      const colors = ENGINE_BRAND_COLORS[engine]
      return chalk.bgHex(colors.background).hex(colors.foreground)(icon)
    })
    return icons.join(' ')
  }

  if (mode === 'nerd') {
    const NERD_ICONS: Record<Engine, string> = {
      [Engine.PostgreSQL]: '\ue76e',
      [Engine.MySQL]: '\ue704',
      [Engine.MariaDB]: '\ue828',
      [Engine.SQLite]: '\ue7c4',
      [Engine.DuckDB]: '\ueef7',
      [Engine.MongoDB]: '\ue7a4',
      [Engine.FerretDB]: '\uf06c',
      [Engine.Redis]: '\ue76d',
      [Engine.Valkey]: '\uf29f',
      [Engine.ClickHouse]: '\uf015',
      [Engine.Qdrant]: '\uf14e',
      [Engine.Meilisearch]: '\uf002',
      [Engine.CouchDB]: '\ue7a2',
      [Engine.CockroachDB]: '\ue269',
      [Engine.SurrealDB]: '\uedfe',
      [Engine.QuestDB]: '\ued2f',
      [Engine.TypeDB]: '\ue706',
      [Engine.InfluxDB]: '\udb85\udf95',
      [Engine.Weaviate]: '\uf0e8',
    }
    const icons = PREVIEW_ENGINES.map((engine) => {
      const icon = NERD_ICONS[engine] || '\ue706'
      const colors = ENGINE_BRAND_COLORS[engine]
      return chalk.hex(colors.background)(icon)
    })
    return icons.join(' ')
  }

  // Emoji mode
  const EMOJI_ICONS: Record<Engine, string> = {
    [Engine.PostgreSQL]: '\u{1F418}',
    [Engine.MySQL]: '\u{1F42C}',
    [Engine.MariaDB]: '\u{1F9AD}',
    [Engine.SQLite]: '\u{1FAB6}',
    [Engine.DuckDB]: '\u{1F986}',
    [Engine.MongoDB]: '\u{1F343}',
    [Engine.FerretDB]: '\u{1F994}',
    [Engine.Redis]: '\u{1F534}',
    [Engine.Valkey]: '\u{1F537}',
    [Engine.ClickHouse]: '\u{1F3E0}',
    [Engine.Qdrant]: '\u{1F9ED}',
    [Engine.Meilisearch]: '\u{1F50D}',
    [Engine.CouchDB]: '\u{1F6CB}',
    [Engine.CockroachDB]: '\u{1FAB3}',
    [Engine.SurrealDB]: '\u{1F300}',
    [Engine.QuestDB]: '\u23F1',
    [Engine.TypeDB]: '\u{1F916}',
    [Engine.InfluxDB]: '\u{1F4C8}',
    [Engine.Weaviate]: '\u{1F52E}',
  }
  const icons = PREVIEW_ENGINES.map((engine) => EMOJI_ICONS[engine] || '\u25A3')
  return icons.join(' ')
}

/**
 * Get the display name for an icon mode with current indicator.
 */
function getIconModeDisplayName(
  mode: IconMode,
  currentMode: IconMode | undefined,
): string {
  const names: Record<IconMode, string> = {
    ascii: 'ASCII (colored badges)',
    nerd: 'Nerd Fonts',
    emoji: 'Emoji',
  }
  const name = names[mode]
  const isCurrent = mode === currentMode
  return isCurrent ? `${name} ${chalk.green('(current)')}` : name
}

/**
 * Handle the icon mode settings submenu.
 */
async function handleIconModeSettings(): Promise<void> {
  const config = await configManager.getConfig()
  const currentMode = config.preferences?.iconMode

  console.clear()
  console.log()
  console.log(chalk.cyan('  ┌──────────────────────┐'))
  console.log(chalk.cyan('  │  Icon Mode Settings  │'))
  console.log(chalk.cyan('  └──────────────────────┘'))
  console.log()
  console.log(
    chalk.gray('  Choose how database engine icons are displayed in the CLI.'),
  )
  console.log()

  // Show previews with guidance
  console.log(chalk.bold('  Previews:'))
  console.log()
  console.log(
    `    Nerd Fonts: ${generatePreviewLine('nerd')} ${chalk.gray('(Recommended if this looks correct)')}`,
  )
  console.log(
    `    ASCII:      ${generatePreviewLine('ascii')} ${chalk.gray("(Recommended if Nerd Fonts don't render)")}`,
  )
  console.log(
    `    Emoji:      ${generatePreviewLine('emoji')} ${chalk.gray('(Not recommended - inconsistent widths)')}`,
  )
  console.log()

  if (currentMode) {
    console.log(chalk.gray(`  Current mode: ${currentMode}`))
    console.log()
  }

  const choices: MenuChoice[] = [
    {
      name: getIconModeDisplayName('nerd', currentMode),
      value: 'nerd',
    },
    {
      name: getIconModeDisplayName('ascii', currentMode),
      value: 'ascii',
    },
    {
      name: getIconModeDisplayName('emoji', currentMode),
      value: 'emoji',
    },
    new inquirer.Separator(),
    {
      name: `${chalk.blue('\u2190')} Back`,
      value: 'back',
    },
  ]

  const { iconMode } = await escapeablePrompt<{ iconMode: string }>([
    {
      type: 'list',
      name: 'iconMode',
      message: 'Select icon mode:',
      choices,
      pageSize: getPageSize(),
    },
  ])

  if (iconMode === 'back') {
    return
  }

  // Save the new mode
  if (!config.preferences) {
    config.preferences = {}
  }
  config.preferences.iconMode = iconMode as IconMode
  await configManager.save()
  setCachedIconMode(iconMode as IconMode)

  console.log()
  console.log(uiSuccess(`Icon mode set to: ${iconMode}`))
  console.log()
  await pressEnterToContinue()
}

/**
 * Handle the update check settings submenu.
 */
async function handleUpdateCheckSettings(): Promise<void> {
  const cached = await updateManager.getCachedUpdateInfo()
  const isEnabled = cached.autoCheckEnabled !== false // Default to true

  console.clear()
  console.log(header('Update Check Settings'))
  console.log()
  console.log(
    chalk.gray('  Control whether SpinDB checks for updates on startup.'),
  )
  console.log()
  console.log(
    `  Current status: ${isEnabled ? chalk.green('Enabled') : chalk.yellow('Disabled')}`,
  )
  console.log()

  const choices: MenuChoice[] = [
    {
      name: isEnabled
        ? `Enable checks ${chalk.green('(current)')}`
        : 'Enable checks',
      value: 'enable',
    },
    {
      name: !isEnabled
        ? `Disable checks ${chalk.green('(current)')}`
        : 'Disable checks',
      value: 'disable',
    },
    new inquirer.Separator(),
    {
      name: `${chalk.blue('\u2190')} Back`,
      value: 'back',
    },
  ]

  const { action } = await escapeablePrompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'Update check setting:',
      choices,
      pageSize: getPageSize(),
    },
  ])

  if (action === 'back') {
    return
  }

  const newEnabled = action === 'enable'
  await updateManager.setAutoCheckEnabled(newEnabled)

  console.log()
  if (newEnabled) {
    console.log(uiSuccess('Update checks enabled on startup'))
  } else {
    console.log(uiInfo('Update checks disabled on startup'))
    console.log(
      chalk.gray('  You can still manually check with: spindb version --check'),
    )
  }
  console.log()
  await pressEnterToContinue()
}

/**
 * Handle the main settings menu.
 * This is accessible from the main menu and from `spindb config` / `spindb configure`.
 */
export async function handleSettings(): Promise<void> {
  while (true) {
    const [config, hasEngines, cached] = await Promise.all([
      configManager.getConfig(),
      hasAnyInstalledEngines(),
      updateManager.getCachedUpdateInfo(),
    ])
    const currentIconMode = config.preferences?.iconMode || 'ascii'
    const updateCheckEnabled = cached.autoCheckEnabled !== false

    console.clear()
    console.log(header('Settings'))
    console.log()

    const choices: MenuChoice[] = [
      {
        name: hasEngines
          ? `${chalk.magenta('⬢')} Manage engines`
          : chalk.gray('⬢ Manage engines'),
        value: 'engines',
        disabled: hasEngines ? false : 'No engines installed',
      },
      { name: `${chalk.red.bold('+')} Health check`, value: 'doctor' },
      { name: `${chalk.cyan('↑')} Check for updates`, value: 'check-update' },
      new inquirer.Separator(),
      {
        name: `Icon mode: ${chalk.cyan(currentIconMode)}`,
        value: 'icon-mode',
      },
      {
        name: `Update checks: ${updateCheckEnabled ? chalk.green('enabled') : chalk.yellow('disabled')}`,
        value: 'update-check',
      },
      new inquirer.Separator(),
      {
        name: `${chalk.blue('←')} Back`,
        value: 'back',
      },
    ]

    const { action } = await escapeablePrompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to configure?',
        choices,
        pageSize: getPageSize(),
      },
    ])

    switch (action) {
      case 'engines':
        await handleEngines()
        break
      case 'doctor':
        await handleDoctor()
        break
      case 'check-update':
        await handleCheckUpdate()
        break
      case 'icon-mode':
        await handleIconModeSettings()
        break
      case 'update-check':
        await handleUpdateCheckSettings()
        break
      case 'back':
        return
    }
  }
}
