import chalk from 'chalk'
import type inquirer from 'inquirer'
import { escapeablePrompt } from '../../ui/prompts'

// Menu choice type for inquirer list prompts
export type MenuChoice =
  | {
      name: string
      value: string
      disabled?: boolean | string
    }
  | inquirer.Separator

// Helper to pause and wait for user to press Enter
export async function pressEnterToContinue(): Promise<void> {
  await escapeablePrompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to continue...'),
    },
  ])
}
