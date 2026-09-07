import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import type { ModelProvider } from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import { createLivingWikiApi } from './app.js'
import { createScriptedLivingWikiProvider } from './harness.js'

async function createFixture(): Promise<{ dataRoot: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'living-wiki-api-'))
  const dataRoot = join(root, 'data')
  await mkdir(join(dataRoot, 'raw/sources'), { recursive: true })
  await mkdir(join(dataRoot, 'wiki'), { recursive: true })
  await writeFile(join(dataRoot, 'raw/sources/jaeger.md'), '# Jaeger Source\n\nJaeger stores traces.\n')
  await writeFile(join(dataRoot, 'wiki/index.md'), '# Index\n')
  await writeFile(join(dataRoot, 'wiki/log.md'), '# Log\n')
  await writeFile(join(dataRoot, 'wiki/jaeger.md'), '# Jaeger\n')
  return { dataRoot, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe('living wiki API', () => {
  test('streams chat with the standard AI SDK UI Message Stream v1 protocol', async () => {
    const fixture = await createFixture()
    const { app, shutdown } = await createLivingWikiApi({
      dataRoot: fixture.dataRoot,
      provider: createScriptedLivingWikiProvider(),
      model: 'fake-wiki-model',
    })
    try {
      const response = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'wiki-chat-session',
          trigger: 'submit-message',
          messages: [{ id: 'question-1', role: 'user', parts: [{ type: 'text', text: 'What stores traces?' }] }],
        }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      const body = await response.text()
      expect(body).toContain('data-output')
      expect(body).toContain('[DONE]')
    } finally {
      await shutdown()
      await fixture.cleanup()
    }
  })

  test('interrupts a writable chat tool and resumes the same root after standard approval', async () => {
    const fixture = await createFixture()
    const provider = new FakeModelProvider({ strict: true })
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    provider.enqueueObjectStream([
      {
        kind: 'tool_call',
        call: {
          id: 'write-approved-note',
          name: 'writeWikiPage',
          arguments: { slug: 'approved-note', content: '# Approved note\n\nWritten after review.\n' },
        },
      },
      { kind: 'finish', object: null, usage, finishReason: 'tool_calls' },
    ])
    const finalAnswer = {
      answer: 'The approved note was written.',
      citedPages: ['approved-note'],
      confidenceNotes: ['The write tool completed after approval.'],
    }
    provider.enqueueObjectStream([
      { kind: 'partial', partial: finalAnswer },
      { kind: 'finish', object: finalAnswer, usage, finishReason: 'stop' },
    ])
    const { app, store, shutdown } = await createLivingWikiApi({
      dataRoot: fixture.dataRoot,
      provider,
      model: 'fake-wiki-model',
    })
    const userMessage = {
      id: 'write-question',
      role: 'user',
      parts: [{ type: 'text', text: 'Create the approved note page.' }],
    }

    try {
      const first = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'approval-chat-session', trigger: 'submit-message', messages: [userMessage] }),
      })
      const firstChunks = await responseChunks(first)
      const start = requiredChunk(firstChunks, 'start')
      const input = requiredChunk(firstChunks, 'tool-input-available')
      const approval = requiredChunk(firstChunks, 'tool-approval-request')
      const assistantMessageId = requiredString(start['messageId'], 'assistant message id')
      const toolCallId = requiredString(input['toolCallId'], 'tool call id')
      const toolName = requiredString(input['toolName'], 'tool name')
      const approvalId = requiredString(approval['approvalId'], 'approval id')
      const descriptor = requiredRecord(approval['approvalDescriptor'], 'approval descriptor')
      const rootRunId = requiredString(descriptor['rootRunId'], 'root run id')
      expect(toolName).toBe('writeWikiPage')
      expect(approval['reason']).toBe('wiki_write')
      await expect(store.readWikiPage('approved-note')).rejects.toThrow()

      const assistantMessage = {
        id: assistantMessageId,
        role: 'assistant',
        parts: [{
          type: 'dynamic-tool',
          toolName,
          toolCallId,
          state: 'approval-responded',
          input: input['input'],
          approval: {
            id: approvalId,
            approved: true,
            descriptor,
            reason: 'Approved in the integration test.',
          },
        }],
      }
      const resumed = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'approval-chat-session',
          trigger: 'submit-message',
          messageId: assistantMessageId,
          messages: [userMessage, assistantMessage],
        }),
      })
      const resumedChunks = await responseChunks(resumed)
      expect(JSON.stringify(resumedChunks)).toContain(rootRunId)
      expect(resumedChunks).toContainEqual(expect.objectContaining({ type: 'data-output' }))
      await expect(store.readWikiPage('approved-note')).resolves.toMatchObject({
        content: expect.stringContaining('Written after review.'),
      })
      provider.assertExhausted()
    } finally {
      await shutdown()
      await fixture.cleanup()
    }
  })

  test('serves pages and starts observable fake workflow runs', async () => {
    const fixture = await createFixture()
    const provider = createScriptedLivingWikiProvider()
    const { app, shutdown } = await createLivingWikiApi({
      dataRoot: fixture.dataRoot,
      provider,
      model: 'fake-wiki-model'
    })

    try {
      const health = await app.request('/api/health')
      await expect(health.json()).resolves.toMatchObject({ status: 'ok', model: 'fake-wiki-model' })

      const page = await app.request('/api/pages/jaeger')
      await expect(page.json()).resolves.toMatchObject({ slug: 'jaeger', title: 'Jaeger' })

      const started = await app.request('/api/workflows/ask_wiki', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'What stores traces?' })
      })
      expect(started.status).toBe(202)
      const startedBody = await started.json() as { runId: string; status: string }
      expect(startedBody.status).toBe('running')

      const events = await app.request(`/api/runs/${startedBody.runId}/events`)
      expect(events.headers.get('content-type')).toContain('text/event-stream')
      const eventText = await events.text()
      expect(eventText).toContain('"status":"completed"')
      expect(eventText).toContain('run.finished')

      const lookup = await app.request(`/api/runs/${startedBody.runId}`)
      await expect(lookup.json()).resolves.toMatchObject({ runId: startedBody.runId, status: 'succeeded' })
    } finally {
      await shutdown()
      await fixture.cleanup()
    }
  })

  test('cancels an in-flight run through the registry', async () => {
    const fixture = await createFixture()
    const provider = createScriptedLivingWikiProvider({ delayMs: 200 })
    const { app, shutdown } = await createLivingWikiApi({
      dataRoot: fixture.dataRoot,
      provider,
      model: 'fake-wiki-model'
    })

    try {
      const started = await app.request('/api/workflows/ask_wiki', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'Cancel me.' })
      })
      const { runId } = await started.json() as { runId: string }
      const cancelled = await app.request(`/api/runs/${runId}/cancel`, { method: 'POST' })
      expect(cancelled.status).toBe(202)

      const events = await app.request(`/api/runs/${runId}/events`)
      expect(await events.text()).toContain('"status":"cancelled"')
    } finally {
      await shutdown()
      await fixture.cleanup()
    }
  })

  test('uploads a markdown source file', async () => {
    const fixture = await createFixture()
    const { app, shutdown } = await createLivingWikiApi({
      dataRoot: fixture.dataRoot,
      provider: createScriptedLivingWikiProvider(),
      model: 'fake-wiki-model'
    })

    try {
      const form = new FormData()
      form.append('file', new File(['Upload body'], 'uploaded-source.md', { type: 'text/markdown' }))
      const response = await app.request('/api/sources/upload', { method: 'POST', body: form })
      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({ slug: 'uploaded-source', title: 'Uploaded Source' })

      const source = await app.request('/api/sources/uploaded-source')
      await expect(source.json()).resolves.toMatchObject({ slug: 'uploaded-source', content: expect.stringContaining('Upload body') })

      const graph = await app.request('/api/graph')
      await expect(graph.json()).resolves.toMatchObject({ mermaid: expect.stringContaining('graph LR') })
    } finally {
      await shutdown()
      await fixture.cleanup()
    }
  })

  test('starts direct agent runs without a workflow', async () => {
    const fixture = await createFixture()
    const { app, shutdown } = await createLivingWikiApi({
      dataRoot: fixture.dataRoot,
      provider: createScriptedLivingWikiProvider(),
      model: 'fake-wiki-model'
    })

    try {
      const started = await app.request('/api/agents/wiki_answerer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'What stores traces?' })
      })
      expect(started.status).toBe(202)
      const startedBody = await started.json() as { runId: string; status: string }
      expect(startedBody.status).toBe('running')

      const events = await app.request(`/api/runs/${startedBody.runId}/events`)
      expect(await events.text()).toContain('run.finished')

      const lookup = await app.request(`/api/runs/${startedBody.runId}`)
      await expect(lookup.json()).resolves.toMatchObject({ runId: startedBody.runId, kind: 'agent', targetId: 'wiki_answerer', status: 'succeeded' })
    } finally {
      await shutdown()
      await fixture.cleanup()
    }
  })

  test('streams validation failures with actionable metadata', async () => {
    const fixture = await createFixture()
    const badProvider = {
      id: 'bad-provider',
      genAiSystem: 'fake',
      async object() {
        return {
          object: { answer: 'missing required arrays' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop'
        }
      },
      async *objectStream() {
        yield {
          kind: 'finish' as const,
          object: { answer: 'missing required arrays' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop' as const
        }
      }
    }
    const { app, shutdown } = await createLivingWikiApi({
      dataRoot: fixture.dataRoot,
      provider: badProvider as unknown as ModelProvider,
      model: 'bad-model'
    })

    try {
      const started = await app.request('/api/workflows/ask_wiki', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'What fails?' })
      })
      const { runId } = await started.json() as { runId: string }
      const events = await app.request(`/api/runs/${runId}/events`)
      const eventText = await events.text()
      expect(eventText).toContain('VALIDATION_ERROR')
      expect(eventText).toContain('agent_output')
    } finally {
      await shutdown()
      await fixture.cleanup()
    }
  })

  test('returns spec-shaped graph nodes and stores generated artifacts', async () => {
    const fixture = await createFixture()
    const { app, shutdown } = await createLivingWikiApi({
      dataRoot: fixture.dataRoot,
      provider: createScriptedLivingWikiProvider(),
      model: 'fake-wiki-model'
    })

    try {
      const created = await app.request('/api/artifacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'mermaid',
          title: 'Trace Map',
          contentType: 'text/vnd.mermaid',
          content: 'graph LR\n  source --> wiki\n',
          sourcePageIds: ['jaeger'],
          renderMode: 'inline'
        })
      })
      expect(created.status).toBe(201)
      const artifact = await created.json() as { manifest: { artifactId: string }; content: string }
      expect(artifact.content).toContain('graph LR')

      const fetched = await app.request(`/api/artifacts/${artifact.manifest.artifactId}`)
      await expect(fetched.json()).resolves.toMatchObject({
        manifest: { artifactId: artifact.manifest.artifactId, kind: 'mermaid' },
        content: expect.stringContaining('source --> wiki')
      })

      const graph = await app.request('/api/graph')
      await expect(graph.json()).resolves.toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'page:jaeger', label: 'Jaeger', kind: 'page', ref: 'jaeger' }),
          expect.objectContaining({ id: `artifact:${artifact.manifest.artifactId}`, kind: 'artifact' })
        ]),
        edges: expect.arrayContaining([
          expect.objectContaining({ kind: 'artifact_reference', target: `artifact:${artifact.manifest.artifactId}` })
        ]),
        highlights: expect.any(Array),
        panelSpec: expect.any(Object)
      })

      const traversal = await app.request('/api/artifacts/../secret')
      expect(traversal.status).not.toBe(200)
    } finally {
      await shutdown()
      await fixture.cleanup()
    }
  })

  test('runs intelligence workflows and applies review decisions idempotently', async () => {
    const fixture = await createFixture()
    const { app, shutdown } = await createLivingWikiApi({
      dataRoot: fixture.dataRoot,
      provider: createScriptedLivingWikiProvider(),
      model: 'fake-wiki-model'
    })

    try {
      const memoStarted = await app.request('/api/workflows/decision_memo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposal: 'adopt Jaeger tracing', question: 'Should we adopt Jaeger tracing?' })
      })
      expect(memoStarted.status).toBe(202)
      const memoRun = await memoStarted.json() as { runId: string }
      await (await app.request(`/api/runs/${memoRun.runId}/events`)).text()
      await expect((await app.request(`/api/runs/${memoRun.runId}`)).json()).resolves.toMatchObject({
        status: 'succeeded',
        result: {
          recommendation: 'pilot',
          judge: { verdict: 'approved' },
          artifacts: expect.any(Array)
        }
      })

      const architectureStarted = await app.request('/api/workflows/architecture_review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceSlug: 'jaeger', focus: 'trace observability' })
      })
      expect(architectureStarted.status).toBe(202)
      const architectureRun = await architectureStarted.json() as { runId: string }
      await (await app.request(`/api/runs/${architectureRun.runId}/events`)).text()
      const architectureLookup = await (await app.request(`/api/runs/${architectureRun.runId}`)).json() as {
        result: { reviewRequest: { id: string; runId: string } }
      }
      expect(architectureLookup.result.reviewRequest.runId).toBe(architectureRun.runId)
      const architectureDecision = await app.request(`/api/reviews/${architectureRun.runId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reviewRequestId: architectureLookup.result.reviewRequest.id,
          decision: 'custom_guidance',
          answers: { approval: false },
          guidance: 'Keep iterating.'
        })
      })
      expect(architectureDecision.status).toBe(200)
      expect(architectureLookup).toMatchObject({
        result: { readiness: 'changes_requested', judge: { verdict: 'needs_human_review' } }
      })

      const auditStarted = await app.request('/api/workflows/wiki_audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'all' })
      })
      expect(auditStarted.status).toBe(202)
      const auditRun = await auditStarted.json() as { runId: string }
      await (await app.request(`/api/runs/${auditRun.runId}/events`)).text()
      const beforeDecision = await (await app.request('/api/pages/jaeger')).json() as { content: string }
      expect(beforeDecision.content).not.toContain('Audit note')

      const auditLookup = await (await app.request(`/api/runs/${auditRun.runId}`)).json() as {
        result: { reviewRequest: { id: string } }
      }
      const answer = await app.request(`/api/reviews/${auditRun.runId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewRequestId: auditLookup.result.reviewRequest.id, questionId: 'approval', value: false })
      })
      expect(answer.status).toBe(200)
      await expect(answer.json()).resolves.toMatchObject({ accepted: true, questionId: 'approval' })
      const decisionBody = {
        reviewRequestId: auditLookup.result.reviewRequest.id,
        decision: 'accept_all',
        answers: { approval: true }
      }
      const decided = await app.request(`/api/reviews/${auditRun.runId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decisionBody)
      })
      expect(decided.status).toBe(200)
      const outcome = await decided.json()
      expect(outcome).toMatchObject({ runId: auditRun.runId, outcome: { status: 'applied', appliedChangeIds: expect.any(Array) } })

      const replayed = await app.request(`/api/reviews/${auditRun.runId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decisionBody)
      })
      await expect(replayed.json()).resolves.toEqual(outcome)

      const afterDecision = await (await app.request('/api/pages/jaeger')).json() as { content: string }
      expect(afterDecision.content).toContain('Audit note')
    } finally {
      await shutdown()
      await fixture.cleanup()
    }
  })
})

async function responseChunks(response: Response): Promise<Record<string, unknown>[]> {
  const body = await response.text()
  return body
    .split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => requiredRecord(JSON.parse(line.slice(6)) as unknown, 'SSE chunk'))
}

function requiredChunk(chunks: readonly Record<string, unknown>[], type: string): Record<string, unknown> {
  const chunk = chunks.find(candidate => candidate['type'] === type)
  if (!chunk) throw new Error(`Expected ${type} chunk.`)
  return chunk
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected ${label}.`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Expected ${label}.`)
  return value
}
