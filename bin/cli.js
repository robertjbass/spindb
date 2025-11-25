#!/usr/bin/env node

import { register } from 'tsx/esm/api'

// Explicitly set tsconfig path for proper path alias resolution
register({
  tsconfig: './tsconfig.json',
})

await import('../src/bin/cli.ts')
