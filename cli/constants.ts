// Note: Some emojis render narrower than others in terminals.
// Add extra space after narrow emojis (🦭, 🪶) for visual alignment.
export const ENGINE_ICONS: Record<string, string> = {
  postgresql: '🐘',
  mysql: '🐬',
  mariadb: '🦭 ', // Extra space - seal emoji renders narrow
  sqlite: '🪶 ',  // Extra space - feather emoji renders narrow
  mongodb: '🍃',
  redis: '🔴',
}

export const DEFAULT_ENGINE_ICON = '▣'

export function getEngineIcon(engine: string): string {
  return ENGINE_ICONS[engine] || DEFAULT_ENGINE_ICON
}
