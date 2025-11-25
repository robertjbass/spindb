import { program } from 'commander'
import { createCommand } from '@/cli/commands/create'
import { listCommand } from '@/cli/commands/list'
import { startCommand } from '@/cli/commands/start'
import { stopCommand } from '@/cli/commands/stop'
import { deleteCommand } from '@/cli/commands/delete'
import { restoreCommand } from '@/cli/commands/restore'
import { connectCommand } from '@/cli/commands/connect'
import { cloneCommand } from '@/cli/commands/clone'
import { menuCommand } from '@/cli/commands/menu'
import { configCommand } from '@/cli/commands/config'

export async function run(): Promise<void> {
  program
    .name('spindb')
    .description('Spin up local database containers without Docker')
    .version('0.1.0')

  program.addCommand(createCommand)
  program.addCommand(listCommand)
  program.addCommand(startCommand)
  program.addCommand(stopCommand)
  program.addCommand(deleteCommand)
  program.addCommand(restoreCommand)
  program.addCommand(connectCommand)
  program.addCommand(cloneCommand)
  program.addCommand(menuCommand)
  program.addCommand(configCommand)

  // If no arguments provided, show interactive menu
  if (process.argv.length <= 2) {
    const { menuCommand: menu } = await import('@/cli/commands/menu')
    await menu.parseAsync([])
    return
  }

  program.parse()
}
