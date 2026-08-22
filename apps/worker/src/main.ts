import { createRuntime, RenderService, QueueWorker, QUEUES } from '@masterclip/runtime'
import { JOB_TYPES } from '@masterclip/queue'
import { applyEnvFile, loadConfig } from '@masterclip/shared'

/**
 * The render worker.
 *
 * Generation never happens inside an HTTP request: the API queues work and this
 * process performs it. Two consequences the architecture depends on — a render
 * survives the browser being closed and the API being restarted, and a worker
 * crash returns leased jobs to the pool instead of losing them.
 */
async function main(): Promise<void> {
  applyEnvFile()
  const config = loadConfig()
  const runtime = await createRuntime({ workerId: `worker-${process.pid}` })
  const render = new RenderService(runtime)
  const logger = runtime.logger.child({ component: 'worker' })

  const workers = [QUEUES.render, QUEUES.qc, QUEUES.media, QUEUES.maintenance].map((queueName) => {
    const worker = new QueueWorker(runtime.queue, {
      queueName,
      concurrency: config.WORKER_CONCURRENCY,
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      logger: logger.child({ queue: queueName }),
      clock: runtime.clock,
    })

    worker.register<{ jobId: string }>(JOB_TYPES.submitRender, async ({ jobId }) => {
      await render.submitRender(jobId)
    })

    worker.register<{ jobId: string }>(JOB_TYPES.pollRender, async ({ jobId }, ctx) => {
      await ctx.heartbeat()
      const result = await render.pollRender(jobId)
      // Deferring rather than sleeping keeps the worker slot free for other
      // renders while this one cooks on the provider's side.
      if (!result.done) ctx.defer(result.deferMs)
    })

    worker.register<{ jobId: string }>(JOB_TYPES.ingestOutput, async ({ jobId }, ctx) => {
      await ctx.heartbeat()
      const outputs = await render.ingestOutputs(jobId)
      ctx.logger.info('worker.ingested', { job_id: jobId, outputs: outputs.length })
    })

    worker.register<{ outputId: string }>(JOB_TYPES.runTechnicalQc, async ({ outputId }, ctx) => {
      await ctx.heartbeat()
      const result = await render.runQc(outputId)
      ctx.logger.info('worker.qc', { output_id: outputId, action: result.action, technical_pass: result.technicalPass })
    })

    worker.register<{ outputId: string }>(JOB_TYPES.buildProxies, async ({ outputId }, ctx) => {
      await ctx.heartbeat()
      await render.buildDerivatives(outputId)
    })

    worker.register(JOB_TYPES.providerHealth, async () => {
      const health = await runtime.registry.health()
      for (const entry of health) {
        await runtime.db.run(
          `INSERT INTO provider_health (provider_id, status, latency_ms, message, consecutive_failures, checked_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider_id) DO UPDATE SET
             status = excluded.status, latency_ms = excluded.latency_ms, message = excluded.message,
             checked_at = excluded.checked_at,
             consecutive_failures = CASE WHEN excluded.status = 'healthy' THEN 0 ELSE provider_health.consecutive_failures + 1 END`,
          [entry.providerId, entry.status, entry.latencyMs, entry.message, 0, entry.checkedAt],
        )
      }
    })

    worker.register<{ projectId: string }>(JOB_TYPES.recomputeStats, async ({ projectId }) => {
      await runtime.metrics.recomputeModelPerformance(projectId)
    })

    worker.register(JOB_TYPES.refreshCatalog, async () => {
      await runtime.registry.models({ refresh: true })
    })

    return worker
  })

  for (const worker of workers) worker.start()
  logger.info('worker.started', {
    queues: [QUEUES.render, QUEUES.qc, QUEUES.media, QUEUES.maintenance],
    concurrency: config.WORKER_CONCURRENCY,
    mode: config.MASTERCLIP_MODE,
    providers: runtime.registry.list().map((p) => `${p.providerId}${p.isConfigured() ? '' : ' (unconfigured)'}`),
  })

  const shutdown = async (signal: string) => {
    logger.info('worker.stopping', { signal })
    await Promise.all(workers.map((w) => w.stop()))
    await runtime.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'worker.fatal', err: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
