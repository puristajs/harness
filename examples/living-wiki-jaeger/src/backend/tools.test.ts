import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToolHandlerContext } from '@purista/harness'
import { createLivingWikiStore } from './data.js'
import { createLivingWikiTools } from './tools.js'

async function createTempDataRoot(): Promise<string> {
  const root = join(tmpdir(), `living-wiki-tools-${randomUUID()}`)
  await mkdir(join(root, 'wiki'), { recursive: true })
  await mkdir(join(root, 'raw', 'sources'), { recursive: true })
  await writeFile(join(root, 'wiki', 'index.md'), '# Index\n\nSee [[agent-harness]].\n', 'utf8')
  await writeFile(join(root, 'wiki', 'agent-harness.md'), '# Agent Harness\n\nHarness content.\n', 'utf8')
  await writeFile(join(root, 'wiki', 'log.md'), '# Operational Log\n', 'utf8')
  await writeFile(join(root, 'raw', 'sources', 'harness-flow.md'), '# Harness Flow\n\nSource content.\n', 'utf8')
  return root
}

async function createRegisteredLivingWikiTools() {
  const store = createLivingWikiStore({ dataRoot: await createTempDataRoot() })
  const tools = createLivingWikiTools(store)
  return tools
}

function toolContext(): ToolHandlerContext<Record<string, never>> {
  return {
    signal: new AbortController().signal,
    metadata: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as ToolHandlerContext<Record<string, never>>['logger'],
    telemetry: { span: vi.fn((_name: string, _attrs: unknown, fn: () => unknown) => fn()) } as unknown as ToolHandlerContext<Record<string, never>>['telemetry'],
    metrics: {} as ToolHandlerContext<Record<string, never>>['metrics'],
    runId: 'run_test',
    caller: { kind: 'agent', agentId: 'testAgent' },
    invocationId: 'invocation_test',
    sessionId: 'session_test',
    toolId: 'testTool',
    callId: 'call_test',
    idempotencyKey: 'run_test:call_test'
  }
}

describe('wiki tool contracts', () => {
  it('defines the required typed tools with Zod input and output schemas', async () => {
    const tools = await createRegisteredLivingWikiTools()

    expect(Object.keys(tools).sort()).toEqual([
      'appendLog',
      'listBacklinks',
      'readSource',
      'readWikiPage',
      'renderPanelSpec',
      'searchWiki',
      'writeWikiPage'
    ])

    for (const tool of Object.values(tools)) {
      expect(tool.description).toEqual(expect.any(String))
      expect(tool.input.safeParse).toEqual(expect.any(Function))
      expect(tool.output.safeParse).toEqual(expect.any(Function))
      expect(tool.handler).toEqual(expect.any(Function))
    }
  })

  it('performs file IO through safe slug-based tools and returns structured JSON', async () => {
    const tools = await createRegisteredLivingWikiTools()
    const ctx = toolContext()

    const source = await tools['readSource']!.handler(ctx, { slug: 'harness-flow' })
    expect(tools['readSource']!.output.safeParse(source).success).toBe(true)
    expect(source).toMatchObject({ slug: 'harness-flow', content: expect.stringContaining('Source content') })

    const written = await tools['writeWikiPage']!.handler(ctx, {
      slug: 'new-page',
      content: '# New Page\n\nLinks to [[agent-harness]].\n'
    })
    expect(tools['writeWikiPage']!.output.safeParse(written).success).toBe(true)
    expect(written).toMatchObject({ slug: 'new-page', content: expect.stringContaining('[[agent-harness]]') })

    const backlinks = await tools['listBacklinks']!.handler(ctx, { slug: 'agent-harness' })
    expect(tools['listBacklinks']!.output.safeParse(backlinks).success).toBe(true)
    expect(backlinks).toMatchObject({ pages: expect.arrayContaining([expect.objectContaining({ slug: 'new-page' })]) })
  })

  it('rejects invalid tool inputs and validates JSON-renderer panel specs', async () => {
    const tools = await createRegisteredLivingWikiTools()
    const ctx = toolContext()

    expect(tools['readWikiPage']!.input.safeParse({ slug: '../agent-harness' }).success).toBe(false)
    await expect(tools['readWikiPage']!.handler(ctx, { slug: '../agent-harness' })).rejects.toThrow(/slug/i)

    const panelSpec = {
      type: 'article',
      title: 'Lint Report',
      children: [{ type: 'text', text: 'No weak claims found.' }]
    }
    const rendered = await tools['renderPanelSpec']!.handler(ctx, { panelSpec })
    expect(tools['renderPanelSpec']!.output.safeParse(rendered).success).toBe(true)
    expect(rendered).toEqual({ panelSpec })
  })
})
