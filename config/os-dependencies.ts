/**
 * OS-level dependency registry for database engines
 *
 * This module defines the system packages required for each database engine
 * across different operating systems and package managers.
 */

import { getPostgresHomebrewPackage } from './engine-defaults'

export type PackageManagerId =
  | 'brew'
  | 'apt'
  | 'yum'
  | 'dnf'
  | 'pacman'
  | 'choco'
  | 'winget'
  | 'scoop'

export type Platform = 'darwin' | 'linux' | 'win32'

// Package definition for a specific package manager
export type PackageDefinition = {
  // Package name to install
  package: string
  // Optional post-install commands (e.g., brew link)
  postInstall?: string[]
  // Optional pre-install commands
  preInstall?: string[]
}

// A single dependency (e.g., psql, pg_dump)
export type Dependency = {
  // Human-readable name
  name: string
  // Binary name to check for in PATH
  binary: string
  // Description of what this tool does
  description: string
  // Package definitions per package manager
  packages: Partial<Record<PackageManagerId, PackageDefinition>>
  // Alternative installation instructions when no package manager is available
  manualInstall: Partial<Record<Platform, string[]>>
}

// Engine dependency configuration
export type EngineDependencies = {
  // Engine identifier
  engine: string
  // Human-readable engine name
  displayName: string
  // List of dependencies for this engine
  dependencies: Dependency[]
}

// Package manager configuration
export type PackageManagerConfig = {
  id: PackageManagerId
  name: string
  // Command to check if this package manager is installed
  checkCommand: string
  // Platforms this package manager is available on
  platforms: Platform[]
  // Command template to install a package
  installTemplate: string
  // Command template to update/upgrade a package
  updateTemplate: string
}

// =============================================================================
// Package Manager Definitions
// =============================================================================

export const packageManagers: PackageManagerConfig[] = [
  {
    id: 'brew',
    name: 'Homebrew',
    checkCommand: 'brew --version',
    platforms: ['darwin'],
    installTemplate: 'brew install {package}',
    updateTemplate: 'brew upgrade {package}',
  },
  {
    id: 'apt',
    name: 'APT',
    checkCommand: 'apt --version',
    platforms: ['linux'],
    installTemplate: 'sudo apt update && sudo apt install -y {package}',
    updateTemplate: 'sudo apt update && sudo apt upgrade -y {package}',
  },
  {
    id: 'yum',
    name: 'YUM',
    checkCommand: 'yum --version',
    platforms: ['linux'],
    installTemplate: 'sudo yum install -y {package}',
    updateTemplate: 'sudo yum update -y {package}',
  },
  {
    id: 'dnf',
    name: 'DNF',
    checkCommand: 'dnf --version',
    platforms: ['linux'],
    installTemplate: 'sudo dnf install -y {package}',
    updateTemplate: 'sudo dnf upgrade -y {package}',
  },
  {
    id: 'pacman',
    name: 'Pacman',
    checkCommand: 'pacman --version',
    platforms: ['linux'],
    installTemplate: 'sudo pacman -S --noconfirm {package}',
    updateTemplate: 'sudo pacman -Syu --noconfirm {package}',
  },
  {
    id: 'choco',
    name: 'Chocolatey',
    checkCommand: 'choco --version',
    platforms: ['win32'],
    installTemplate: 'choco install -y {package}',
    updateTemplate: 'choco upgrade -y {package}',
  },
  {
    id: 'winget',
    name: 'Windows Package Manager',
    checkCommand: 'winget --version',
    platforms: ['win32'],
    installTemplate: 'winget install {package}',
    updateTemplate: 'winget upgrade {package}',
  },
  {
    id: 'scoop',
    name: 'Scoop',
    checkCommand: 'scoop --version',
    platforms: ['win32'],
    installTemplate: 'scoop install {package}',
    updateTemplate: 'scoop update {package}',
  },
]

// =============================================================================
// PostgreSQL Dependencies
// =============================================================================

/**
 * Helper to create PostgreSQL client tool dependency
 * Uses getPostgresHomebrewPackage() to get the current latest version
 */
function createPostgresDependency(
  name: string,
  binary: string,
  description: string,
): Dependency {
  const pgPackage = getPostgresHomebrewPackage()
  return {
    name,
    binary,
    description,
    packages: {
      brew: {
        package: pgPackage,
        postInstall: [`brew link --overwrite ${pgPackage}`],
      },
      apt: { package: 'postgresql-client' },
      yum: { package: 'postgresql' },
      dnf: { package: 'postgresql' },
      pacman: { package: 'postgresql-libs' },
      choco: { package: 'postgresql' },
      winget: { package: 'PostgreSQL.PostgreSQL' },
      scoop: { package: 'postgresql' },
    },
    manualInstall: {
      darwin: [
        'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        `Then run: brew install ${pgPackage} && brew link --overwrite ${pgPackage}`,
        'Or install Postgres.app: https://postgresapp.com/downloads.html',
      ],
      linux: [
        'Ubuntu/Debian: sudo apt install postgresql-client',
        'CentOS/RHEL: sudo yum install postgresql',
        'Fedora: sudo dnf install postgresql',
        'Arch: sudo pacman -S postgresql-libs',
      ],
      win32: [
        'Using Chocolatey: choco install postgresql',
        'Using winget: winget install PostgreSQL.PostgreSQL',
        'Using Scoop: scoop install postgresql',
        'Or download from: https://www.enterprisedb.com/downloads/postgres-postgresql-downloads',
      ],
    },
  }
}

const postgresqlDependencies: EngineDependencies = {
  engine: 'postgresql',
  displayName: 'PostgreSQL',
  dependencies: [
    createPostgresDependency('psql', 'psql', 'PostgreSQL interactive terminal'),
    createPostgresDependency(
      'pg_dump',
      'pg_dump',
      'PostgreSQL database backup utility',
    ),
    createPostgresDependency(
      'pg_restore',
      'pg_restore',
      'PostgreSQL database restore utility',
    ),
    createPostgresDependency(
      'pg_basebackup',
      'pg_basebackup',
      'PostgreSQL base backup utility for physical backups',
    ),
  ],
}

// =============================================================================
// MySQL Dependencies (placeholder for future)
// =============================================================================

const mysqlDependencies: EngineDependencies = {
  engine: 'mysql',
  displayName: 'MySQL/MariaDB',
  dependencies: [
    {
      name: 'mysqld',
      binary: 'mysqld',
      description: 'MySQL/MariaDB server daemon',
      packages: {
        brew: { package: 'mysql' },
        // Modern Debian/Ubuntu use mariadb-server (MySQL-compatible)
        apt: { package: 'mariadb-server' },
        choco: { package: 'mysql' },
        winget: { package: 'Oracle.MySQL' },
        scoop: { package: 'mysql' },
        yum: { package: 'mariadb-server' },
        dnf: { package: 'mariadb-server' },
        pacman: { package: 'mariadb' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Then run: brew install mysql',
        ],
        linux: [
          'Debian/Ubuntu: sudo apt install mariadb-server',
          'CentOS/RHEL: sudo yum install mariadb-server',
          'Fedora: sudo dnf install mariadb-server',
          'Arch: sudo pacman -S mariadb',
        ],
        win32: [
          'Using Chocolatey: choco install mysql',
          'Using winget: winget install Oracle.MySQL',
          'Using Scoop: scoop install mysql',
          'Or download from: https://dev.mysql.com/downloads/mysql/',
        ],
      },
    },
    {
      name: 'mysql',
      binary: 'mysql',
      description: 'MySQL/MariaDB command-line client',
      packages: {
        brew: { package: 'mysql' },
        apt: { package: 'mariadb-client' },
        yum: { package: 'mariadb' },
        dnf: { package: 'mariadb' },
        pacman: { package: 'mariadb-clients' },
        choco: { package: 'mysql' },
        winget: { package: 'Oracle.MySQL' },
        scoop: { package: 'mysql' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Then run: brew install mysql',
        ],
        linux: [
          'Debian/Ubuntu: sudo apt install mariadb-client',
          'CentOS/RHEL: sudo yum install mariadb',
          'Fedora: sudo dnf install mariadb',
          'Arch: sudo pacman -S mariadb-clients',
        ],
        win32: [
          'Using Chocolatey: choco install mysql',
          'Using winget: winget install Oracle.MySQL',
          'Using Scoop: scoop install mysql',
          'Or download from: https://dev.mysql.com/downloads/mysql/',
        ],
      },
    },
    {
      name: 'mysqldump',
      binary: 'mysqldump',
      description: 'MySQL/MariaDB database backup utility',
      packages: {
        brew: { package: 'mysql' },
        apt: { package: 'mariadb-client' },
        yum: { package: 'mariadb' },
        dnf: { package: 'mariadb' },
        pacman: { package: 'mariadb-clients' },
        choco: { package: 'mysql' },
        winget: { package: 'Oracle.MySQL' },
        scoop: { package: 'mysql' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Then run: brew install mysql',
        ],
        linux: [
          'Debian/Ubuntu: sudo apt install mariadb-client',
          'CentOS/RHEL: sudo yum install mariadb',
          'Fedora: sudo dnf install mariadb',
          'Arch: sudo pacman -S mariadb-clients',
        ],
        win32: [
          'Using Chocolatey: choco install mysql',
          'Using winget: winget install Oracle.MySQL',
          'Using Scoop: scoop install mysql',
          'Or download from: https://dev.mysql.com/downloads/mysql/',
        ],
      },
    },
    {
      name: 'mysqladmin',
      binary: 'mysqladmin',
      description: 'MySQL/MariaDB server administration utility',
      packages: {
        brew: { package: 'mysql' },
        apt: { package: 'mariadb-client' },
        yum: { package: 'mariadb' },
        dnf: { package: 'mariadb' },
        pacman: { package: 'mariadb-clients' },
        choco: { package: 'mysql' },
        winget: { package: 'Oracle.MySQL' },
        scoop: { package: 'mysql' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Then run: brew install mysql',
        ],
        linux: [
          'Debian/Ubuntu: sudo apt install mariadb-client',
          'CentOS/RHEL: sudo yum install mariadb',
          'Fedora: sudo dnf install mariadb',
          'Arch: sudo pacman -S mariadb-clients',
        ],
        win32: [
          'Using Chocolatey: choco install mysql',
          'Using winget: winget install Oracle.MySQL',
          'Using Scoop: scoop install mysql',
          'Or download from: https://dev.mysql.com/downloads/mysql/',
        ],
      },
    },
  ],
}

// =============================================================================
// SQLite Dependencies
// =============================================================================

const sqliteDependencies: EngineDependencies = {
  engine: 'sqlite',
  displayName: 'SQLite',
  dependencies: [
    {
      name: 'sqlite3',
      binary: 'sqlite3',
      description: 'SQLite command-line interface',
      packages: {
        brew: { package: 'sqlite' },
        apt: { package: 'sqlite3' },
        yum: { package: 'sqlite' },
        dnf: { package: 'sqlite' },
        pacman: { package: 'sqlite' },
        choco: { package: 'sqlite' },
        winget: { package: 'SQLite.SQLite' },
        scoop: { package: 'sqlite' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Then run: brew install sqlite',
          'Note: macOS includes sqlite3 by default in /usr/bin/sqlite3',
        ],
        linux: [
          'Debian/Ubuntu: sudo apt install sqlite3',
          'CentOS/RHEL: sudo yum install sqlite',
          'Fedora: sudo dnf install sqlite',
          'Arch: sudo pacman -S sqlite',
        ],
        win32: [
          'Using Chocolatey: choco install sqlite',
          'Using winget: winget install SQLite.SQLite',
          'Using Scoop: scoop install sqlite',
          'Or download from: https://www.sqlite.org/download.html',
        ],
      },
    },
  ],
}

// =============================================================================
// MongoDB Dependencies
// =============================================================================

const mongodbDependencies: EngineDependencies = {
  engine: 'mongodb',
  displayName: 'MongoDB',
  dependencies: [
    {
      name: 'mongod',
      binary: 'mongod',
      description: 'MongoDB server daemon',
      packages: {
        brew: {
          package: 'mongodb/brew/mongodb-community',
          preInstall: ['brew tap mongodb/brew'],
        },
        // MongoDB requires their own apt repository, not available in default repos
        choco: { package: 'mongodb' },
        winget: { package: 'MongoDB.Server' },
        scoop: { package: 'mongodb' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Add MongoDB tap: brew tap mongodb/brew',
          'Then run: brew install mongodb-community',
          'For specific versions: brew install mongodb-community@7.0',
        ],
        linux: [
          'MongoDB requires adding their official repository.',
          'Ubuntu/Debian: Follow https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-ubuntu/',
          'RHEL/CentOS: Follow https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-red-hat/',
        ],
        win32: [
          'Using Chocolatey: choco install mongodb',
          'Using winget: winget install MongoDB.Server',
          'Or download from: https://www.mongodb.com/try/download/community',
        ],
      },
    },
    {
      name: 'mongosh',
      binary: 'mongosh',
      description: 'MongoDB Shell (modern interactive shell)',
      packages: {
        brew: { package: 'mongosh' },
        choco: { package: 'mongodb-shell' },
        winget: { package: 'MongoDB.Shell' },
        scoop: { package: 'mongosh' },
      },
      manualInstall: {
        darwin: [
          'Install with Homebrew: brew install mongosh',
          'Or download from: https://www.mongodb.com/try/download/shell',
        ],
        linux: [
          'Download from: https://www.mongodb.com/try/download/shell',
          'Or install via npm: npm install -g mongosh',
        ],
        win32: [
          'Using Chocolatey: choco install mongodb-shell',
          'Using winget: winget install MongoDB.Shell',
          'Or download from: https://www.mongodb.com/try/download/shell',
        ],
      },
    },
    {
      name: 'mongodump',
      binary: 'mongodump',
      description: 'MongoDB database backup utility',
      packages: {
        brew: { package: 'mongodb-database-tools' },
        choco: { package: 'mongodb-database-tools' },
      },
      manualInstall: {
        darwin: [
          'Install with Homebrew: brew install mongodb-database-tools',
          'Or download from: https://www.mongodb.com/try/download/database-tools',
        ],
        linux: [
          'Download from: https://www.mongodb.com/try/download/database-tools',
          'Extract and add to PATH',
        ],
        win32: [
          'Using Chocolatey: choco install mongodb-database-tools',
          'Or download from: https://www.mongodb.com/try/download/database-tools',
        ],
      },
    },
    {
      name: 'mongorestore',
      binary: 'mongorestore',
      description: 'MongoDB database restore utility',
      packages: {
        brew: { package: 'mongodb-database-tools' },
        choco: { package: 'mongodb-database-tools' },
      },
      manualInstall: {
        darwin: [
          'Install with Homebrew: brew install mongodb-database-tools',
          'Or download from: https://www.mongodb.com/try/download/database-tools',
        ],
        linux: [
          'Download from: https://www.mongodb.com/try/download/database-tools',
          'Extract and add to PATH',
        ],
        win32: [
          'Using Chocolatey: choco install mongodb-database-tools',
          'Or download from: https://www.mongodb.com/try/download/database-tools',
        ],
      },
    },
  ],
}

// =============================================================================
// Redis Dependencies
// =============================================================================

const redisDependencies: EngineDependencies = {
  engine: 'redis',
  displayName: 'Redis',
  dependencies: [
    {
      name: 'redis-server',
      binary: 'redis-server',
      description: 'Redis in-memory data store server',
      packages: {
        brew: { package: 'redis' },
        apt: { package: 'redis-server' },
        yum: { package: 'redis' },
        dnf: { package: 'redis' },
        pacman: { package: 'redis' },
        winget: { package: 'Redis.Redis' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Then run: brew install redis',
          'To start as service: brew services start redis',
        ],
        linux: [
          'Debian/Ubuntu: sudo apt install redis-server',
          'CentOS/RHEL: sudo yum install redis',
          'Fedora: sudo dnf install redis',
          'Arch: sudo pacman -S redis',
        ],
        win32: [
          'Using winget (recommended): winget install Redis.Redis',
          'Or download from: https://github.com/redis-windows/redis-windows/releases',
        ],
      },
    },
    {
      name: 'redis-cli',
      binary: 'redis-cli',
      description: 'Redis command-line interface client',
      packages: {
        brew: { package: 'redis' },
        apt: { package: 'redis-tools' },
        yum: { package: 'redis' },
        dnf: { package: 'redis' },
        pacman: { package: 'redis' },
        winget: { package: 'Redis.Redis' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Then run: brew install redis',
        ],
        linux: [
          'Debian/Ubuntu: sudo apt install redis-tools',
          'CentOS/RHEL: sudo yum install redis',
          'Fedora: sudo dnf install redis',
          'Arch: sudo pacman -S redis',
        ],
        win32: [
          'Using winget (recommended): winget install Redis.Redis',
          'Or download from: https://github.com/redis-windows/redis-windows/releases',
        ],
      },
    },
  ],
}

// =============================================================================
// Valkey Dependencies
// =============================================================================

const valkeyDependencies: EngineDependencies = {
  engine: 'valkey',
  displayName: 'Valkey',
  dependencies: [
    {
      name: 'valkey-server',
      binary: 'valkey-server',
      description: 'Valkey in-memory data store server (Redis fork)',
      packages: {
        // Valkey is relatively new - not yet in most package managers
        // Primary distribution is via GitHub releases (hostdb)
        brew: { package: 'valkey' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Then run: brew install valkey',
          'Or use SpinDB: spindb engines download valkey 9',
        ],
        linux: [
          'Valkey is not yet in most Linux package repositories.',
          'Use SpinDB to download binaries: spindb engines download valkey 9',
          'Or build from source: https://github.com/valkey-io/valkey',
        ],
        win32: [
          'Use SpinDB to download binaries: spindb engines download valkey 9',
          'Or build from source: https://github.com/valkey-io/valkey',
        ],
      },
    },
    {
      name: 'valkey-cli',
      binary: 'valkey-cli',
      description: 'Valkey command-line interface client',
      packages: {
        brew: { package: 'valkey' },
      },
      manualInstall: {
        darwin: [
          'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          'Then run: brew install valkey',
          'Or use SpinDB: spindb engines download valkey 9',
        ],
        linux: [
          'Valkey is not yet in most Linux package repositories.',
          'Use SpinDB to download binaries: spindb engines download valkey 9',
          'Or build from source: https://github.com/valkey-io/valkey',
        ],
        win32: [
          'Use SpinDB to download binaries: spindb engines download valkey 9',
          'Or build from source: https://github.com/valkey-io/valkey',
        ],
      },
    },
  ],
}

// =============================================================================
// ClickHouse Dependencies
// =============================================================================

const clickhouseDependencies: EngineDependencies = {
  engine: 'clickhouse',
  displayName: 'ClickHouse',
  dependencies: [
    {
      name: 'clickhouse',
      binary: 'clickhouse',
      description:
        'ClickHouse database binaries (clickhouse-server, clickhouse-client, clickhouse-local, clickhouse-benchmark). Homebrew installs the unified clickhouse binary with subcommands.',
      packages: {
        brew: { package: 'clickhouse' },
        // ClickHouse requires their own apt repository
      },
      manualInstall: {
        darwin: [
          'Install with Homebrew: brew install clickhouse',
          'Or use SpinDB: spindb engines download clickhouse 25.12',
        ],
        linux: [
          'ClickHouse provides official packages.',
          'Add their apt repository: https://clickhouse.com/docs/en/install#install-from-deb-packages',
          'Or use SpinDB: spindb engines download clickhouse 25.12',
        ],
        win32: [
          'ClickHouse does not officially support Windows.',
          'Use WSL2 with Linux installation instructions.',
        ],
      },
    },
  ],
}

// =============================================================================
// Optional Tools (engine-agnostic)
// =============================================================================

/**
 * usql - Universal SQL client
 * Works with PostgreSQL, MySQL, SQLite, and 20+ other databases
 * https://github.com/xo/usql
 */
export const usqlDependency: Dependency = {
  name: 'usql',
  binary: 'usql',
  description:
    'Universal SQL client with auto-completion, syntax highlighting, and multi-database support',
  packages: {
    brew: {
      package: 'xo/xo/usql',
      preInstall: ['brew tap xo/xo'],
    },
    // Note: usql is not in standard Linux package repos, must use manual install
  },
  manualInstall: {
    darwin: [
      'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      'Then run: brew tap xo/xo && brew install xo/xo/usql',
    ],
    linux: [
      'Download from GitHub releases: https://github.com/xo/usql/releases',
      'Extract and move to PATH: sudo mv usql /usr/local/bin/',
      'Or install via Go: go install github.com/xo/usql@latest',
    ],
  },
}

/**
 * pgcli - PostgreSQL CLI with auto-completion and syntax highlighting
 * https://github.com/dbcli/pgcli
 */
export const pgcliDependency: Dependency = {
  name: 'pgcli',
  binary: 'pgcli',
  description:
    'PostgreSQL CLI with intelligent auto-completion and syntax highlighting',
  packages: {
    brew: { package: 'pgcli' },
    apt: { package: 'pgcli' },
    dnf: { package: 'pgcli' },
    yum: { package: 'pgcli' },
    pacman: { package: 'pgcli' },
  },
  manualInstall: {
    darwin: [
      'Install with Homebrew: brew install pgcli',
      'Or with pip: pip install pgcli',
    ],
    linux: [
      'Debian/Ubuntu: sudo apt install pgcli',
      'Fedora: sudo dnf install pgcli',
      'Or with pip: pip install pgcli',
    ],
  },
}

/**
 * mycli - MySQL CLI with auto-completion and syntax highlighting
 * https://github.com/dbcli/mycli
 */
export const mycliDependency: Dependency = {
  name: 'mycli',
  binary: 'mycli',
  description:
    'MySQL/MariaDB CLI with intelligent auto-completion and syntax highlighting',
  packages: {
    brew: { package: 'mycli' },
    apt: { package: 'mycli' },
    dnf: { package: 'mycli' },
    yum: { package: 'mycli' },
    pacman: { package: 'mycli' },
  },
  manualInstall: {
    darwin: [
      'Install with Homebrew: brew install mycli',
      'Or with pip: pip install mycli',
    ],
    linux: [
      'Debian/Ubuntu: sudo apt install mycli',
      'Fedora: sudo dnf install mycli',
      'Or with pip: pip install mycli',
    ],
  },
}

/**
 * litecli - SQLite CLI with auto-completion and syntax highlighting
 * https://github.com/dbcli/litecli
 */
export const litecliDependency: Dependency = {
  name: 'litecli',
  binary: 'litecli',
  description:
    'SQLite CLI with intelligent auto-completion and syntax highlighting',
  packages: {
    brew: { package: 'litecli' },
    apt: { package: 'litecli' },
    dnf: { package: 'litecli' },
    yum: { package: 'litecli' },
    pacman: { package: 'litecli' },
  },
  manualInstall: {
    darwin: [
      'Install with Homebrew: brew install litecli',
      'Or with pip: pip install litecli',
    ],
    linux: [
      'Debian/Ubuntu: sudo apt install litecli',
      'Fedora: sudo dnf install litecli',
      'Or with pip: pip install litecli',
    ],
  },
}

/**
 * iredis - Redis CLI with auto-completion and syntax highlighting
 * https://github.com/laixintao/iredis
 */
export const iredisDependency: Dependency = {
  name: 'iredis',
  binary: 'iredis',
  description:
    'Redis CLI with intelligent auto-completion and syntax highlighting',
  packages: {
    brew: { package: 'iredis' },
    // Most platforms use pip install
  },
  manualInstall: {
    darwin: [
      'Install with Homebrew: brew install iredis',
      'Or with pip: pip install iredis',
    ],
    linux: ['Install with pip: pip install iredis'],
    win32: ['Install with pip: pip install iredis'],
  },
}

// =============================================================================
// Registry
// =============================================================================

// All engine dependencies registry
export const engineDependencies: EngineDependencies[] = [
  postgresqlDependencies,
  mysqlDependencies,
  sqliteDependencies,
  mongodbDependencies,
  redisDependencies,
  valkeyDependencies,
  clickhouseDependencies,
]

// Get dependencies for a specific engine
export function getEngineDependencies(
  engine: string,
): EngineDependencies | undefined {
  return engineDependencies.find((e) => e.engine === engine)
}

// Get all dependencies across all engines
export function getAllDependencies(): Dependency[] {
  return engineDependencies.flatMap((e) => e.dependencies)
}

// Get unique dependencies (deduplicated by binary name)
export function getUniqueDependencies(): Dependency[] {
  const seen = new Set<string>()
  const unique: Dependency[] = []

  for (const dep of getAllDependencies()) {
    if (!seen.has(dep.binary)) {
      seen.add(dep.binary)
      unique.push(dep)
    }
  }

  return unique
}

// Get package manager config by ID
export function getPackageManager(
  id: PackageManagerId,
): PackageManagerConfig | undefined {
  return packageManagers.find((pm) => pm.id === id)
}

// Get package managers available for a platform
export function getPackageManagersForPlatform(
  platform: Platform,
): PackageManagerConfig[] {
  return packageManagers.filter((pm) => pm.platforms.includes(platform))
}
