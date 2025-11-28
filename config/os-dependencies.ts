/**
 * OS-level dependency registry for database engines
 *
 * This module defines the system packages required for each database engine
 * across different operating systems and package managers.
 */

import { getPostgresHomebrewPackage } from './engine-defaults'

export type PackageManagerId = 'brew' | 'apt' | 'yum' | 'dnf' | 'pacman'

export type Platform = 'darwin' | 'linux' | 'win32'

/**
 * Package definition for a specific package manager
 */
export type PackageDefinition = {
  /** Package name to install */
  package: string
  /** Optional post-install commands (e.g., brew link) */
  postInstall?: string[]
  /** Optional pre-install commands */
  preInstall?: string[]
}

/**
 * A single dependency (e.g., psql, pg_dump)
 */
export type Dependency = {
  /** Human-readable name */
  name: string
  /** Binary name to check for in PATH */
  binary: string
  /** Description of what this tool does */
  description: string
  /** Package definitions per package manager */
  packages: Partial<Record<PackageManagerId, PackageDefinition>>
  /** Alternative installation instructions when no package manager is available */
  manualInstall: Partial<Record<Platform, string[]>>
}

/**
 * Engine dependency configuration
 */
export type EngineDependencies = {
  /** Engine identifier */
  engine: string
  /** Human-readable engine name */
  displayName: string
  /** List of dependencies for this engine */
  dependencies: Dependency[]
}

/**
 * Package manager configuration
 */
export type PackageManagerConfig = {
  id: PackageManagerId
  name: string
  /** Command to check if this package manager is installed */
  checkCommand: string
  /** Platforms this package manager is available on */
  platforms: Platform[]
  /** Command template to install a package */
  installTemplate: string
  /** Command template to update/upgrade a package */
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
    },
  }
}

const postgresqlDependencies: EngineDependencies = {
  engine: 'postgresql',
  displayName: 'PostgreSQL',
  dependencies: [
    createPostgresDependency(
      'psql',
      'psql',
      'PostgreSQL interactive terminal',
    ),
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
      },
    },
  ],
}

// =============================================================================
// Registry
// =============================================================================

/**
 * All engine dependencies registry
 */
export const engineDependencies: EngineDependencies[] = [
  postgresqlDependencies,
  mysqlDependencies,
]

/**
 * Get dependencies for a specific engine
 */
export function getEngineDependencies(
  engine: string,
): EngineDependencies | undefined {
  return engineDependencies.find((e) => e.engine === engine)
}

/**
 * Get all dependencies across all engines
 */
export function getAllDependencies(): Dependency[] {
  return engineDependencies.flatMap((e) => e.dependencies)
}

/**
 * Get unique dependencies (deduplicated by binary name)
 */
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

/**
 * Get package manager config by ID
 */
export function getPackageManager(
  id: PackageManagerId,
): PackageManagerConfig | undefined {
  return packageManagers.find((pm) => pm.id === id)
}

/**
 * Get package managers available for a platform
 */
export function getPackageManagersForPlatform(
  platform: Platform,
): PackageManagerConfig[] {
  return packageManagers.filter((pm) => pm.platforms.includes(platform))
}
