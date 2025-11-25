import ora, { type Ora } from 'ora'

/**
 * Create a spinner with consistent styling
 */
export function createSpinner(text: string): Ora {
  return ora({
    text,
    color: 'cyan',
    spinner: 'dots',
  })
}

/**
 * Run an async operation with a spinner
 */
export async function withSpinner<T>(
  text: string,
  operation: (updateText: (message: string) => void) => Promise<T>,
): Promise<T> {
  const spinner = createSpinner(text)
  spinner.start()

  try {
    const result = await operation((message: string) => {
      spinner.text = message
    })
    spinner.succeed()
    return result
  } catch (err) {
    const error = err as Error
    spinner.fail(error.message)
    throw error
  }
}

/**
 * Progress tracker for multi-step operations
 */
export class ProgressTracker {
  private steps: string[]
  private currentStep: number
  private spinner: Ora | null

  constructor(steps: string[]) {
    this.steps = steps
    this.currentStep = 0
    this.spinner = null
  }

  start(): void {
    if (this.steps.length > 0) {
      this.spinner = createSpinner(this.steps[0])
      this.spinner.start()
    }
  }

  nextStep(): void {
    if (this.spinner) {
      this.spinner.succeed()
    }

    this.currentStep++

    if (this.currentStep < this.steps.length) {
      this.spinner = createSpinner(this.steps[this.currentStep])
      this.spinner.start()
    }
  }

  updateText(text: string): void {
    if (this.spinner) {
      this.spinner.text = text
    }
  }

  succeed(text?: string): void {
    if (this.spinner) {
      this.spinner.succeed(text)
    }
  }

  fail(text?: string): void {
    if (this.spinner) {
      this.spinner.fail(text)
    }
  }

  warn(text?: string): void {
    if (this.spinner) {
      this.spinner.warn(text)
    }
  }
}
