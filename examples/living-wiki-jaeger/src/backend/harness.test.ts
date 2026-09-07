import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { FakeModelProvider } from '@purista/harness/testing'
import { describe, expect, test } from 'vitest'
import * as z from 'zod/v4'
import { createLivingWikiHarness, createScriptedLivingWikiProvider } from './harness.js'
import { reviewRequestSchema } from './schemas.js'

async function createFixture(): Promise<{ dataRoot: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'living-wiki-harness-'))
  const dataRoot = join(root, 'data')
  await mkdir(join(dataRoot, 'raw/sources'), { recursive: true })
  await mkdir(join(dataRoot, 'wiki'), { recursive: true })
  await writeFile(join(dataRoot, 'raw/sources/jaeger.md'), '# Jaeger Source\n\nJaeger stores traces.\n')
  await writeFile(join(dataRoot, 'wiki/index.md'), '# Index\n')
  await writeFile(join(dataRoot, 'wiki/log.md'), '# Log\n')
  await writeFile(join(dataRoot, 'wiki/jaeger.md'), '# Jaeger\n\nTrace storage.\n')

  return {
    dataRoot,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

describe('living wiki harness workflows', () => {
  test('defaults review questions to required when model output omits the field', () => {
    const parsed = reviewRequestSchema.parse({
      id: 'review-default-required',
      runId: 'run-1',
      title: 'Review generated changes',
      reason: 'Model omitted required flags.',
      questions: [
        { id: 'approval', label: 'Approve changes?', kind: 'approval' },
        { id: 'guidance', label: 'Guidance', kind: 'free_text' }
      ],
      defaultDecision: 'approve'
    })

    expect(parsed.questions.map((question) => question.required)).toEqual([true, true])
  })

  test('runs all workflow contracts with a fake provider and no OpenAI calls', async () => {
    const fixture = await createFixture()
    const provider = createScriptedLivingWikiProvider()
    const { harness, storage } = await createLivingWikiHarness({
      dataRoot: fixture.dataRoot,
      provider,
      model: 'fake-wiki-model'
    })

    try {
      const session = await harness.getSession('test-session')

      await expect((session.workflows.ingestSource).run({ sourceSlug: 'jaeger' })).resolves.toMatchObject({
        status: 'completed',
        output: {
          updatedPages: expect.arrayContaining(['jaeger']),
          extractedConcepts: expect.arrayContaining(['jaeger'])
        }
      })
      await expect((session.workflows.askWiki).run({ question: 'What stores traces?' })).resolves.toMatchObject({
        status: 'completed',
        output: { citedPages: expect.arrayContaining(['jaeger']) }
      })
      await expect((session.workflows.lintWiki).run({ scope: 'all' })).resolves.toMatchObject({
        status: 'completed',
        output: { panelSpec: expect.any(Object) }
      })
      await expect((session.workflows.reconcileContradiction).run({
        leftRef: 'jaeger',
        rightRef: 'index',
        conflict: 'Trace backend wording differs.'
      })).resolves.toMatchObject({
        status: 'completed',
        output: { changedPages: expect.any(Array) }
      })
      await expect((session.workflows.generateResearchBrief).run({
        pageSlugs: ['jaeger'],
        goal: 'Explain tracing.'
      })).resolves.toMatchObject({
        status: 'completed',
        output: {
          citedPages: ['jaeger'],
          panelSpec: expect.any(Object),
          artifacts: expect.arrayContaining([
            expect.objectContaining({ kind: 'markdown', content: expect.stringContaining('Research Brief') }),
            expect.objectContaining({ kind: 'mermaid', content: expect.stringContaining('graph LR') }),
            expect.objectContaining({ kind: 'drawio_xml', content: expect.stringContaining('<mxGraphModel') }),
            expect.objectContaining({ kind: 'json_panel', panelSpec: expect.any(Object) })
          ])
        }
      })

      const memo = await (session.workflows.decisionMemo).run({
        proposal: 'adopt Jaeger tracing',
        question: 'Should we adopt Jaeger tracing?'
      })
      expect(memo).toMatchObject({ status: 'completed' })
      if (memo.status !== 'completed') throw new Error('Decision memo did not complete.')
      expect(memo.output).toMatchObject({
        markdown: expect.stringContaining('Decision Memo'),
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: 'markdown', content: expect.stringContaining('Decision Memo') }),
          expect.objectContaining({ kind: 'mermaid', content: expect.stringContaining('Decision') }),
          expect.objectContaining({ kind: 'drawio_xml', content: expect.stringContaining('<mxfile') }),
          expect.objectContaining({ kind: 'json_panel', panelSpec: expect.any(Object) })
        ])
      })

      const review = await (session.workflows.architectureReview).run({
        sourceSlug: 'jaeger',
        focus: 'trace observability'
      })
      expect(review).toMatchObject({ status: 'completed' })
      if (review.status !== 'completed') throw new Error('Architecture review did not complete.')
      expect(review.output).toMatchObject({
        markdown: expect.stringContaining('Architecture Review'),
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: 'markdown', content: expect.stringContaining('Architecture Review') }),
          expect.objectContaining({ kind: 'mermaid', content: expect.stringContaining('Architecture') }),
          expect.objectContaining({ kind: 'drawio_xml', content: expect.stringContaining('<mxGraphModel') }),
          expect.objectContaining({ kind: 'json_panel', panelSpec: expect.any(Object) })
        ])
      })

      expect(provider.requests.length).toBeGreaterThanOrEqual(5)
      expect(provider.requests.flatMap(request => request.tools ?? []).map(tool => tool.name))
        .not.toContain('createDrawioDiagram')
    } finally {
      await harness.close()
      await storage.close()
      await fixture.cleanup()
    }
  })

  test('binds the optional typed draw.io MCP server without changing the default setup', async () => {
    const fixture = await createFixture()
    const calls: Array<{ title: string; nodes: string[] }> = []
    const mcp = await startDrawioMcpServer(calls)
    const provider = new FakeModelProvider({ strict: true })
    const usage = { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
    provider.enqueueObject({
      object: null,
      toolCalls: [{
        id: 'drawio-call',
        name: 'createDrawioDiagram',
        arguments: { title: 'Trace flow', nodes: ['API', 'Harness', 'Jaeger'] },
      }],
      usage,
      finishReason: 'tool_calls',
    })
    provider.enqueueObject({
      object: architectureReviewResult(),
      usage,
      finishReason: 'stop',
    })
    const { harness, storage } = await createLivingWikiHarness({
      dataRoot: fixture.dataRoot,
      provider,
      model: 'fake-wiki-model',
      drawioMcp: { transport: 'http', url: mcp.url },
    })

    try {
      const session = await harness.getSession('mcp-session')
      await expect(session.workflows.architectureReview.run({
        sourceSlug: 'jaeger',
        focus: 'diagram the trace flow',
      })).resolves.toMatchObject({ status: 'completed' })
      expect(calls).toEqual([{ title: 'Trace flow', nodes: ['API', 'Harness', 'Jaeger'] }])
      const secondRequest = provider.requests[1]
      if (!secondRequest || !('messages' in secondRequest)) throw new Error('Expected a second model request with tool results.')
      const toolMessage = secondRequest.messages.find(message => message.role === 'tool')
      if (!toolMessage || typeof toolMessage.content !== 'string') throw new Error('Expected the normalized MCP tool result in the second model request.')
      expect(JSON.parse(toolMessage.content)).toEqual({ xml: '<mxfile title="Trace flow" nodes="3" />' })
      provider.assertExhausted()
    } finally {
      await harness.close()
      await storage.close()
      await mcp.close()
      await fixture.cleanup()
    }
  })
})

async function startDrawioMcpServer(calls: Array<{ title: string; nodes: string[] }>): Promise<{ url: string; close(): Promise<void> }> {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'living-wiki-drawio-test', version: '0.0.0' })
    server.registerTool('create_drawio_diagram', {
      description: 'Create a draw.io XML diagram from a title and labeled nodes.',
      inputSchema: { title: z.string().min(1), nodes: z.array(z.string().min(1)).min(1) },
      outputSchema: { xml: z.string().min(1) },
    }, async ({ title, nodes }) => {
      calls.push({ title, nodes: [...nodes] })
      const structuredContent = { xml: `<mxfile title="${title}" nodes="${nodes.length}" />` }
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent }
    })
    return server
  }, { legacy: 'reject', responseMode: 'json' })
  const nodeHandler = toNodeHandler(handler)
  const server = createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end()
      return
    }
    await nodeHandler(request as Parameters<typeof nodeHandler>[0], response)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP test server did not bind to a TCP port.')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await handler.close()
      await closeServer(server)
    },
  }
}

function architectureReviewResult() {
  return {
    markdown: '## Architecture Review\n\nThe trace flow is ready after the diagram review.',
    readiness: 'approved' as const,
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredFollowUps: [],
    citedEvidence: [{
      id: 'mcp-evidence',
      title: 'Jaeger Source',
      sourceType: 'uploaded_source' as const,
      reference: 'jaeger',
      quoteOrSummary: 'Jaeger stores traces.',
      confidence: 'high' as const,
    }],
    judge: {
      score: 10,
      maxScore: 10,
      verdict: 'approved' as const,
      criteria: [{ id: 'diagram', label: 'Diagram', score: 10, maxScore: 10, rationale: 'MCP result was available.' }],
    },
    artifacts: [],
    panelSpec: { version: '1.0', title: 'Architecture Review', sections: [] },
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
}
