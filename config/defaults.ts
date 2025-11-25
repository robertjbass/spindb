export type PlatformMappings = {
  [key: string]: string
}

export type PortRange = {
  start: number
  end: number
}

export type Defaults = {
  postgresVersion: string
  port: number
  portRange: PortRange
  engine: string
  supportedPostgresVersions: string[]
  superuser: string
  platformMappings: PlatformMappings
}

// TODO - make defaults configurable via env vars or config file
// TODO - make defaults generic so it supports multiple engines
// TODO - consider using a configuration file or environment variables for overrides
export const defaults: Defaults = {
  // Default PostgreSQL version
  postgresVersion: '16',

  // Default port (standard PostgreSQL port)
  port: 5432,

  // Port range to scan if default is busy
  portRange: {
    start: 5432,
    end: 5500,
  },

  // Default engine
  engine: 'postgresql',

  // Supported PostgreSQL versions
  supportedPostgresVersions: ['14', '15', '16', '17'],

  // Default superuser
  superuser: 'postgres',

  // Platform mappings for zonky.io binaries
  platformMappings: {
    'darwin-arm64': 'darwin-arm64v8',
    'darwin-x64': 'darwin-amd64',
    'linux-arm64': 'linux-arm64v8',
    'linux-x64': 'linux-amd64',
  },
}
