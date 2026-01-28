// Engine icons - raw emojis without trailing spaces
// Use getEngineIcon() to get the icon with consistent spacing
// NOTE: Avoid variation selectors (U+FE0F) - they cause inconsistent width rendering
const ENGINE_ICONS: Record<string, string> = {
  postgresql: '🐘',
  mysql: '🐬',
  mariadb: '🦭',
  sqlite: '🪶',
  duckdb: '🦆',
  mongodb: '🍃',
  ferretdb: '🦔',
  redis: '🔴',
  valkey: '🔷',
  clickhouse: '🏠',
  qdrant: '🧭',
  meilisearch: '🔍',
  couchdb: '🛋',
  cockroachdb: '🪳',
  surrealdb: '🌀',
  questdb: '⏱',
}

const DEFAULT_ENGINE_ICON = '▣'

// Emojis that render as 1 cell (narrow) in specific terminals
// These need extra padding to maintain alignment
// Based on testing in actual terminals:
const NARROW_IN_VSCODE = new Set(['🪶', '🦭', '🪳', '🛋', '⏱'])
const NARROW_IN_GHOSTTY = new Set(['🛋', '⏱'])

// Detect terminal
const isVSCodeTerminal =
  process.env.TERM_PROGRAM === 'vscode' ||
  process.env.TERM_PROGRAM === 'VSCodium'
const isGhosttyTerminal = process.env.TERM_PROGRAM === 'ghostty'

/**
 * Returns engine icon with trailing spaces for consistent alignment.
 *
 * Terminal emulators render emoji widths inconsistently.
 * We maintain per-terminal lists of narrow emojis that need extra padding.
 */
export function getEngineIcon(engine: string): string {
  const icon = ENGINE_ICONS[engine] || DEFAULT_ENGINE_ICON

  let isNarrow = false
  if (isVSCodeTerminal) {
    isNarrow = NARROW_IN_VSCODE.has(icon)
  } else if (isGhosttyTerminal) {
    isNarrow = NARROW_IN_GHOSTTY.has(icon)
  }
  // Other terminals (iTerm2, Terminal.app) seem to render all emojis as 2 cells

  return icon + (isNarrow ? '  ' : ' ')
}

/**
 * @deprecated Use getEngineIcon() instead - it now includes consistent spacing
 */
export function getEngineIconPadded(engine: string): string {
  return getEngineIcon(engine)
}
