#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { applyEnvFile, formatUsd, loadConfig, maskSecret } from '@masterclip/shared'
import { migrationStatus } from '@masterclip/database'
import { checkTools } from '@masterclip/media-tools'
import { contractSummary, runProviderContract, type CanonicalRenderRequest, type PriceQuote } from '@masterclip/provider-core'
import { importCsv, importJson, shotJsonSchema, validateShot, csvTemplate, exportCsv } from '@masterclip/shot-schema'
import { createRuntime, MasterService, RenderService, type Runtime } from '@masterclip/runtime'

/**
 * `masterclip` — the operational CLI.
 *
 * Every command supports `--json` for machine consumption and returns a
 * meaningful exit code: 0 success, 1 failure, 2 usage error, 3 a check that ran
 * but reported problems (used by `doctor`, so CI can distinguish "broken" from
 * "unconfigured").
 */
const EXIT = { ok: 0, error: 1, usage: 2, checkFailed: 3 } as const

interface Ctx {
  json: boolean
  args: string[]
  flags: Record<string, string | boolean>
}

async function main(): Promise<number> {
  applyEnvFile()
  const argv = process.argv.slice(2)
  const flags: Record<string, string | boolean> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=')
      if (inline !== undefined) flags[key as string] = inline
      else if (argv[i + 1] && !argv[i + 1]?.startsWith('--')) flags[key as string] = argv[++i] as string
      else flags[key as string] = true
    } else args.push(token)
  }

  const ctx: Ctx = { json: flags.json === true || flags.json === 'true', args, flags }
  const command = args.join(' ')

  if (args.length === 0 || flags.help) {
    printHelp()
    return args.length === 0 ? EXIT.usage : EXIT.ok
  }

  try {
    if (command === 'init') return await cmdInit(ctx)
    if (command === 'doctor') return await cmdDoctor(ctx)
    if (command === 'providers list') return await withRuntime(ctx, cmdProvidersList)
    if (command === 'providers health') return await withRuntime(ctx, cmdProvidersHealth)
    if (command === 'providers contract') return await withRuntime(ctx, cmdProvidersContract)
    if (command === 'models refresh') return await withRuntime(ctx, cmdModelsRefresh)
    if (command === 'project create') return await withRuntime(ctx, cmdProjectCreate)
    if (command === 'project list') return await withRuntime(ctx, cmdProjectList)
    if (command === 'shots import') return await withRuntime(ctx, cmdShotsImport)
    if (command === 'shots validate') return await cmdShotsValidate(ctx)
    if (command === 'shots schema') return await cmdShotsSchema(ctx)
    if (command === 'shots template') return await cmdShotsTemplate(ctx)
    if (command === 'render quote') return await withRuntime(ctx, cmdRenderQuote)
    if (command === 'render submit') return await withRuntime(ctx, cmdRenderSubmit)
    if (command === 'queue status') return await withRuntime(ctx, cmdQueueStatus)
    if (command === 'queue retry') return await withRuntime(ctx, cmdQueueRetry)
    if (command === 'queue work') return await withRuntime(ctx, cmdQueueWork)
    if (command === 'qc run') return await withRuntime(ctx, cmdQcRun)
    if (command === 'review export') return await withRuntime(ctx, cmdReviewExport)
    if (command === 'masters package') return await withRuntime(ctx, cmdMastersPackage)
    if (command === 'costs report') return await withRuntime(ctx, cmdCostsReport)

    output(ctx, { error: `unknown command: ${command}` }, () => `unknown command: ${command}\nrun "masterclip --help"`)
    return EXIT.usage
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    output(ctx, { error: message }, () => `error: ${message}`)
    return EXIT.error
  }
}

async function withRuntime(ctx: Ctx, fn: (ctx: Ctx, runtime: Runtime) => Promise<number>): Promise<number> {
  const runtime = await createRuntime()
  try {
    return await fn(ctx, runtime)
  } finally {
    await runtime.close()
  }
}

// ---------------------------------------------------------------- commands ---

async function cmdInit(ctx: Ctx): Promise<number> {
  const created: string[] = []
  for (const dir of ['var', 'var/storage', 'var/mock-provider', 'fixtures']) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
      created.push(dir)
    }
  }
  if (!existsSync('.env') && existsSync('.env.example')) {
    await writeFile('.env', await readFile('.env.example', 'utf8'))
    created.push('.env')
  }
  const runtime = await createRuntime()
  const migrations = await migrationStatus(runtime.db)
  await runtime.close()

  output(ctx, { created, migrations }, () =>
    [
      created.length > 0 ? `created: ${created.join(', ')}` : 'nothing to create — already initialised',
      `migrations: ${migrations.filter((m) => m.applied).length}/${migrations.length} applied`,
      '',
      'next: pnpm dev   (API + worker + web)',
    ].join('\n'),
  )
  return EXIT.ok
}

/**
 * Preflight for everything the app needs. Reports each dependency separately so
 * "ffmpeg missing" is never mistaken for "the database is down".
 */
async function cmdDoctor(ctx: Ctx): Promise<number> {
  const config = loadConfig()
  const checks: Array<{ name: string; ok: boolean; detail: string; required: boolean }> = []

  const tools = await checkTools()
  checks.push({ name: 'ffmpeg', ok: tools.ffmpeg.available, detail: tools.ffmpeg.version || 'not found', required: true })
  checks.push({ name: 'ffprobe', ok: tools.ffprobe.available, detail: tools.ffprobe.version || 'not found', required: true })

  let runtime: Runtime | null = null
  try {
    runtime = await createRuntime()
    const migrations = await migrationStatus(runtime.db)
    checks.push({
      name: 'database',
      ok: migrations.every((m) => m.applied),
      detail: `${runtime.db.dialect}: ${migrations.filter((m) => m.applied).length}/${migrations.length} migrations`,
      required: true,
    })

    const stats = await runtime.queue.stats()
    checks.push({ name: 'queue', ok: true, detail: `pending ${stats.pending}, active ${stats.active}, dead ${stats.dead_letter}`, required: true })

    const probeKey = `doctor/${Date.now()}.txt`
    await runtime.storage.putBuffer(probeKey, new TextEncoder().encode('masterclip doctor'))
    const roundTrip = new TextDecoder().decode(await runtime.storage.getBuffer(probeKey))
    await runtime.storage.delete(probeKey)
    checks.push({ name: 'object storage', ok: roundTrip === 'masterclip doctor', detail: runtime.storage.name, required: true })

    for (const provider of runtime.registry.list()) {
      const health = await provider.healthCheck()
      checks.push({
        name: `provider:${provider.providerId}`,
        ok: health.status === 'healthy' || health.status === 'unconfigured',
        detail: `${health.status} — ${health.message}`,
        required: false,
      })
    }

    const liveSpend = await runtime.ledger.totalLiveSpend()
    checks.push({
      name: 'live-spend allowance',
      ok: liveSpend < config.liveSpendCapMicros,
      detail: `${formatUsd(liveSpend, 4)} of ${formatUsd(config.liveSpendCapMicros, 2)} used — mode is ${config.MASTERCLIP_MODE}`,
      required: true,
    })

    checks.push({
      name: 'webhook callback URL',
      ok: Boolean(config.PUBLIC_BASE_URL && config.WEBHOOK_SECRET),
      detail: config.PUBLIC_BASE_URL
        ? `${config.PUBLIC_BASE_URL} (secret ${maskSecret(config.WEBHOOK_SECRET)})`
        : 'not set — providers will be polled instead of calling back',
      required: false,
    })

    checks.push({
      name: 'claude agent layer',
      ok: true,
      detail: runtime.agents.available ? `enabled (${config.ANTHROPIC_MODEL} / ${config.ANTHROPIC_QC_MODEL})` : 'disabled — no ANTHROPIC_API_KEY',
      required: false,
    })
  } finally {
    await runtime?.close()
  }

  const requiredFailures = checks.filter((c) => c.required && !c.ok)
  output(ctx, { checks, ok: requiredFailures.length === 0 }, () =>
    checks
      .map((c) => `${c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn'}  ${c.name.padEnd(24)} ${c.detail}`)
      .concat(['', requiredFailures.length === 0 ? 'all required checks passed' : `${requiredFailures.length} required check(s) failed`])
      .join('\n'),
  )
  return requiredFailures.length === 0 ? EXIT.ok : EXIT.checkFailed
}

async function cmdProvidersList(ctx: Ctx, runtime: Runtime): Promise<number> {
  const providers = runtime.registry.list().map((p) => ({ providerId: p.providerId, displayName: p.displayName, configured: p.isConfigured() }))
  output(ctx, { providers }, () =>
    providers.map((p) => `${p.configured ? 'ok  ' : '--  '} ${p.providerId.padEnd(12)} ${p.displayName}`).join('\n'),
  )
  return EXIT.ok
}

async function cmdProvidersHealth(ctx: Ctx, runtime: Runtime): Promise<number> {
  const health = await runtime.registry.health()
  output(ctx, { health }, () =>
    health.map((h) => `${h.status.padEnd(13)} ${h.providerId.padEnd(12)} ${h.latencyMs ?? '-'}ms  ${h.message}`).join('\n'),
  )
  return health.some((h) => h.status === 'unavailable') ? EXIT.checkFailed : EXIT.ok
}

/** Runs the shared provider contract battery. Sandbox-safe by default. */
async function cmdProvidersContract(ctx: Ctx, runtime: Runtime): Promise<number> {
  const target = String(ctx.flags.provider ?? 'mock')
  const provider = runtime.registry.get(target)
  const submitAndPoll = ctx.flags['submit'] === true || ctx.flags['submit'] === 'true'
  const confirmed = ctx.flags['yes'] === true || ctx.flags['yes'] === 'true'

  /**
   * The battery talks to the provider directly, so this is the one submit path
   * that does not run through RenderService. It gets the same three gates the
   * render path gets — mode, an exact quote the operator has seen, and the cost
   * controller — rather than a looser copy of them.
   */
  /**
   * The battery talks to the provider directly, so this is the one submit path
   * in the system that does not run through RenderService. It gets the same
   * gates the render path gets rather than a looser copy: sandbox mode, an
   * exact quote the operator has seen and confirmed, and the cost controller
   * itself — which is what enforces the global live-spend cap and writes the
   * ledger entry. A billable check therefore has to name a real project, so the
   * money it spends is attributed like any other spend.
   */
  const approveSubmit = async ({ request, quote }: { request: CanonicalRenderRequest; quote: PriceQuote }) => {
    if (target === 'mock') return { allowed: true }

    if (runtime.config.isSandbox) {
      return { allowed: false, reason: 'MASTERCLIP_MODE=sandbox — set MASTERCLIP_MODE=live to run a billable contract check' }
    }
    const projectId = ctx.flags.project ? String(ctx.flags.project) : ''
    if (!projectId) {
      return { allowed: false, reason: 'a billable contract check must name a real project: --project <projectId>, so the spend is budgeted and ledgered' }
    }
    const project = await runtime.projects.get(projectId)
    if (!project) return { allowed: false, reason: `project ${projectId} not found` }

    if (!confirmed) {
      return {
        allowed: false,
        reason:
          `this would spend about ${formatUsd(quote.estimatedMicros)} on ${target}/${request.modelId} ` +
          `(${request.durationSeconds}s ${request.resolution}, price confidence: ${quote.confidence}) — ` +
          `re-run with --yes to authorize it`,
      }
    }

    const authorization = await runtime.cost.authorize({
      orgId: project.orgId,
      projectId: project.id,
      shotId: request.shotId,
      request: { ...request, projectId: project.id },
      quote,
      tier: 'standard',
      humanApproved: true,
    })
    return authorization.allowed
      ? { allowed: true }
      : { allowed: false, reason: authorization.denials.map((d) => d.message).join('; ') }
  }

  const checks = await runProviderContract(provider, {
    submitAndPoll,
    destDir: 'var/tmp/contract',
    pollTimeoutMs: 120_000,
    approveSubmit,
    // `sampleRequest()` defaults to sandbox:true, which is right for the mock
    // and wrong for everyone else: the cost controller reads that flag to
    // decide what to enforce, so a live contract run was authorizing itself
    // past the live-spend cap, the unknown-price denial and the approval gate.
    // A real provider bills, so its request says so.
    request: target === 'mock' ? {} : { sandbox: false },
  })
  const summary = contractSummary(checks)
  output(ctx, { provider: target, checks, summary }, () =>
    checks
      .map((c) => `${c.skipped ? 'skip' : c.ok ? 'pass' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
      .concat([``, `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`])
      .join('\n'),
  )
  return summary.failed === 0 ? EXIT.ok : EXIT.checkFailed
}

async function cmdModelsRefresh(ctx: Ctx, runtime: Runtime): Promise<number> {
  const models = await runtime.registry.models({ refresh: true })
  output(ctx, { count: models.length, models: models.map((m) => ({ provider: m.providerId, model: m.modelId, tier: m.capabilities.tier, source: m.source })) }, () =>
    `${models.length} models\n` +
    models.map((m) => `${m.providerId.padEnd(12)} ${m.modelId.padEnd(46)} ${m.capabilities.tier.padEnd(9)} ${m.source}`).join('\n'),
  )
  return EXIT.ok
}

async function cmdProjectCreate(ctx: Ctx, runtime: Runtime): Promise<number> {
  const name = String(ctx.flags.name ?? '')
  const orgId = String(ctx.flags.org ?? '')
  if (!name) return usage(ctx, 'masterclip project create --name "<name>" [--org <orgId>]')
  const resolvedOrg = orgId || (await runtime.db.get<{ id: string }>('SELECT id FROM orgs ORDER BY created_at ASC LIMIT 1'))?.id
  if (!resolvedOrg) return usage(ctx, 'no organization exists yet — sign up through the web app first')

  const project = await runtime.projects.create({ orgId: String(resolvedOrg), name, createdBy: 'cli' })
  await runtime.cost.budgetStore.ensureDefaults('project', project.id)
  output(ctx, { project }, () => `created project ${project.id} (${project.name})`)
  return EXIT.ok
}

async function cmdProjectList(ctx: Ctx, runtime: Runtime): Promise<number> {
  const orgs = await runtime.db.query<{ id: string }>('SELECT id FROM orgs')
  const projects = (await Promise.all(orgs.map((org) => runtime.projects.list(String(org.id))))).flat()
  output(ctx, { projects }, () => projects.map((p) => `${p.id}  ${p.status.padEnd(9)} ${p.name}`).join('\n') || 'no projects')
  return EXIT.ok
}

async function cmdShotsImport(ctx: Ctx, runtime: Runtime): Promise<number> {
  const file = String(ctx.flags.file ?? '')
  const projectId = String(ctx.flags.project ?? '')
  if (!file || !projectId) return usage(ctx, 'masterclip shots import --project <projectId> --file <shots.csv|shots.json> [--dry-run]')

  const content = await readFile(file, 'utf8')
  const result = file.endsWith('.csv') ? importCsv(content) : importJson(content)
  const dryRun = ctx.flags['dry-run'] === true

  if (dryRun) {
    output(ctx, { dryRun: true, ...result }, () => renderImport(result, true))
    return result.errors.length > 0 ? EXIT.checkFailed : EXIT.ok
  }

  const created: string[] = []
  for (const spec of result.shots) {
    const record = await runtime.projects.createShot({ projectId, spec, createdBy: 'cli', note: 'cli import' })
    created.push(record.shot.id)
  }
  output(ctx, { created, ...result }, () => `${renderImport(result, false)}\ncreated ${created.length} shots`)
  return result.errors.length > 0 ? EXIT.checkFailed : EXIT.ok
}

function renderImport(result: ReturnType<typeof importCsv>, dryRun: boolean): string {
  const lines = [`${dryRun ? 'dry run: ' : ''}${result.shots.length} valid, ${result.errors.length} rejected`]
  for (const failure of result.errors) {
    lines.push(`  row ${failure.row} (${failure.shotId || 'unnamed'}): ${failure.issues.map((i) => i.message).join('; ')}`)
  }
  for (const warning of result.warnings) {
    lines.push(`  warn row ${warning.row}: ${warning.issues.map((i) => i.message).join('; ')}`)
  }
  return lines.join('\n')
}

async function cmdShotsValidate(ctx: Ctx): Promise<number> {
  const file = String(ctx.flags.file ?? '')
  if (!file) return usage(ctx, 'masterclip shots validate --file <shot.json|shots.csv>')
  const content = await readFile(file, 'utf8')
  const result = file.endsWith('.csv') ? importCsv(content) : importJson(content)
  const single = !file.endsWith('.csv') && result.shots.length === 0 ? validateShot(JSON.parse(content)) : null

  const issues = single ? single.issues : [...result.errors.flatMap((e) => e.issues), ...result.warnings.flatMap((w) => w.issues)]
  const ok = single ? single.ok : result.errors.length === 0
  output(ctx, { ok, issues, valid: result.shots.length }, () =>
    [`${ok ? 'valid' : 'INVALID'} — ${result.shots.length} shot(s) parsed`, ...issues.map((i) => `  ${i.severity} ${i.path}: ${i.message}`)].join('\n'),
  )
  return ok ? EXIT.ok : EXIT.checkFailed
}

async function cmdShotsSchema(ctx: Ctx): Promise<number> {
  const schema = shotJsonSchema()
  const out = String(ctx.flags.out ?? '')
  if (out) {
    await writeFile(out, JSON.stringify(schema, null, 2))
    output(ctx, { written: out }, () => `wrote ${out}`)
  } else {
    output(ctx, schema, () => JSON.stringify(schema, null, 2))
  }
  return EXIT.ok
}

async function cmdShotsTemplate(ctx: Ctx): Promise<number> {
  const out = String(ctx.flags.out ?? '')
  if (out) {
    await writeFile(out, csvTemplate())
    output(ctx, { written: out }, () => `wrote ${out}`)
  } else {
    output(ctx, { template: csvTemplate() }, () => csvTemplate())
  }
  return EXIT.ok
}

/** Prices a render without submitting it — the pre-flight for spending. */
async function cmdRenderQuote(ctx: Ctx, runtime: Runtime): Promise<number> {
  const shotId = String(ctx.flags.shot ?? '')
  const providerId = String(ctx.flags.provider ?? 'mock')
  const modelId = String(ctx.flags.model ?? '')
  if (!shotId || !modelId) return usage(ctx, 'masterclip render quote --shot <shotId> --provider <id> --model <id>')

  const shot = await runtime.projects.getShot(shotId)
  const version = await runtime.projects.currentVersion(shotId)
  const render = new RenderService(runtime)
  const plan = await render.planBatch({
    projectId: shot.projectId,
    shotId,
    batchName: 'quote-only',
    candidates: [],
    createdBy: 'cli',
    orgId: (await runtime.projects.get(shot.projectId)).orgId,
  })
  void plan

  const provider = runtime.registry.get(providerId)
  const model = await runtime.registry.findModel(providerId, modelId)
  output(
    ctx,
    { shot: shotId, provider: providerId, model: modelId, capabilities: model.capabilities, pricing: model.pricing },
    () =>
      [
        `shot ${shotId} (${version.spec.duration_seconds}s @ ${version.spec.target_resolution} ${version.spec.aspect_ratio})`,
        `${provider.displayName} / ${model.displayName} [${model.capabilities.tier}]`,
        model.pricing
          ? `rate: ${model.pricing.basis} ${formatUsd(model.pricing.rateMicros)}${model.pricing.dynamic ? ' (dynamic — live quote required)' : ''}`
          : 'no published rate — a live quote is required before submission',
        model.pricing?.notes ? `note: ${model.pricing.notes}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
  )
  return EXIT.ok
}

async function cmdRenderSubmit(ctx: Ctx, runtime: Runtime): Promise<number> {
  const shotId = String(ctx.flags.shot ?? '')
  const providerId = String(ctx.flags.provider ?? 'mock')
  const modelId = String(ctx.flags.model ?? 'mock-draft')
  const count = Number(ctx.flags.count ?? 1)
  if (!shotId) return usage(ctx, 'masterclip render submit --shot <shotId> [--provider mock] [--model mock-draft] [--count 4]')

  const shot = await runtime.projects.getShot(shotId)
  const version = await runtime.projects.currentVersion(shotId)
  const project = await runtime.projects.get(shot.projectId)
  const render = new RenderService(runtime)

  const { variationsFor } = await import('@masterclip/prompt-compiler')
  const variations = variationsFor(count)
  const result = await render.planBatch({
    projectId: shot.projectId,
    shotId,
    batchName: String(ctx.flags.name ?? 'cli batch'),
    orgId: project.orgId,
    createdBy: 'cli',
    humanApproved: ctx.flags.approve === true,
    candidates: variations.map((variation) => ({
      providerId,
      modelId,
      seed: null,
      variationLabel: variation.label,
      variationInstruction: variation.instruction,
      resolution: version.spec.target_resolution,
      aspectRatio: version.spec.aspect_ratio,
      durationSeconds: version.spec.duration_seconds,
    })),
  })

  output(ctx, result, () =>
    [
      `queued ${result.jobIds.length} render(s), estimated ${formatUsd(result.estimatedMicros)}`,
      ...result.skipped.map((s) => `  skipped ${s.candidate.providerId}/${s.candidate.modelId}: ${s.reason}`),
      ...result.warnings.map((w) => `  warn: ${w}`),
      result.jobIds.length > 0 ? 'run `masterclip queue work` or start the worker to execute them' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return result.jobIds.length > 0 ? EXIT.ok : EXIT.checkFailed
}

async function cmdQueueStatus(ctx: Ctx, runtime: Runtime): Promise<number> {
  const stats = await runtime.queue.stats()
  const jobs = await runtime.queue.list(undefined, ['pending', 'active', 'dead'], 25)
  output(ctx, { stats, jobs }, () =>
    [
      Object.entries(stats)
        .map(([key, value]) => `${key}=${value}`)
        .join('  '),
      ...jobs.map((j) => `  ${j.status.padEnd(9)} ${j.type.padEnd(22)} attempts ${j.attempts}/${j.maxAttempts}  ${j.lastError ?? ''}`),
    ].join('\n'),
  )
  return EXIT.ok
}

async function cmdQueueRetry(ctx: Ctx, runtime: Runtime): Promise<number> {
  const deadId = String(ctx.flags.id ?? '')
  if (!deadId) return usage(ctx, 'masterclip queue retry --id <deadLetterId>')
  const queued = await runtime.queue.replayDead(deadId)
  output(ctx, { queued }, () => `replayed as ${queued}`)
  return EXIT.ok
}

/** Drains the queue inline. Useful in CI and for a one-shot local run. */
async function cmdQueueWork(ctx: Ctx, runtime: Runtime): Promise<number> {
  const { QueueWorker, QUEUES } = await import('@masterclip/runtime')
  const { JOB_TYPES } = await import('@masterclip/queue')
  const render = new RenderService(runtime)
  let processed = 0

  for (const queueName of [QUEUES.render, QUEUES.qc, QUEUES.media]) {
    const worker = new QueueWorker(runtime.queue, { queueName, concurrency: 1, logger: runtime.logger })
    worker.register<{ jobId: string }>(JOB_TYPES.submitRender, async ({ jobId }) => void (await render.submitRender(jobId)))
    worker.register<{ jobId: string }>(JOB_TYPES.pollRender, async ({ jobId }, c) => {
      const result = await render.pollRender(jobId)
      if (!result.done) c.defer(result.deferMs)
    })
    worker.register<{ jobId: string }>(JOB_TYPES.ingestOutput, async ({ jobId }) => void (await render.ingestOutputs(jobId)))
    worker.register<{ outputId: string }>(JOB_TYPES.runTechnicalQc, async ({ outputId }) => void (await render.runQc(outputId)))
    worker.register<{ outputId: string }>(JOB_TYPES.buildProxies, async ({ outputId }) => void (await render.buildDerivatives(outputId)))
    processed += await worker.runOnce(Number(ctx.flags.max ?? 50))
  }

  output(ctx, { processed }, () => `processed ${processed} queue job(s)`)
  return EXIT.ok
}

async function cmdQcRun(ctx: Ctx, runtime: Runtime): Promise<number> {
  const outputId = String(ctx.flags.output ?? '')
  if (!outputId) return usage(ctx, 'masterclip qc run --output <outputId>')
  const render = new RenderService(runtime)
  const result = await render.runQc(outputId)
  output(ctx, result, () => `${result.technicalPass ? 'technical pass' : 'TECHNICAL FAIL'} → ${result.action}`)
  return result.technicalPass ? EXIT.ok : EXIT.checkFailed
}

async function cmdReviewExport(ctx: Ctx, runtime: Runtime): Promise<number> {
  const projectId = String(ctx.flags.project ?? '')
  if (!projectId) return usage(ctx, 'masterclip review export --project <projectId> [--out shots.csv]')
  const shots = await runtime.projects.listShots(projectId)
  const specs = await Promise.all(shots.map(async (shot) => (await runtime.projects.currentVersion(shot.id)).spec))
  const csv = exportCsv(specs)
  const out = String(ctx.flags.out ?? '')
  if (out) await writeFile(out, csv)
  output(ctx, { shots: specs.length, out: out || null }, () => (out ? `wrote ${specs.length} shots to ${out}` : csv))
  return EXIT.ok
}

async function cmdMastersPackage(ctx: Ctx, runtime: Runtime): Promise<number> {
  const masterId = String(ctx.flags.master ?? '')
  if (!masterId) return usage(ctx, 'masterclip masters package --master <masterId> [--out <dir>]')
  const service = new MasterService(runtime)
  const built = await service.buildPackage(masterId, ctx.flags.out ? String(ctx.flags.out) : undefined)
  output(ctx, built, () => `packaged ${built.files.length} files → ${built.directory}\nmanifest: ${built.manifestPath}`)
  return EXIT.ok
}

async function cmdCostsReport(ctx: Ctx, runtime: Runtime): Promise<number> {
  const projectId = String(ctx.flags.project ?? '')
  if (!projectId) return usage(ctx, 'masterclip costs report --project <projectId>')
  const [metrics, byProvider, avoided] = await Promise.all([
    runtime.metrics.projectMetrics(projectId),
    runtime.ledger.byProvider(projectId, { includeSandbox: true }),
    runtime.metrics.qcAvoidedSpend(projectId),
  ])

  output(ctx, { metrics, byProvider, avoided }, () =>
    [
      `spend                        ${formatUsd(metrics.rawSpendMicros)} (sandbox ${formatUsd(metrics.sandboxSpendMicros)})`,
      `submitted / valid / approved ${metrics.submittedCount} / ${metrics.technicallyValidCount} / ${metrics.approvedCount}`,
      `approved seconds             ${metrics.approvedSeconds}`,
      `cost per submitted second    ${fmt(metrics.costPerSubmittedSecond)}`,
      `cost per valid second        ${fmt(metrics.costPerTechnicallyValidSecond)}`,
      `cost per APPROVED second     ${fmt(metrics.costPerApprovedSecond)}`,
      `cost per approved clip       ${fmt(metrics.costPerApprovedClip)}`,
      `auto-rejected by QC          ${avoided.autoRejected} (≈${formatUsd(avoided.estimatedAvoidedMicros)} avoided)`,
      '',
      ...byProvider.map((row) => `  ${row.providerId}/${row.modelId}  ${formatUsd(row.micros)} over ${row.entries} charges`),
    ].join('\n'),
  )
  return EXIT.ok
}

function fmt(micros: number | null): string {
  return micros === null ? 'no data yet' : formatUsd(micros)
}

// ------------------------------------------------------------------ output ---

function output(ctx: Ctx, json: unknown, human: () => string): void {
  if (ctx.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n')
  else process.stdout.write(human() + '\n')
}

function usage(ctx: Ctx, message: string): number {
  output(ctx, { usage: message }, () => `usage: ${message}`)
  return EXIT.usage
}

function printHelp(): void {
  process.stdout.write(`masterclip — cinematic AI-video render factory

  init                     create local directories, .env, and apply migrations
  doctor                   check ffmpeg, database, queue, storage, providers, spend allowance
  providers list           list registered provider adapters
  providers health         live health check for every provider
  providers contract       run the provider contract battery  [--provider mock] [--submit]
                           a billable --submit also needs --project <id> and --yes,
                           and MASTERCLIP_MODE=live; the cost controller still decides
  models refresh           refresh the merged model catalog
  project create           --name "<name>" [--org <orgId>]
  project list             list projects
  shots import             --project <id> --file <csv|json> [--dry-run]
  shots validate           --file <csv|json>
  shots schema             emit the canonical shot JSON Schema  [--out file]
  shots template           emit a CSV shot-list template        [--out file]
  render quote             --shot <id> --provider <id> --model <id>
  render submit            --shot <id> [--provider mock] [--model mock-draft] [--count 4] [--approve]
  queue status             queue depth and recent jobs
  queue work               drain the queue inline (no long-running worker)
  queue retry              --id <deadLetterId>
  qc run                   --output <outputId>
  review export            --project <id> [--out shots.csv]
  masters package          --master <id> [--out <dir>]
  costs report             --project <id>

  --json                   machine-readable output for any command

exit codes: 0 ok · 1 error · 2 usage · 3 checks ran but reported failures
`)
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(EXIT.error)
  })
