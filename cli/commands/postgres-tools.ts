import { Command } from 'commander'
import chalk from 'chalk'
import { header, success, warning, error } from '../ui/theme'
import {
  detectPackageManager,
  getBinaryInfo,
  installPostgresBinaries,
  updatePostgresBinaries,
  ensurePostgresBinary,
  getPostgresVersion,
} from '../../core/postgres-binary-manager'

export const postgresToolsCommand = new Command('postgres-tools').description(
  'Manage PostgreSQL client tools (psql, pg_restore, etc.)',
)

postgresToolsCommand
  .command('check')
  .description('Check PostgreSQL client tools status')
  .option('--dump <path>', 'Check compatibility with a specific dump file')
  .action(async (options: { dump?: string }) => {
    console.log(header('PostgreSQL Tools Status'))
    console.log()

    // Check package manager
    const packageManager = await detectPackageManager()
    if (packageManager) {
      console.log(success(`Package Manager: ${packageManager.name}`))
    } else {
      console.log(warning('Package Manager: Not found'))
    }
    console.log()

    // Check binaries
    const binaries = ['pg_restore', 'psql'] as const

    for (const binary of binaries) {
      const info = await getBinaryInfo(binary, options.dump)

      if (!info) {
        console.log(error(`${binary}: Not found`))
      } else {
        console.log(`${chalk.cyan(binary)}:`)
        console.log(`  Version: ${info.version}`)
        console.log(`  Path: ${info.path}`)
        console.log(`  Package Manager: ${info.packageManager || 'Unknown'}`)

        if (options.dump) {
          console.log(
            `  Compatible: ${info.isCompatible ? chalk.green('Yes') : chalk.red('No')}`,
          )
          if (info.requiredVersion) {
            console.log(`  Required Version: ${info.requiredVersion}+`)
          }
        } else {
          console.log(`  Status: ${chalk.green('Available')}`)
        }
      }
      console.log()
    }

    if (options.dump) {
      const binaryCheck = await ensurePostgresBinary(
        'pg_restore',
        options.dump,
        {
          autoInstall: false,
          autoUpdate: false,
        },
      )

      if (!binaryCheck.success) {
        console.log(warning('Compatibility Issues Detected:'))
        if (binaryCheck.action === 'install_required') {
          console.log(error('  pg_restore is not installed'))
        } else if (binaryCheck.action === 'update_required') {
          console.log(
            error('  pg_restore version is incompatible with the dump file'),
          )
        }
        console.log()
        console.log(chalk.gray('Run: spindb postgres-tools install --auto-fix'))
        console.log(chalk.gray('Or: spindb postgres-tools update --auto-fix'))
      } else {
        console.log(success('All tools are compatible with the dump file'))
      }
    }
  })

postgresToolsCommand
  .command('install')
  .description('Install PostgreSQL client tools')
  .option('--auto-fix', 'Install and automatically fix compatibility issues')
  .action(async (options: { autoFix?: boolean }) => {
    console.log(header('Installing PostgreSQL Client Tools'))
    console.log()

    const installSuccess = await installPostgresBinaries()

    if (installSuccess) {
      console.log()
      console.log(success('Installation completed successfully'))

      if (options.autoFix) {
        console.log()
        console.log(chalk.gray('Verifying installation...'))

        const pgRestoreCheck = await ensurePostgresBinary('pg_restore')
        const psqlCheck = await ensurePostgresBinary('psql')

        if (pgRestoreCheck.success && psqlCheck.success) {
          console.log(success('All tools are working correctly'))
        } else {
          console.log(warning('Some tools may need additional configuration'))
        }
      }
    }
  })

postgresToolsCommand
  .command('update')
  .description('Update PostgreSQL client tools')
  .option('--auto-fix', 'Update and automatically fix compatibility issues')
  .action(async (options: { autoFix?: boolean }) => {
    console.log(header('Updating PostgreSQL Client Tools'))
    console.log()

    const updateSuccess = await updatePostgresBinaries()

    if (updateSuccess) {
      console.log()
      console.log(success('Update completed successfully'))

      if (options.autoFix) {
        console.log()
        console.log(chalk.gray('Verifying update...'))

        const pgRestoreVersion = await getPostgresVersion('pg_restore')
        const psqlVersion = await getPostgresVersion('psql')

        if (pgRestoreVersion && psqlVersion) {
          console.log(success(`pg_restore: ${pgRestoreVersion}`))
          console.log(success(`psql: ${psqlVersion}`))
        } else {
          console.log(warning('Could not verify versions'))
        }
      }
    }
  })

postgresToolsCommand
  .command('fix')
  .description('Fix compatibility issues with a dump file')
  .argument('<dump-path>', 'Path to the dump file')
  .action(async (dumpPath: string) => {
    console.log(header('Fixing Compatibility Issues'))
    console.log()
    console.log(chalk.gray(`Dump file: ${dumpPath}`))
    console.log()

    const binaryCheck = await ensurePostgresBinary('pg_restore', dumpPath, {
      autoInstall: true,
      autoUpdate: true,
    })

    if (!binaryCheck.success) {
      console.log(error('Failed to fix compatibility issues automatically'))
      console.log()

      if (
        binaryCheck.action === 'install_required' ||
        binaryCheck.action === 'install_failed'
      ) {
        console.log(warning('Manual installation required:'))
        console.log(
          chalk.gray('  macOS: brew install libpq && brew link --force libpq'),
        )
        console.log(
          chalk.gray('  Ubuntu/Debian: sudo apt install postgresql-client'),
        )
        console.log(
          chalk.gray('  CentOS/RHEL/Fedora: sudo yum install postgresql'),
        )
      } else if (
        binaryCheck.action === 'update_required' ||
        binaryCheck.action === 'update_failed'
      ) {
        console.log(warning('Manual update required:'))
        console.log(
          chalk.gray('  macOS: brew upgrade libpq && brew link --force libpq'),
        )
        console.log(
          chalk.gray(
            '  Ubuntu/Debian: sudo apt update && sudo apt upgrade postgresql-client',
          ),
        )
        console.log(
          chalk.gray('  CentOS/RHEL/Fedora: sudo yum update postgresql'),
        )
      }

      process.exit(1)
    }

    console.log(success('Compatibility issues fixed successfully'))

    if (binaryCheck.info) {
      console.log()
      console.log(chalk.gray('Current status:'))
      console.log(`  pg_restore version: ${binaryCheck.info.version}`)
      console.log(`  Path: ${binaryCheck.info.path}`)
      if (binaryCheck.info.requiredVersion) {
        console.log(`  Required version: ${binaryCheck.info.requiredVersion}+`)
      }
    }
  })
