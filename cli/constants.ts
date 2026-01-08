export const ENGINE_ICONS: Record<string, string> = {
  postgresql: '🐘',
  mysql: '🐬',
  mariadb: '🦭',
  sqlite: '🪶',
  mongodb: '🍃',
  redis: '🔴',
}

export const DEFAULT_ENGINE_ICON = '▣'

export function getEngineIcon(engine: string): string {
  return ENGINE_ICONS[engine] || DEFAULT_ENGINE_ICON
}
