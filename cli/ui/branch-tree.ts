import chalk from 'chalk'
import { theme } from './theme'
import type { BranchNode } from '../../core/branch-manager'

/**
 * Render a branch lineage forest as an indented tree (├─ / └─ connectors).
 * Roots have no connector. Pass `highlight` to mark the current container with
 * an arrow. Shared by `spindb branch list` and the interactive Branches view.
 */
export function renderBranchTree(
  nodes: BranchNode[],
  options: { prefix?: string; highlight?: string } = {},
): void {
  const prefix = options.prefix ?? ''
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1
    const connector = prefix === '' ? '' : isLast ? '└─ ' : '├─ '
    const statusBadge =
      node.status === 'running'
        ? theme.running
        : node.status === 'created'
          ? theme.created
          : theme.stopped
    const portStr = node.port ? chalk.gray(` :${node.port}`) : ''
    const gitTag = node.gitBranch ? chalk.magenta(`  ⎇ ${node.gitBranch}`) : ''
    const nameStr =
      node.name === options.highlight
        ? chalk.cyan.bold(`${node.name} ◀`)
        : chalk.cyan(node.name)
    console.log(
      `${prefix}${connector}${nameStr} ${chalk.gray(
        node.engine,
      )}${portStr}  ${statusBadge}${gitTag}`,
    )
    renderBranchTree(node.children, {
      prefix: prefix === '' ? '  ' : prefix + (isLast ? '   ' : '│  '),
      highlight: options.highlight,
    })
  })
}
