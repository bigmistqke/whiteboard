#!/usr/bin/env node
// The `whiteboard` command. The package is TypeScript, and Node runs TypeScript itself, except
// inside node_modules: so an installed package runs its build (dist/), and anywhere else (this
// repository, or a link to it) runs the source, so a change needs no build. This is the one file
// that has to be JavaScript, since it decides.
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const installed = fileURLToPath(import.meta.url).split(path.sep).includes('node_modules')
await import(installed ? '../dist/bin/whiteboard.js' : './whiteboard.ts')
