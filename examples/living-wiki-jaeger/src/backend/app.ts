import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { JsonLogger, serializeError, type ExecutionEvent } from '@purista/harness'
import { agentIds, createLivingWikiHarness, workflowIds, type AgentId, type LivingWikiHarnessOptions, type WorkflowId } from './harness.js'
import { slugSchema } from './data.js'
import {
  agentRunRequestSchema,
  artifactCreateRequestSchema,
  reviewAnswerSchema,
  reviewDecisionSchema,
  type ProposedPageChange,
  type ReviewDecision,
  type ReviewOutcome,
  type ReviewRequest
} from './schemas.js'

type RunStatus = 'running' | 'succeeded' | 'interrupted' | 'failed' | 'cancelled'
type LivingWikiRunEvent = ExecutionEvent | {
  type: 'run.failed'
  runId: string
  at: string
  error: ReturnType<typeof serializeError>
}

interface ApiRun {
  runId: string
  kind: 'workflow' | 'agent'
  targetId: WorkflowId | AgentId
  status: RunStatus
  events: LivingWikiRunEvent[]
  controller: AbortController
  result?: unknown
  error?: unknown
  done: Promise<void>
  resolveDone: () => void
  subscribers: Set<(event: LivingWikiRunEvent) => void>
}

interface ReviewDecisionRecord {
  fingerprint: string
  response: { runId: string; outcome: ReviewOutcome }
}

function jsonError(message: string, status = 400, field?: string, code?: string, details?: unknown) {
  return new HTTPException(status as 400, {
    message: JSON.stringify({
      error: {
        code: code ?? defaultErrorCode(status),
        message,
        ...(field ? { field } : {}),
        ...(details === undefined ? {} : { details })
      }
    })
  })
}

function defaultErrorCode(status: number): string {
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'STALE_REVIEW_REQUEST'
  return 'VALIDATION_ERROR'
}

function toSse(event: LivingWikiRunEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

function traceForRun(runId: string) {
  const traceId = runId.toLowerCase()
  return { traceId, jaegerUrl: `http://localhost:16686/trace/${traceId}` }
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw jsonError('Request body must be valid JSON.', 400, 'body')
  }
}

export function createLivingWikiApi(options: LivingWikiHarnessOptions = {}) {
  const { harness, store, model } = createLivingWikiHarness(options)
  const logger = new JsonLogger({ level: 'info', bindings: { component: 'living-wiki-api' } })
  const app = new Hono()
  const runs = new Map<string, ApiRun>()
  const reviewDecisions = new Map<string, ReviewDecisionRecord>()

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      let payload: unknown
      try {
        payload = JSON.parse(error.message)
      } catch {
        payload = { error: { message: error.message } }
      }
      logger.warn('Living wiki API request failed.', {
        path: c.req.path,
        method: c.req.method,
        status: error.status,
        error: payload
      })
      return c.json(payload, error.status)
    }
    logger.error('Living wiki API request crashed.', {
      path: c.req.path,
      method: c.req.method,
      error: serializeError(error)
    })
    return c.json({ error: { message: error instanceof Error ? error.message : 'Internal error.' } }, 500)
  })

  app.get('/api/health', (c) => c.json({ status: 'ok', model }))

  app.get('/api/pages', async (c) => c.json({ pages: (await store.listPages()).map(({ slug, title, summary }) => ({ slug, title, summary })) }))
  app.get('/api/pages/:slug', async (c) => {
    const parsed = slugSchema.safeParse(c.req.param('slug'))
    if (!parsed.success) throw jsonError('Invalid slug.', 400, 'slug')
    return c.json(await store.readWikiPage(parsed.data))
  })
  app.put('/api/pages/:slug', async (c) => {
    const parsed = slugSchema.safeParse(c.req.param('slug'))
    if (!parsed.success) throw jsonError('Invalid slug.', 400, 'slug')
    const body = await readJson(c) as { content?: unknown }
    if (typeof body.content !== 'string') throw jsonError('Content must be a string.', 400, 'content')
    await store.writeWikiPage(parsed.data, body.content)
    return c.json(await store.readWikiPage(parsed.data))
  })

  app.get('/api/sources', async (c) => c.json({ sources: (await store.listSources()).map(({ slug, title, summary }) => ({ slug, title, summary })) }))
  app.get('/api/sources/:slug', async (c) => {
    const parsed = slugSchema.safeParse(c.req.param('slug'))
    if (!parsed.success) throw jsonError('Invalid slug.', 400, 'slug')
    return c.json(await store.readSource(parsed.data))
  })
  app.get('/api/graph', async (c) => {
    const pages = await store.listPages()
    const sources = await store.listSources()
    const artifacts = await store.listArtifacts()
    const pageSlugs = new Set(pages.map((page) => page.slug))
    const wikiEdges = pages.flatMap((page) => [...page.content.matchAll(/\[\[([a-z0-9][a-z0-9-]{0,79})\]\]/g)]
      .map((match) => match[1])
      .filter((target): target is string => typeof target === 'string' && pageSlugs.has(target))
      .map((target) => ({
        id: `wiki_link:page:${page.slug}:page:${target}`,
        source: `page:${page.slug}`,
        target: `page:${target}`,
        kind: 'wiki_link' as const,
        weight: 1,
        from: page.slug,
        to: target
      })))
    const citationEdges = pages.flatMap((page) => sources
      .filter((source) => page.content.includes(source.slug))
      .map((source) => ({
        id: `citation:page:${page.slug}:source:${source.slug}`,
        source: `page:${page.slug}`,
        target: `source:${source.slug}`,
        kind: 'citation' as const,
        weight: 0.7
      })))
    const artifactEdges = artifacts.flatMap((artifact) => artifact.sourcePageIds.map((pageSlug) => ({
      id: `artifact_reference:page:${pageSlug}:artifact:${artifact.artifactId}`,
      source: `page:${pageSlug}`,
      target: `artifact:${artifact.artifactId}`,
      kind: 'artifact_reference' as const,
      weight: 0.9
    })))
    const edges = [...wikiEdges, ...citationEdges, ...artifactEdges]
    const degree = new Map<string, number>()
    for (const page of pages) degree.set(`page:${page.slug}`, 0)
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
    }
    const hubs = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    const mermaid = [
      'graph LR',
      ...pages.map((page) => `  ${mermaidId(page.slug)}["${escapeMermaid(page.title)}"]`),
      ...wikiEdges.map((edge) => `  ${mermaidId(edge.from)} --> ${mermaidId(edge.to)}`)
    ].join('\n')
    const latestRun = [...runs.values()].reverse().find((run) => run.status === 'succeeded')
    const highlights = latestRun ? extractGraphHighlights(latestRun.result) : []
    return c.json({
      nodes: [
        ...pages.map((page) => ({ id: `page:${page.slug}`, label: page.title, kind: 'page', ref: page.slug, slug: page.slug, title: page.title, summary: page.summary, degree: degree.get(`page:${page.slug}`) ?? 0 })),
        ...sources.map((source) => ({ id: `source:${source.slug}`, label: source.title, kind: 'source', ref: source.slug, slug: source.slug, title: source.title, summary: source.summary, degree: degree.get(`source:${source.slug}`) ?? 0 })),
        ...artifacts.map((artifact) => ({ id: `artifact:${artifact.artifactId}`, label: artifact.title, kind: 'artifact', ref: artifact.artifactId, artifactId: artifact.artifactId, degree: degree.get(`artifact:${artifact.artifactId}`) ?? 0 }))
      ],
      edges,
      highlights,
      ...(latestRun ? { latestRunId: latestRun.runId } : {}),
      mermaid,
      panelSpec: {
        version: '1.0',
        title: 'Knowledge Map',
        sections: [
          { heading: 'Graph Shape', items: [`${pages.length} pages`, `${sources.length} sources`, `${artifacts.length} artifacts`, `${edges.length} links`, `${hubs.length} hub candidates`] },
          { heading: 'Hub Pages', items: hubs.map(([slug, count]) => `${slug}: ${count} links`) }
        ]
      }
    })
  })
  app.post('/api/artifacts', async (c) => {
    const parsed = artifactCreateRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) throw jsonError('Invalid artifact request.', 400, 'body', parsed.error.issues.some((issue) => issue.path[0] === 'kind') ? 'UNSUPPORTED_ARTIFACT_TYPE' : 'VALIDATION_ERROR', parsed.error.issues)
    const stored = await store.storeArtifact({
      kind: parsed.data.kind,
      title: parsed.data.title,
      contentType: parsed.data.contentType,
      content: parsed.data.content,
      createdByRunId: 'manual-api',
      sourcePageIds: parsed.data.sourcePageIds ?? [],
      renderMode: parsed.data.renderMode ?? 'inline',
      ...(parsed.data.drawioEditorUrl ? { drawioEditorUrl: parsed.data.drawioEditorUrl } : {}),
      ...(parsed.data.viewerConfig ? { viewerConfig: parsed.data.viewerConfig } : {})
    })
    return c.json(stored, 201)
  })
  app.get('/api/artifacts/:artifactId', async (c) => {
    try {
      return c.json(await store.readArtifact(c.req.param('artifactId')))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Artifact not found.'
      throw jsonError(message, 404, 'artifactId', 'NOT_FOUND')
    }
  })
  app.post('/api/sources/upload', async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) throw jsonError('Source upload must include a file.', 400, 'file')
    const text = await file.text()
    const fallbackSlug = slugFromName(file.name)
    const slug = slugSchema.parse(String(body['slug'] ?? fallbackSlug))
    const title = titleFromName(file.name)
    const content = text.startsWith('# ') ? text : `# ${title}\n\n${text}`
    return c.json(await store.writeSource(slug, content), 201)
  })

  app.post('/api/workflows/:workflowId', async (c) => {
    const workflowId = c.req.param('workflowId') as WorkflowId
    if (!workflowIds.includes(workflowId)) throw jsonError('Unknown workflow.', 404, 'workflowId')
    const input = await readJson(c)
    const run = await startRun({ kind: 'workflow', targetId: workflowId, input })
    return c.json({ runId: run.runId, status: run.status, trace: traceForRun(run.runId) }, 202)
  })

  app.post('/api/agents/:agentId', async (c) => {
    const agentId = c.req.param('agentId') as AgentId
    if (!agentIds.includes(agentId)) throw jsonError('Unknown agent.', 404, 'agentId')
    const body = await readJson(c)
    const request = agentRunRequestSchema.safeParse(body)
    const input = request.success && isWrappedAgentRequest(body) ? request.data.input : body
    const run = await startRun({
      kind: 'agent',
      targetId: agentId,
      input,
      ...(request.success && request.data.sessionId ? { sessionId: request.data.sessionId } : {})
    })
    if (request.success && request.data.stream) return sseResponse(run)
    return c.json({ runId: run.runId, status: run.status, trace: traceForRun(run.runId) }, 202)
  })

  app.get('/api/runs/:runId', async (c) => {
    const run = runs.get(c.req.param('runId'))
    if (!run) throw jsonError('Run not found.', 404, 'runId')
    return c.json({
      runId: run.runId,
      kind: run.kind,
      targetId: run.targetId,
      status: run.status,
      result: run.result,
      error: run.error,
      trace: traceForRun(run.runId)
    })
  })

  app.get('/api/runs/:runId/events', async (c) => {
    const run = runs.get(c.req.param('runId'))
    if (!run) throw jsonError('Run not found.', 404, 'runId')

    return sseResponse(run)
  })

  app.post('/api/reviews/:runId/decision', async (c) => {
    const runId = c.req.param('runId')
    const run = runs.get(runId)
    if (!run) throw jsonError('Run not found.', 404, 'runId', 'NOT_FOUND')
    if (run.status === 'running') await run.done
    const parsed = reviewDecisionSchema.safeParse(await readJson(c))
    if (!parsed.success) throw jsonError('Invalid review decision.', 400, 'body', 'INVALID_REVIEW_DECISION', parsed.error.issues)
    const reviewRequest = extractReviewRequest(run.result)
    if (!reviewRequest || reviewRequest.id !== parsed.data.reviewRequestId || reviewRequest.runId !== runId) {
      throw jsonError('Stale or unknown review request.', 409, 'reviewRequestId', 'STALE_REVIEW_REQUEST')
    }
    const key = `${runId}:${parsed.data.reviewRequestId}`
    const fingerprint = JSON.stringify(parsed.data)
    const existing = reviewDecisions.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw jsonError('Review request was already decided.', 409, 'reviewRequestId', 'STALE_REVIEW_REQUEST')
      }
      return c.json(existing.response)
    }

    const outcome = await applyReviewDecision(runId, parsed.data, run.result)
    const response = { runId, outcome }
    reviewDecisions.set(key, { fingerprint, response })
    return c.json(response)
  })

  app.post('/api/reviews/:runId/answer', async (c) => {
    const runId = c.req.param('runId')
    const run = runs.get(runId)
    if (!run) throw jsonError('Run not found.', 404, 'runId', 'NOT_FOUND')
    if (run.status === 'running') await run.done
    const parsed = reviewAnswerSchema.safeParse(await readJson(c))
    if (!parsed.success) throw jsonError('Invalid review answer.', 400, 'body', 'INVALID_REVIEW_ANSWER', parsed.error.issues)
    const reviewRequest = extractReviewRequest(run.result)
    if (!reviewRequest || reviewRequest.id !== parsed.data.reviewRequestId || reviewRequest.runId !== runId) {
      throw jsonError('Stale or unknown review request.', 409, 'reviewRequestId', 'STALE_REVIEW_REQUEST')
    }
    const question = reviewRequest.questions.find((candidate) => candidate.id === parsed.data.questionId)
    if (!question) throw jsonError('Unknown review question.', 404, 'questionId', 'NOT_FOUND')
    logger.info('Living wiki review answer captured.', {
      run_id: runId,
      review_request_id: parsed.data.reviewRequestId,
      question_id: parsed.data.questionId
    })
    return c.json({
      runId,
      reviewRequestId: parsed.data.reviewRequestId,
      questionId: parsed.data.questionId,
      accepted: true
    })
  })

  app.post('/api/runs/:runId/cancel', async (c) => {
    const run = runs.get(c.req.param('runId'))
    if (!run) throw jsonError('Run not found.', 404, 'runId')
    if (run.status === 'running') run.controller.abort(new Error('cancelled by api'))
    return c.json({ runId: run.runId, status: 'cancelling' }, 202)
  })

  function sseResponse(run: ApiRun): Response {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const send = (event: LivingWikiRunEvent) => controller.enqueue(encoder.encode(toSse(event)))
        for (const event of run.events) send(event)
        const subscriber = (event: LivingWikiRunEvent) => send(event)
        run.subscribers.add(subscriber)
        run.done.finally(() => {
          run.subscribers.delete(subscriber)
          try {
            controller.close()
          } catch {}
        })
      }
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      }
    })
  }

  async function applyReviewDecision(runId: string, decision: ReviewDecision, result: unknown): Promise<ReviewOutcome> {
    const proposedChanges = extractProposedChanges(result)
    let selectedChanges: ProposedPageChange[] = []
    if (decision.decision === 'accept_all') selectedChanges = proposedChanges
    if (decision.decision === 'accept_selected') {
      const accepted = new Set(decision.acceptedChangeIds ?? [])
      selectedChanges = proposedChanges.filter((change) => accepted.has(change.id))
    }
    if (decision.decision === 'choose_alternative') {
      const accepted = new Set(decision.selectedAlternativeIds ?? [])
      selectedChanges = proposedChanges.filter((change) => accepted.has(change.id))
    }

    if (decision.decision === 'custom_guidance') {
      const followUpRunId = crypto.randomUUID()
      await store.appendLog({ workflow: 'review_decision', message: `revision requested for ${decision.reviewRequestId}`, pages: pageIdsForChanges(proposedChanges) })
      return {
        reviewRequestId: decision.reviewRequestId,
        runId,
        status: 'revision_started',
        appliedChangeIds: [],
        followUpRunId,
        logEntryId: `log:${runId}:${decision.reviewRequestId}`
      }
    }

    if (decision.decision === 'reject_all') {
      await store.appendLog({ workflow: 'review_decision', message: `rejected ${decision.reviewRequestId}`, pages: pageIdsForChanges(proposedChanges) })
      return {
        reviewRequestId: decision.reviewRequestId,
        runId,
        status: 'rejected',
        appliedChangeIds: [],
        logEntryId: `log:${runId}:${decision.reviewRequestId}`
      }
    }

    for (const change of selectedChanges) {
      if (change.afterMarkdown && change.targetPageId) await store.writeWikiPage(change.targetPageId, change.afterMarkdown)
    }
    await store.appendLog({
      workflow: 'review_decision',
      message: `applied ${selectedChanges.length} changes for ${decision.reviewRequestId}`,
      pages: pageIdsForChanges(selectedChanges)
    })
    return {
      reviewRequestId: decision.reviewRequestId,
      runId,
      status: 'applied',
      appliedChangeIds: selectedChanges.map((change) => change.id),
      logEntryId: `log:${runId}:${decision.reviewRequestId}`
    }
  }

  async function startRun(args: ({ kind: 'workflow'; targetId: WorkflowId; input: unknown } | { kind: 'agent'; targetId: AgentId; input: unknown }) & { sessionId?: string }): Promise<ApiRun> {
    const controller = new AbortController()
    const session = await harness.getSession(args.sessionId ?? `living-wiki-${crypto.randomUUID()}`)
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    let firstRun!: (run: ApiRun) => void
    let failFirst!: (error: unknown) => void
    const first = new Promise<ApiRun>((resolve, reject) => {
      firstRun = resolve
      failFirst = reject
    })

    const pending: Omit<ApiRun, 'runId'> & { runId?: string } = {
      kind: args.kind,
      targetId: args.targetId,
      status: 'running',
      events: [],
      controller,
      done,
      resolveDone,
      subscribers: new Set()
    }

    void (async () => {
      try {
        const invoker = args.kind === 'workflow' ? session.workflows[args.targetId] : session.agents[args.targetId]
        if (!invoker) throw new Error(`Unknown ${args.kind} target ${args.targetId}.`)
        for await (const event of invoker.stream(args.input as never, { signal: controller.signal })) {
          if (!pending.runId) {
            pending.runId = event.runId
            const run = pending as ApiRun
            runs.set(run.runId, run)
            firstRun(run)
          }
          pending.events.push(event)
          for (const subscriber of pending.subscribers) subscriber(event)
          if (event.type === 'run.finished') {
            if (event.outcome.status === 'completed') {
              pending.status = 'succeeded'
              pending.result = event.outcome.output
              logger.info('Living wiki run finished.', {
                run_id: event.runId,
                kind: args.kind,
                target_id: args.targetId,
                status: pending.status
              })
            } else {
              pending.status = 'interrupted'
              pending.result = event.outcome.interrupt
              logger.info('Living wiki run interrupted.', {
                run_id: event.runId,
                kind: args.kind,
                target_id: args.targetId,
                status: pending.status,
                interrupt_type: event.outcome.interrupt.type
              })
            }
          }
        }
      } catch (error) {
        pending.status = controller.signal.aborted ? 'cancelled' : 'failed'
        pending.error = error instanceof Error ? { message: error.message } : { message: 'Run failed.' }
        if (pending.runId) {
          const failedEvent: LivingWikiRunEvent = {
            type: 'run.failed',
            runId: pending.runId,
            at: new Date().toISOString(),
            error: serializeError(error)
          }
          pending.events.push(failedEvent)
          for (const subscriber of pending.subscribers) subscriber(failedEvent)
        }
        if (!pending.runId || pending.events.every((event) => event.type !== 'run.finished')) {
          const log = pending.status === 'cancelled' ? logger.warn.bind(logger) : logger.error.bind(logger)
          log('Living wiki run failed before completion.', {
            run_id: pending.runId,
            kind: args.kind,
            target_id: args.targetId,
            status: pending.status,
            error: serializeError(error)
          })
        }
        if (!pending.runId) failFirst(error)
      } finally {
        pending.resolveDone()
        await session.destroy().catch(() => undefined)
      }
    })()

    return first
  }

  return {
    app,
    runs,
    model,
    store,
    async shutdown() {
      for (const run of runs.values()) {
        if (run.status === 'running') run.controller.abort(new Error('shutdown'))
      }
      await Promise.all([...runs.values()].map((run) => run.done.catch(() => undefined)))
      await harness.shutdown()
    }
  }
}

function slugFromName(name: string): string {
  const slug = name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slugSchema.safeParse(slug).success ? slug : `source-${Date.now()}`
}

function titleFromName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function mermaidId(slug: string): string {
  return `n_${slug.replace(/[^a-z0-9]/g, '_')}`
}

function escapeMermaid(value: string): string {
  return value.replaceAll('"', '\\"')
}

function isWrappedAgentRequest(value: unknown): value is { input: unknown; sessionId?: string; stream?: boolean } {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'input')
}

function extractReviewRequest(result: unknown): ReviewRequest | undefined {
  if (!isRecord(result)) return undefined
  const reviewRequest = result['reviewRequest']
  if (!isRecord(reviewRequest)) return undefined
  if (typeof reviewRequest['id'] !== 'string' || typeof reviewRequest['runId'] !== 'string') return undefined
  return reviewRequest as ReviewRequest
}

function extractProposedChanges(result: unknown): ProposedPageChange[] {
  if (!isRecord(result)) return []
  const proposedChanges = result['proposedChanges']
  if (!Array.isArray(proposedChanges)) return []
  return proposedChanges.filter(isProposedPageChange)
}

function extractGraphHighlights(result: unknown): unknown[] {
  if (!isRecord(result)) return []
  const highlights = result['graphHighlights']
  return Array.isArray(highlights) ? highlights : []
}

function isProposedPageChange(value: unknown): value is ProposedPageChange {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['title'] === 'string'
    && typeof value['rationale'] === 'string'
    && typeof value['risk'] === 'string'
}

function pageIdsForChanges(changes: ProposedPageChange[]): string[] {
  return [...new Set(changes.map((change) => change.targetPageId).filter((slug): slug is string => typeof slug === 'string'))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
