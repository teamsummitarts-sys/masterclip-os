import { resolve } from 'node:path'
import { createRuntime } from '@masterclip/runtime'
import { applyEnvFile, loadConfig } from '@masterclip/shared'
import { buildServer } from './server.js'

async function main(): Promise<void> {
  applyEnvFile()
  const config = loadConfig()
  const runtime = await createRuntime()
  const webRoot = process.env.WEB_ROOT ?? resolve(process.cwd(), 'apps/web/dist')

  const app = await buildServer({ runtime, webRoot })
  await app.listen({ host: config.API_HOST, port: config.API_PORT })

  runtime.logger.info('api.started', {
    url: `http://${config.API_HOST}:${config.API_PORT}`,
    mode: config.MASTERCLIP_MODE,
    live_spend_cap_usd: config.LIVE_SPEND_CAP_USD,
    db: runtime.db.dialect,
    storage: runtime.storage.name,
    web_root: webRoot,
    agents: runtime.agents.available ? 'enabled' : 'disabled (no ANTHROPIC_API_KEY)',
  })

  const shutdown = async (signal: string) => {
    runtime.logger.info('api.stopping', { signal })
    await app.close()
    await runtime.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'api.fatal', err: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
