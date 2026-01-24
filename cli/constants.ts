// Engine icons - do NOT add trailing spaces here
export const ENGINE_ICONS: Record<string, string> = {
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
}

// Visual width of each icon in terminal columns
// Most emojis render at width 2, but some render narrower (width 1)
// This map allows us to pad icons correctly for column alignment
export const ENGINE_ICON_WIDTHS: Record<string, number> = {
  postgresql: 2,
  mysql: 2,
  mariadb: 1, // 🦭 seal renders narrow
  sqlite: 1, // 🪶 feather renders narrow
  duckdb: 2,
  mongodb: 2,
  ferretdb: 2,
  redis: 2,
  valkey: 2,
  clickhouse: 2,
  qdrant: 2,
  meilisearch: 2,
}

export const DEFAULT_ENGINE_ICON = '▣'
export const DEFAULT_ICON_WIDTH = 2

export function getEngineIcon(engine: string): string {
  return ENGINE_ICONS[engine] || DEFAULT_ENGINE_ICON
}

// Returns icon width for alignment calculations
export function getEngineIconWidth(engine: string): number {
  return ENGINE_ICON_WIDTHS[engine] ?? DEFAULT_ICON_WIDTH
}

// Returns icon padded to consistent width (2 columns)
// Use this when displaying icons in aligned columns
export function getEngineIconPadded(engine: string, targetWidth = 2): string {
  const icon = ENGINE_ICONS[engine] || DEFAULT_ENGINE_ICON
  const width = ENGINE_ICON_WIDTHS[engine] ?? DEFAULT_ICON_WIDTH
  const padding = Math.max(0, targetWidth - width)
  return icon + ' '.repeat(padding)
}
