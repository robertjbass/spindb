import chalk from 'chalk'
import { Engine, type IconMode } from '../types'

/**
 * Get the page size for list prompts based on terminal height.
 * Returns 20 for tall terminals (>= 30 rows), 15 for shorter ones.
 * This provides a consistent experience while avoiding rendering issues on small terminals.
 */
export function getPageSize(): number {
  const terminalHeight = process.stdout.rows || 24
  return terminalHeight >= 30 ? 20 : 15
}

// Engine icons with three display modes:
// - 'ascii' (default): Works everywhere, no special fonts needed (colored with brand colors)
// - 'nerd': Nerd Font glyphs - requires a patched font (https://nerdfonts.com)
// - 'emoji': Original emoji icons - inconsistent width across terminals
//
// Icon mode priority:
// 1. SPINDB_ICONS environment variable (for dev testing, overrides config)
// 2. Cached config value (set via Settings menu or first-time setup)
// 3. Default to 'ascii'

// Cached icon mode from config (set by config-manager)
let cachedIconMode: IconMode | undefined

/**
 * Set the cached icon mode from config.
 * Called during startup after loading preferences from config.json
 */
export function setCachedIconMode(mode: IconMode | undefined): void {
  cachedIconMode = mode
}

/**
 * Get the cached icon mode (for reading from config).
 */
export function getCachedIconMode(): IconMode | undefined {
  return cachedIconMode
}

function getIconMode(): IconMode {
  // Priority 1: Environment variable (for dev testing, overrides config)
  const envMode = process.env.SPINDB_ICONS?.toLowerCase()
  if (envMode === 'nerd' || envMode === 'nerdfonts' || envMode === 'nf')
    return 'nerd'
  if (envMode === 'emoji' || envMode === 'emojis') return 'emoji'
  if (envMode === 'ascii') return 'ascii'

  // Priority 2: Cached config value
  if (cachedIconMode) return cachedIconMode

  // Priority 3: Default to ascii
  return 'ascii'
}

// Engine brand colors for ASCII mode badges
// background = main brand color, foreground = contrasting text color
type BrandColor = { foreground: string; background: string }

export const ENGINE_BRAND_COLORS: Record<Engine, BrandColor> = {
  [Engine.PostgreSQL]: { foreground: '#FFFFFF', background: '#336791' }, // White on blue
  [Engine.MySQL]: { foreground: '#FFFFFF', background: '#00758F' }, // White on blue
  [Engine.MariaDB]: { foreground: '#FFFFFF', background: '#003545' }, // White on teal
  [Engine.SQLite]: { foreground: '#FFFFFF', background: '#003B57' }, // White on dark blue
  [Engine.DuckDB]: { foreground: '#000000', background: '#FFF100' }, // Black on yellow
  [Engine.MongoDB]: { foreground: '#FFFFFF', background: '#00684A' }, // White on green
  [Engine.FerretDB]: { foreground: '#FFFFFF', background: '#F7931E' }, // White on orange
  [Engine.Redis]: { foreground: '#FFFFFF', background: '#D82C20' }, // White on red
  [Engine.Valkey]: { foreground: '#FFFFFF', background: '#00B5AD' }, // White on teal
  [Engine.ClickHouse]: { foreground: '#000000', background: '#FCFF74' }, // Black on yellow
  [Engine.Qdrant]: { foreground: '#FFFFFF', background: '#DC244C' }, // White on red
  [Engine.Meilisearch]: { foreground: '#FFFFFF', background: '#FF5CAA' }, // White on pink
  [Engine.CouchDB]: { foreground: '#FFFFFF', background: '#E42528' }, // White on red
  [Engine.CockroachDB]: { foreground: '#FFFFFF', background: '#6933FF' }, // White on purple
  [Engine.SurrealDB]: { foreground: '#FFFFFF', background: '#FF00A0' }, // White on pink
  [Engine.QuestDB]: { foreground: '#000000', background: '#02FC04' }, // Black on green
}

// ASCII fallback icons - work in any terminal
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
}

// Nerd Font icons - require a patched font
// Find icons at https://www.nerdfonts.com/cheat-sheet
const NERD_ICONS: Record<Engine, string> = {
  [Engine.PostgreSQL]: '\ue76e', // nf-dev-postgresql
  [Engine.MySQL]: '\ue704', // nf-dev-mysql
  [Engine.MariaDB]: '\ue828', // nf-dev-mariadb
  [Engine.SQLite]: '\ue7c4', // nf-dev-sqlite
  [Engine.DuckDB]: '\ueef7', // nf-md-duck (closest match)
  [Engine.MongoDB]: '\ue7a4', // nf-dev-mongodb
  [Engine.FerretDB]: '\uf06c', // nf-fa-leaf (MongoDB-compatible)
  [Engine.Redis]: '\ue76d', // nf-dev-redis
  [Engine.Valkey]: '\uf29f', // nf-fa-diamond (Redis fork)
  [Engine.ClickHouse]: '\uf015', // nf-fa-house
  [Engine.Qdrant]: '\uf14e', // nf-fa-compass (vector search)
  [Engine.Meilisearch]: '\uf002', // nf-fa-search
  [Engine.CouchDB]: '\ue7a2', // nf-dev-couchdb
  [Engine.CockroachDB]: '\ue269', // nf-fae-cockroach
  [Engine.SurrealDB]: '\uedfe', // nf-fa-infinity (multi-model)
  [Engine.QuestDB]: '\ued2f', // nf-fa-gauge-high (time-series performance)
}

// Emoji icons - original icons, inconsistent width across terminals
const EMOJI_ICONS: Record<Engine, string> = {
  [Engine.PostgreSQL]: '🐘',
  [Engine.MySQL]: '🐬',
  [Engine.MariaDB]: '🦭',
  [Engine.SQLite]: '🪶',
  [Engine.DuckDB]: '🦆',
  [Engine.MongoDB]: '🍃',
  [Engine.FerretDB]: '🦔',
  [Engine.Redis]: '🔴',
  [Engine.Valkey]: '🔷',
  [Engine.ClickHouse]: '🏠',
  [Engine.Qdrant]: '🧭',
  [Engine.Meilisearch]: '🔍',
  [Engine.CouchDB]: '🛋',
  [Engine.CockroachDB]: '🪳',
  [Engine.SurrealDB]: '🌀',
  [Engine.QuestDB]: '⏱',
}

const DEFAULT_ICONS: Record<IconMode, string> = {
  ascii: '[??]',
  nerd: '\ue706', // nf-dev-database
  emoji: '▣',
}

// Terminal identifiers (from TERM_PROGRAM env var)
enum Terminal {
  VSCode = 'vscode',
  VSCodium = 'VSCodium',
  Ghostty = 'ghostty',
  ITerm2 = 'iTerm.app',
  TerminalApp = 'Apple_Terminal',
  Alacritty = 'Alacritty',
  WezTerm = 'WezTerm',
  Kitty = 'kitty',
}

// Emojis that render as 1 cell (narrow) in specific terminals
// These need extra padding to maintain alignment
// NOTE: This map is incomplete - only terminals we've tested are included.
// Other terminals (iTerm2, Terminal.app, etc.) seem to render all emojis as 2 cells.
// Contributions welcome for additional terminal emoji width data.
const NARROW_EMOJIS: Partial<Record<Terminal, Set<string>>> = {
  [Terminal.VSCode]: new Set(['🪶', '🦭', '🪳', '🛋', '⏱']),
  [Terminal.VSCodium]: new Set(['🪶', '🦭', '🪳', '🛋', '⏱']),
  [Terminal.Ghostty]: new Set(['🛋', '⏱']),
}

// Detect current terminal for emoji width adjustments
const currentTerminal = process.env.TERM_PROGRAM as Terminal | undefined

/**
 * Returns engine icon with trailing space for consistent alignment.
 *
 * Icon mode priority:
 * 1. Cached config value (from ~/.spindb/config.json preferences.iconMode)
 * 2. SPINDB_ICONS environment variable
 * 3. Default to 'ascii'
 *
 * Modes:
 * - 'ascii' (default): [PG], [MY], etc. with brand colors - works everywhere
 * - 'nerd': Nerd Font glyphs - requires patched font
 * - 'emoji': Original emojis - inconsistent width across terminals
 */
export function getEngineIcon(engine: string): string {
  const mode = getIconMode()

  if (mode === 'ascii') {
    const icon = ASCII_ICONS[engine as Engine] || DEFAULT_ICONS.ascii
    const colors = ENGINE_BRAND_COLORS[engine as Engine]
    if (colors) {
      // Apply brand colors: foreground text on background
      return chalk.bgHex(colors.background).hex(colors.foreground)(icon) + ' '
    }
    return icon + ' '
  }

  if (mode === 'nerd') {
    const icon = NERD_ICONS[engine as Engine] || DEFAULT_ICONS.nerd
    const colors = ENGINE_BRAND_COLORS[engine as Engine]
    if (colors) {
      // Apply brand background color to nerd font icon
      return chalk.hex(colors.background)(icon) + ' '
    }
    return icon + ' '
  }

  // Emoji mode - needs terminal-specific width handling
  const icon = EMOJI_ICONS[engine as Engine] || DEFAULT_ICONS.emoji

  // Check if this emoji renders narrow in the current terminal
  const narrowSet = currentTerminal ? NARROW_EMOJIS[currentTerminal] : undefined
  const isNarrow = narrowSet?.has(icon) ?? false

  return icon + (isNarrow ? '  ' : ' ')
}
