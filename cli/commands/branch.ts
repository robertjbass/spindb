import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { branchManager } from '../../core/branch-manager'
import { isRemoteContainer } from '../../types'
import { renderBranchTree } from '../ui/branch-tree'
import {
  promptContainerSelect,
  promptContainerName,
  promptConfirm,
} from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import {
  connectionBox,
  header,
  keyValue,
  uiWarning,
  uiSuccess,
} from '../ui/theme'
import { exitWithError } from '../../core/error-handler'
import {
  initRepo,
  sync as gitSync,
  prune as gitPrune,
  status as gitStatus,
  installHooks,
  uninstallHooks,
  findRepoRoot,
} from '../../core/git-branch-sync'

export const branchCommand = new Command('branch').description(
  'Branch a database — an instant copy-on-write fork (Neon/Vercel-style)',
)

// ---- branch create (default) ----
branchCommand
  .command('create [source] [name]', { isDefault: true })
  .description(
    'Create a branch of a container (auto stop/snapshot/restart of a running source)',
  )
  .option('-j, --json', 'Output result as JSON')
  .option('--no-start', "Don't start the branch after creating it")
  .option('-p, --port <port>', 'Run the branch on a specific port')
  .option(
    '--path <path>',
    'File-based engines (SQLite/DuckDB) only: write the branch file to this path instead of the default container dir',
  )
  .action(
    async (
      source: string | undefined,
      name: string | undefined,
      options: {
        json?: boolean
        start?: boolean
        port?: string
        path?: string
      },
    ) => {
      try {
        let sourceName = source
        if (!sourceName) {
          if (options.json) {
            return exitWithError({
              message: 'Source container name is required',
              json: true,
            })
          }
          const containers = await containerManager.list()
          if (containers.length === 0) {
            console.log(
              uiWarning('No containers found. Create one with: spindb create'),
            )
            return
          }
          // Branching can stop+restart a running source, so all local
          // containers are eligible (remote/linked are not).
          const branchable = containers.filter((c) => !isRemoteContainer(c))
          const selected = await promptContainerSelect(
            branchable,
            'Select container to branch:',
          )
          if (!selected) return
          sourceName = selected
        }

        const sourceConfig = await containerManager.getConfig(sourceName)
        if (!sourceConfig) {
          return exitWithError({
            message: `Container "${sourceName}" not found`,
            json: options.json,
          })
        }
        if (isRemoteContainer(sourceConfig)) {
          return exitWithError({
            message:
              'Cannot branch a linked remote container. Use "spindb backup" to export data, then "spindb restore" to import it locally.',
            json: options.json,
          })
        }

        let branchName = name
        if (!branchName) {
          if (options.json) {
            return exitWithError({
              message: 'Branch name is required',
              json: true,
            })
          }
          const picked = await promptContainerName(`${sourceName}-branch`)
          if (!picked) return
          branchName = picked
        }

        let port: number | undefined
        if (options.port !== undefined) {
          port = parseInt(options.port, 10)
          if (Number.isNaN(port) || port <= 0) {
            return exitWithError({
              message: `Invalid port: ${options.port}`,
              json: options.json,
            })
          }
        }

        const spinner = options.json
          ? null
          : createSpinner(`Branching ${sourceName} → ${branchName}...`)
        spinner?.start()

        const result = await branchManager.createBranch({
          source: sourceName,
          name: branchName,
          start: options.start !== false,
          port,
          ...(options.path ? { path: options.path } : {}),
        })

        const methodNote = result.method === 'reflink' ? ' (copy-on-write)' : ''
        spinner?.succeed(
          `Created branch "${branchName}" from "${sourceName}"${methodNote}`,
        )

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              source: sourceName,
              name: branchName,
              engine: result.config.engine,
              port: result.config.port,
              started: result.started,
              method: result.method,
              branchParent: result.config.branchParent,
              connectionString: result.connectionString,
              ...(result.warning ? { warning: result.warning } : {}),
            }),
          )
        } else {
          if (result.warning) console.log(uiWarning(result.warning))
          console.log()
          console.log(
            connectionBox(
              branchName,
              result.connectionString,
              result.config.port,
            ),
          )
          console.log()
          if (!result.started) {
            console.log(chalk.gray('  Start the branch:'))
            console.log(chalk.cyan(`  spindb start ${branchName}`))
            console.log()
          }
        }
      } catch (error) {
        return exitWithError({
          message: (error as Error).message,
          json: options.json,
        })
      }
    },
  )

// ---- branch list ----
branchCommand
  .command('list')
  .description('Show the branch lineage tree')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const tree = await branchManager.getBranchTree()
      if (options.json) {
        console.log(JSON.stringify(tree, null, 2))
        return
      }
      if (tree.length === 0) {
        console.log(
          uiWarning('No containers found. Create one with: spindb create'),
        )
        return
      }
      console.log()
      console.log(header('Branch tree'))
      renderBranchTree(tree)
      console.log()
    } catch (error) {
      return exitWithError({
        message: (error as Error).message,
        json: options.json,
      })
    }
  })

// ---- branch delete ----
branchCommand
  .command('delete <name>')
  .description(
    'Delete a branch (use --cascade to also delete its child branches)',
  )
  .option('--cascade', 'Also delete all child branches')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (
      name: string,
      options: { cascade?: boolean; force?: boolean; json?: boolean },
    ) => {
      try {
        const config = await containerManager.getConfig(name)
        if (!config) {
          return exitWithError({
            message: `Container "${name}" not found`,
            json: options.json,
          })
        }

        if (!options.json && !options.force) {
          const children = await branchManager.childrenOf(name)
          const message =
            children.length > 0 && options.cascade
              ? `Delete branch "${name}" and its ${children.length} child branch(es)?`
              : `Delete branch "${name}"?`
          const confirmed = await promptConfirm(message, false)
          if (!confirmed) {
            console.log(chalk.gray('Cancelled'))
            return
          }
        }

        const spinner = options.json
          ? null
          : createSpinner(`Deleting ${name}...`)
        spinner?.start()
        const result = await branchManager.deleteBranch(name, {
          cascade: options.cascade,
        })
        spinner?.succeed(
          result.deleted.length === 1
            ? `Deleted "${name}"`
            : `Deleted ${result.deleted.length} branches`,
        )

        if (options.json) {
          console.log(
            JSON.stringify({ success: true, deleted: result.deleted }),
          )
        }
      } catch (error) {
        return exitWithError({
          message: (error as Error).message,
          json: options.json,
        })
      }
    },
  )

// ---- branch reset ----
branchCommand
  .command('reset <name>')
  .description(
    "Discard a branch's changes and re-fork from its parent's current state",
  )
  .option('-f, --force', 'Skip confirmation prompt')
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (name: string, options: { force?: boolean; json?: boolean }) => {
      try {
        const config = await containerManager.getConfig(name)
        if (!config) {
          return exitWithError({
            message: `Container "${name}" not found`,
            json: options.json,
          })
        }
        if (!config.branchParent) {
          return exitWithError({
            message: `"${name}" is not a branch (no parent to reset from).`,
            json: options.json,
          })
        }

        if (!options.json && !options.force) {
          const confirmed = await promptConfirm(
            `Reset branch "${name}" to match "${config.branchParent}"? This discards all changes in the branch.`,
            false,
          )
          if (!confirmed) {
            console.log(chalk.gray('Cancelled'))
            return
          }
        }

        const spinner = options.json
          ? null
          : createSpinner(`Resetting ${name}...`)
        spinner?.start()
        const result = await branchManager.resetBranch(name)
        spinner?.succeed(`Reset "${name}" to "${config.branchParent}"`)

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              name,
              branchParent: result.config.branchParent,
              method: result.method,
              started: result.started,
              connectionString: result.connectionString,
              ...(result.warning ? { warning: result.warning } : {}),
            }),
          )
        } else if (result.warning) {
          console.log(uiWarning(result.warning))
        }
      } catch (error) {
        return exitWithError({
          message: (error as Error).message,
          json: options.json,
        })
      }
    },
  )

// ---- branch rename ----
branchCommand
  .command('rename <oldName> <newName>')
  .description('Rename a branch (repoints its children to the new name)')
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (oldName: string, newName: string, options: { json?: boolean }) => {
      try {
        const spinner = options.json
          ? null
          : createSpinner(`Renaming ${oldName} → ${newName}...`)
        spinner?.start()
        const config = await branchManager.renameBranch(oldName, newName)
        spinner?.succeed(`Renamed "${oldName}" to "${newName}"`)
        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              oldName,
              newName,
              engine: config.engine,
            }),
          )
        }
      } catch (error) {
        return exitWithError({
          message: (error as Error).message,
          json: options.json,
        })
      }
    },
  )

// ---- branch info ----
branchCommand
  .command('info <name>')
  .description("Show a branch's lineage (parent and children)")
  .option('-j, --json', 'Output as JSON')
  .action(async (name: string, options: { json?: boolean }) => {
    try {
      const info = await branchManager.getBranchInfo(name)
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              name: info.config.name,
              engine: info.config.engine,
              port: info.config.port,
              status: info.config.status,
              branchParent: info.parent,
              branchedAt: info.config.branchedAt,
              gitBranch: info.config.gitBranch,
              children: info.children,
            },
            null,
            2,
          ),
        )
        return
      }
      console.log()
      console.log(header(`Branch: ${name}`))
      console.log(keyValue('Engine', info.config.engine))
      if (info.parent) console.log(keyValue('Branched from', info.parent))
      if (info.config.branchedAt) {
        console.log(keyValue('Branched at', info.config.branchedAt))
      }
      if (info.config.gitBranch) {
        console.log(keyValue('Git branch', info.config.gitBranch))
      }
      console.log(
        keyValue(
          'Children',
          info.children.length > 0 ? info.children.join(', ') : '(none)',
        ),
      )
      console.log()
    } catch (error) {
      return exitWithError({
        message: (error as Error).message,
        json: options.json,
      })
    }
  })

/**
 * Render the branch forest as an indented tree. Roots have no glyph; children
 * are drawn with ├─ / └─ connectors.
 */
// ---- git-driven branching ----

branchCommand
  .command('init [base]')
  .description(
    'Set up git-driven branching for this repo (writes .spindb/branch.json + installs a post-checkout hook)',
  )
  .option('-j, --json', 'Output result as JSON')
  .action(async (base: string | undefined, options: { json?: boolean }) => {
    try {
      let baseContainer = base
      if (!baseContainer) {
        if (options.json) {
          return exitWithError({
            message: 'Base container name is required',
            json: true,
          })
        }
        const containers = await containerManager.list()
        const eligible = containers.filter(
          (c) => !isRemoteContainer(c) && c.status !== 'linked' && c.port > 0,
        )
        if (eligible.length === 0) {
          console.log(
            uiWarning(
              'No server-based containers found. Create one with: spindb create',
            ),
          )
          return
        }
        const selected = await promptContainerSelect(
          eligible,
          'Select the base container for this repo:',
        )
        if (!selected) return
        baseContainer = selected
      }

      const { repoRoot, config } = await initRepo({ baseContainer })
      if (options.json) {
        console.log(
          JSON.stringify({
            success: true,
            repoRoot,
            baseContainer: config.baseContainer,
            stablePort: config.stablePort,
            mainBranch: config.mainBranch,
            hooksInstalled: true,
          }),
        )
      } else {
        console.log(uiSuccess('Git branching enabled for this repo'))
        console.log(
          chalk.gray('  Base container: ') + chalk.cyan(config.baseContainer),
        )
        console.log(
          chalk.gray('  Stable port:    ') +
            chalk.green(String(config.stablePort)) +
            chalk.gray('  (your DATABASE_URL never changes)'),
        )
        console.log(
          chalk.gray('  Main branch:    ') + chalk.cyan(config.mainBranch),
        )
        console.log()
        console.log(
          chalk.gray(
            '  Switch git branches and the matching database follows automatically.',
          ),
        )
        console.log(
          chalk.gray('  Tip: commit .spindb/branch.json to share it; ') +
            chalk.gray('teammates run ') +
            chalk.cyan('spindb branch hooks install'),
        )
      }
    } catch (error) {
      return exitWithError({
        message: (error as Error).message,
        json: options.json,
      })
    }
  })

branchCommand
  .command('sync')
  .description(
    'Swap the active database branch to match the current git branch',
  )
  .option('--git-checkout', 'Invoked from the post-checkout hook (quieter)')
  .option('-j, --json', 'Output result as JSON')
  .action(async (options: { gitCheckout?: boolean; json?: boolean }) => {
    try {
      const result = await gitSync({ fromHook: options.gitCheckout })
      if (options.json) {
        console.log(JSON.stringify({ success: true, ...result }))
      } else if (!options.gitCheckout) {
        const what = result.isBase
          ? `base "${result.container}"`
          : `branch "${result.container}"`
        console.log(
          uiSuccess(
            `Active database is now ${what}${result.created ? ' (created)' : ''}`,
          ),
        )
        console.log(chalk.gray('  ') + chalk.cyan(result.connectionString))
      }
    } catch (error) {
      return exitWithError({
        message: (error as Error).message,
        json: options.json,
      })
    }
  })

branchCommand
  .command('status')
  .description('Show git-branching config and the active database branch')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const st = await gitStatus({})
      if (!st) {
        if (options.json) {
          console.log(JSON.stringify({ configured: false }))
          return
        }
        console.log(
          uiWarning(
            'Git branching is not set up here. Run: spindb branch init --base <container>',
          ),
        )
        return
      }
      if (options.json) {
        console.log(JSON.stringify({ configured: true, ...st }))
        return
      }
      console.log()
      console.log(header('Git branching'))
      console.log(keyValue('Base', st.config.baseContainer))
      console.log(keyValue('Stable port', String(st.config.stablePort)))
      console.log(keyValue('Main branch', st.config.mainBranch))
      console.log(keyValue('Current branch', st.gitBranch))
      console.log(keyValue('Maps to', st.target))
      console.log(keyValue('Active now', st.active ?? '(none running)'))
      console.log(keyValue('Hook installed', st.hooksInstalled ? 'yes' : 'no'))
      console.log()
    } catch (error) {
      return exitWithError({
        message: (error as Error).message,
        json: options.json,
      })
    }
  })

branchCommand
  .command('prune')
  .description('Delete database branches whose git branch no longer exists')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const spinner = options.json
        ? null
        : createSpinner('Pruning orphaned branches...')
      spinner?.start()
      const { deleted } = await gitPrune({})
      spinner?.succeed(
        deleted.length > 0
          ? `Pruned ${deleted.length} branch(es)`
          : 'Nothing to prune',
      )
      if (options.json) {
        console.log(JSON.stringify({ success: true, deleted }))
      } else {
        for (const name of deleted) {
          console.log(chalk.gray('  removed ') + name)
        }
      }
    } catch (error) {
      return exitWithError({
        message: (error as Error).message,
        json: options.json,
      })
    }
  })

branchCommand
  .command('hooks <action>')
  .description(
    'Install or uninstall the git post-checkout hook (action: install | uninstall)',
  )
  .option('-j, --json', 'Output as JSON')
  .action(async (action: string, options: { json?: boolean }) => {
    try {
      if (action !== 'install' && action !== 'uninstall') {
        return exitWithError({
          message: `Unknown action "${action}". Use "install" or "uninstall".`,
          json: options.json,
        })
      }
      const repoRoot = await findRepoRoot()
      if (!repoRoot) {
        return exitWithError({
          message: 'Not a git repository.',
          json: options.json,
        })
      }
      if (action === 'install') {
        await installHooks(repoRoot)
      } else {
        await uninstallHooks(repoRoot)
      }
      if (options.json) {
        console.log(JSON.stringify({ success: true, action }))
      } else {
        console.log(
          uiSuccess(
            `post-checkout hook ${action === 'install' ? 'installed' : 'removed'}`,
          ),
        )
      }
    } catch (error) {
      return exitWithError({
        message: (error as Error).message,
        json: options.json,
      })
    }
  })
