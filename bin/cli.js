#!/usr/bin/env node

import { register } from 'tsx/esm/api'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// Get the directory where this script is located
const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolve tsconfig path - it should be in the package root
register({
  tsconfig: resolve(__dirname, '../tsconfig.json'),
})

await import('../src/bin/cli.ts')
