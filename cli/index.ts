import { program } from 'commander'
import { createCommand } from './commands/create'
import { listCommand } from './commands/list'
import { startCommand } from './commands/start'
import { stopCommand } from './commands/stop'
import { deleteCommand } from './commands/delete'
import { restoreCommand } from './commands/restore'
import { connectCommand } from './commands/connect'
import { cloneCommand } from './commands/clone'
import { menuCommand } from './commands/menu'
import { configCommand } from './commands/config'
import { depsCommand } from './commands/deps'
import { enginesCommand } from './commands/engines'
import { editCommand } from './commands/edit'
import { urlCommand } from './commands/url'
import { infoCommand } from './commands/info'

export async function run(): Promise<void> {
  program
    .name('spindb')
    .description('Spin up local database containers without Docker')
    .version('0.1.0', '-v, --version', 'output the version number')

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
  program.addCommand(depsCommand)
  program.addCommand(enginesCommand)
  program.addCommand(editCommand)
  program.addCommand(urlCommand)
  program.addCommand(infoCommand)

  // If no arguments provided, show interactive menu
  if (process.argv.length <= 2) {
    const { menuCommand: menu } = await import('./commands/menu')
    await menu.parseAsync([])
    return
  }

  program.parse()
}
