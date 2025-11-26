import { Command } from 'commander'
import chalk from 'chalk'
import { header, success, warning, error } from '../ui/theme'
import { createSpinner } from '../ui/spinner'
import {
  detectPackageManager,
  checkEngineDependencies,
  getMissingDependencies,
  getAllMissingDependencies,
  installEngineDependencies,
  installAllDependencies,
  getManualInstallInstructions,
  getCurrentPlatform,
  type DependencyStatus,
} from '../../core/dependency-manager'
import {
  engineDependencies,
  getEngineDependencies,
} from '../../config/os-dependencies'

/**
 * Format dependency status for display
 */
function formatStatus(status: DependencyStatus): string {
  const { dependency, installed, path, version } = status

  if (installed) {
    const versionStr = version ? ` (${version})` : ''
    const pathStr = path ? chalk.gray(` → ${path}`) : ''
    return `  ${chalk.green('✓')} ${dependency.name}${versionStr}${pathStr}`
  } else {
    return `  ${chalk.red('✗')} ${dependency.name} ${chalk.gray('- not installed')}`
  }
}

export const depsCommand = new Command('deps').description(
  'Manage OS-level database client dependencies',
)

// =============================================================================
// deps check
// =============================================================================

depsCommand
  .command('check')
  .description('Check status of database client tools')
  .option('-e, --engine <engine>', 'Check dependencies for a specific engine')
  .option('-a, --all', 'Check all dependencies for all engines')
  .action(async (options: { engine?: string; all?: boolean }) => {
    console.log(header('Dependency Status'))
    console.log()

    // Detect package manager
    const packageManager = await detectPackageManager()
    if (packageManager) {
      console.log(`  Package Manager: ${chalk.cyan(packageManager.name)}`)
    } else {
      console.log(`  Package Manager: ${chalk.yellow('Not detected')}`)
    }
    console.log()

    if (options.all || (!options.engine && !options.all)) {
      // Check all engines
      for (const engineConfig of engineDependencies) {
        console.log(chalk.bold(`${engineConfig.displayName}:`))

        const statuses = await checkEngineDependencies(engineConfig.engine)
        for (const status of statuses) {
          console.log(formatStatus(status))
        }

        const installed = statuses.filter((s) => s.installed).length
        const total = statuses.length
        if (installed === total) {
          console.log(chalk.green(`  All ${total} dependencies installed`))
        } else {
          console.log(
            chalk.yellow(`  ${installed}/${total} dependencies installed`),
          )
        }
        console.log()
      }
    } else if (options.engine) {
      // Check specific engine
      const engineConfig = getEngineDependencies(options.engine)
      if (!engineConfig) {
        console.error(error(`Unknown engine: ${options.engine}`))
        console.log(
          chalk.gray(
            `  Available engines: ${engineDependencies.map((e) => e.engine).join(', ')}`,
          ),
        )
        process.exit(1)
      }

      console.log(chalk.bold(`${engineConfig.displayName}:`))

      const statuses = await checkEngineDependencies(options.engine)
      for (const status of statuses) {
        console.log(formatStatus(status))
      }

      const installed = statuses.filter((s) => s.installed).length
      const total = statuses.length
      console.log()
      if (installed === total) {
        console.log(success(`All ${total} dependencies installed`))
      } else {
        console.log(warning(`${installed}/${total} dependencies installed`))
        console.log()
        console.log(
          chalk.gray(`  Run: spindb deps install --engine ${options.engine}`),
        )
      }
    }
  })

// =============================================================================
// deps install
// =============================================================================

depsCommand
  .command('install')
  .description('Install missing database client tools')
  .option(
    '-e, --engine <engine>',
    'Install dependencies for a specific engine (e.g., postgresql, mysql)',
  )
  .option('-a, --all', 'Install all missing dependencies for all engines')
  .action(async (options: { engine?: string; all?: boolean }) => {
    // Detect package manager first
    const packageManager = await detectPackageManager()

    if (!packageManager) {
      console.log(error('No supported package manager detected'))
      console.log()

      const platform = getCurrentPlatform()
      if (platform === 'darwin') {
        console.log(chalk.gray('  macOS: Install Homebrew first:'))
        console.log(
          chalk.cyan(
            '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          ),
        )
      } else {
        console.log(
          chalk.gray('  Supported package managers: apt, yum, dnf, pacman'),
        )
      }
      process.exit(1)
    }

    console.log(header('Installing Dependencies'))
    console.log()
    console.log(`  Using: ${chalk.cyan(packageManager.name)}`)
    console.log()

    if (options.all) {
      // Install all missing dependencies
      const missing = await getAllMissingDependencies()

      if (missing.length === 0) {
        console.log(success('All dependencies are already installed'))
        return
      }

      console.log(`  Missing: ${missing.map((d) => d.name).join(', ')}`)
      console.log()

      const spinner = createSpinner('Installing dependencies...')
      spinner.start()

      const results = await installAllDependencies(packageManager)

      const succeeded = results.filter((r) => r.success)
      const failed = results.filter((r) => !r.success)

      if (failed.length === 0) {
        spinner.succeed('All dependencies installed successfully')
      } else {
        spinner.warn('Some dependencies failed to install')
        console.log()
        for (const f of failed) {
          console.log(error(`  ${f.dependency.name}: ${f.error}`))
        }
      }

      if (succeeded.length > 0) {
        console.log()
        console.log(success(`Installed: ${succeeded.map((r) => r.dependency.name).join(', ')}`))
      }
    } else if (options.engine) {
      // Install dependencies for specific engine
      const engineConfig = getEngineDependencies(options.engine)
      if (!engineConfig) {
        console.error(error(`Unknown engine: ${options.engine}`))
        console.log(
          chalk.gray(
            `  Available engines: ${engineDependencies.map((e) => e.engine).join(', ')}`,
          ),
        )
        process.exit(1)
      }

      const missing = await getMissingDependencies(options.engine)

      if (missing.length === 0) {
        console.log(
          success(`All ${engineConfig.displayName} dependencies are installed`),
        )
        return
      }

      console.log(`  Engine: ${chalk.cyan(engineConfig.displayName)}`)
      console.log(`  Missing: ${missing.map((d) => d.name).join(', ')}`)
      console.log()

      const spinner = createSpinner(
        `Installing ${engineConfig.displayName} dependencies...`,
      )
      spinner.start()

      const results = await installEngineDependencies(
        options.engine,
        packageManager,
      )

      const succeeded = results.filter((r) => r.success)
      const failed = results.filter((r) => !r.success)

      if (failed.length === 0) {
        spinner.succeed(
          `${engineConfig.displayName} dependencies installed successfully`,
        )
      } else {
        spinner.warn('Some dependencies failed to install')
        console.log()
        for (const f of failed) {
          console.log(error(`  ${f.dependency.name}: ${f.error}`))
        }

        // Show manual instructions
        console.log()
        console.log(chalk.gray('  Manual installation:'))
        const instructions = getManualInstallInstructions(
          missing[0],
          getCurrentPlatform(),
        )
        for (const instruction of instructions) {
          console.log(chalk.gray(`    ${instruction}`))
        }
      }

      if (succeeded.length > 0) {
        console.log()
        console.log(success(`Installed: ${succeeded.map((r) => r.dependency.name).join(', ')}`))
      }
    } else {
      // Default: install PostgreSQL dependencies (most common use case)
      console.log(
        chalk.gray(
          '  No engine specified, defaulting to PostgreSQL. Use --all for all engines.',
        ),
      )
      console.log()

      const missing = await getMissingDependencies('postgresql')

      if (missing.length === 0) {
        console.log(success('All PostgreSQL dependencies are installed'))
        return
      }

      console.log(`  Missing: ${missing.map((d) => d.name).join(', ')}`)
      console.log()

      const spinner = createSpinner('Installing PostgreSQL dependencies...')
      spinner.start()

      const results = await installEngineDependencies('postgresql', packageManager)

      const succeeded = results.filter((r) => r.success)
      const failed = results.filter((r) => !r.success)

      if (failed.length === 0) {
        spinner.succeed('PostgreSQL dependencies installed successfully')
      } else {
        spinner.warn('Some dependencies failed to install')
        console.log()
        for (const f of failed) {
          console.log(error(`  ${f.dependency.name}: ${f.error}`))
        }
      }

      if (succeeded.length > 0) {
        console.log()
        console.log(success(`Installed: ${succeeded.map((r) => r.dependency.name).join(', ')}`))
      }
    }
  })

// =============================================================================
// deps list
// =============================================================================

depsCommand
  .command('list')
  .description('List all supported dependencies')
  .action(async () => {
    console.log(header('Supported Dependencies'))
    console.log()

    for (const engineConfig of engineDependencies) {
      console.log(chalk.bold(`${engineConfig.displayName}:`))

      for (const dep of engineConfig.dependencies) {
        console.log(`  ${chalk.cyan(dep.name)} - ${dep.description}`)
      }
      console.log()
    }

    console.log(chalk.gray('Use: spindb deps check'))
    console.log(chalk.gray('     spindb deps install --engine <engine>'))
    console.log(chalk.gray('     spindb deps install --all'))
  })
