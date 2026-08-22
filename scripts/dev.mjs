#!/usr/bin/env node
/**
 * One command for local development: API, worker, and the Vite dev server,
 * with a shared log stream so a render failure shows up next to the request
 * that caused it.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageBin } from './lib/package-bin.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
const tsx = packageBin('tsx')
const vite = packageBin('vite')

const services = [
  { name: 'api   ', color: '[36m', cmd: node, args: [tsx, 'watch', 'apps/api/src/main.ts'], cwd: root },
  { name: 'worker', color: '[35m', cmd: node, args: [tsx, 'watch', 'apps/worker/src/main.ts'], cwd: root },
  { name: 'web   ', color: '[33m', cmd: node, args: [vite], cwd: join(root, 'apps/web') },
]

const children = services.map((service) => {
  const child = spawn(service.cmd, service.args, { cwd: service.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = `${service.color}[${service.name}][0m `
  const pipe = (stream, target) => {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) target.write(prefix + line + '\n')
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    process.stderr.write(`${prefix}exited with code ${code}\n`)
  })
  return child
})

const shutdown = () => {
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.stdout.write(`
MASTERCLIP OS — development

  web    http://127.0.0.1:${process.env.WEB_PORT ?? 4311}
  api    http://127.0.0.1:${process.env.API_PORT ?? 4310}

  mode   ${process.env.MASTERCLIP_MODE ?? 'sandbox'} (renders use the local ffmpeg mock; nothing is billable)

`)
