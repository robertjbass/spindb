#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Path to the main TypeScript entry point
const mainScript = join(__dirname, '..', 'cli', 'bin.ts')

// Use tsx to execute the TypeScript file
const tsxPath = join(__dirname, '..', 'node_modules', '.bin', 'tsx')

// Spawn tsx process with the main script and pass through all arguments
const child = spawn(tsxPath, [mainScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
})

// Forward exit code
child.on('exit', (code) => {
  process.exit(code ?? 0)
})

// Handle errors
child.on('error', (err) => {
  console.error('Failed to start spindb:', err.message)
  process.exit(1)
})
