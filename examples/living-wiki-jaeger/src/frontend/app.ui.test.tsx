import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewRequestFixture } from './__fixtures__/reviewRequest.js'

async function loadAppModule() {
  const appModulePath = './App.js'
  return import(appModulePath) as Promise<{
    App: React.ComponentType
  }>
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = []
  static events: unknown[] = [
    { type: 'run.finished', outcome: { status: 'completed', output: { answer: 'Fake answer' } } }
  ]
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly url: string
  readyState = 0

  constructor(url: string) {
    super()
    this.url = url
    FakeEventSource.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event('open'))
      for (const event of FakeEventSource.events) {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }))
      }
    })
  }

  close() {
    this.readyState = 2
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function standardChatResponse(text: string): Response {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute({ writer }) {
        writer.write({ type: 'start', messageId: 'assistant-standard' })
        writer.write({ type: 'start-step' })
        writer.write({ type: 'text-start', id: 'answer-text' })
        writer.write({ type: 'text-delta', id: 'answer-text', delta: text })
        writer.write({ type: 'text-end', id: 'answer-text' })
        writer.write({ type: 'finish-step' })
        writer.write({ type: 'finish', finishReason: 'stop' })
      },
    }),
  })
}

function approvalChatResponse(): Response {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute({ writer }) {
        writer.write({ type: 'start', messageId: 'assistant-approval' })
        writer.write({ type: 'start-step' })
        writer.write({ type: 'tool-input-available', toolCallId: 'write-call', toolName: 'writeWikiPage', input: { slug: 'jaeger' }, dynamic: true })
        writer.write({
          type: 'tool-approval-request',
          approvalId: 'approval-1',
          toolCallId: 'write-call',
          approvalDescriptor: {
            protocol: 'purista-harness/tool-approval',
            version: 1,
            rootRunId: 'root-run',
            agentRunId: 'agent-run',
            sessionId: 'living-wiki-chat',
            interruptId: 'interrupt-1',
            revision: 'revision-1',
            eventId: 'event-1',
            approvalIds: ['approval-1'],
          },
          reason: 'wiki_write',
        })
        writer.write({ type: 'finish-step' })
        writer.write({ type: 'finish', finishReason: 'tool-calls' })
      },
    }),
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
  FakeEventSource.events = [
    { type: 'run.finished', outcome: { status: 'completed', output: { answer: 'Fake answer' } } }
  ]
})

describe('living wiki UI', () => {
  it('loads the fake backend, shows wiki/source navigation, and renders a completed workflow', async () => {
    FakeEventSource.events = [
      { type: 'output.text.delta', delta: 'Fake ' },
      { type: 'output.text.delta', delta: 'answer' },
      { type: 'run.finished', outcome: { status: 'completed', output: { answer: 'Fake answer' } } }
    ]
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/health')) return jsonResponse({ status: 'ok', model: 'fake-wiki-model' })
      if (url.endsWith('/api/pages')) {
        return jsonResponse({
          pages: [
            { slug: 'agent-harness', title: 'Agent Harness', summary: 'Harness flow.' },
            { slug: 'jaeger-tracing', title: 'Jaeger Tracing', summary: 'Trace local runs.' }
          ]
        })
      }
      if (url.endsWith('/api/pages/agent-harness')) {
        return jsonResponse({ slug: 'agent-harness', title: 'Agent Harness', content: '# Agent Harness\n\nSee [[jaeger-tracing]].' })
      }
      if (url.endsWith('/api/sources')) {
        return jsonResponse({ sources: [{ slug: 'harness-flow', title: 'Harness Flow' }] })
      }
      if (url.endsWith('/api/sources/harness-flow')) {
        return jsonResponse({ slug: 'harness-flow', title: 'Harness Flow', content: '# Harness Flow\n\nSource content.' })
      }
      if (url.endsWith('/api/graph')) {
        return jsonResponse({
          nodes: [{ slug: 'agent-harness', title: 'Agent Harness', degree: 1 }],
          edges: [{ from: 'agent-harness', to: 'jaeger-tracing' }],
          mermaid: 'graph LR\n  agent_harness["Agent Harness"] --> jaeger_tracing["Jaeger Tracing"]',
          panelSpec: { version: '1.0', title: 'Knowledge Map', sections: [] }
        })
      }
      if (url.endsWith('/api/workflows/ask_wiki') && init?.method === 'POST') {
        return jsonResponse({ runId: 'run_fake_1', status: 'running' }, 202)
      }
      if (url.endsWith('/api/runs/run_fake_1')) {
        return jsonResponse({
          runId: 'run_fake_1',
          status: 'completed',
          result: { answer: 'Fake answer', citedPages: ['agent-harness'], confidenceNotes: [] },
          trace: { traceId: 'trace_fake_1', jaegerUrl: 'http://localhost:16686/trace/trace_fake_1' }
        })
      }
      throw new Error(`Unhandled fetch ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const { App } = await loadAppModule()
    render(<App />)

    expect(await screen.findByText('Mission Board')).toBeTruthy()
    expect(await screen.findByText('Agent Harness')).toBeTruthy()
    expect(await screen.findByText('Harness Flow')).toBeTruthy()
    expect(await screen.findByText(/fake-wiki-model/i)).toBeTruthy()

    const workflowButton = await screen.findByRole('button', { name: /ask wiki/i })
    fireEvent.click(workflowButton)

    await waitFor(() => {
      expect(FakeEventSource.instances[0]?.url).toContain('/api/runs/run_fake_1/events')
    })
    expect(await screen.findByText(/Fake answer/i)).toBeTruthy()
    expect(screen.queryByLabelText(/human review request/i)).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /run console/i }))
    expect(await screen.findByText(/trace_fake_1/i)).toBeTruthy()
  })

  it('uses the standard AI SDK UI transport for direct chat', async () => {
    let chatRequest: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/health')) return jsonResponse({ status: 'ok', model: 'fake-wiki-model' })
      if (url.endsWith('/api/pages')) return jsonResponse({ pages: [] })
      if (url.endsWith('/api/sources')) return jsonResponse({ sources: [] })
      if (url.endsWith('/api/graph')) return jsonResponse({ nodes: [], edges: [], panelSpec: { version: '1.0', title: 'Knowledge Map', sections: [] } })
      if (url.endsWith('/api/chat') && init?.method === 'POST') {
        chatRequest = JSON.parse(String(init.body)) as Record<string, unknown>
        return standardChatResponse('Standard streamed answer')
      }
      throw new Error(`Unhandled fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const { App } = await loadAppModule()
    render(<App />)
    await screen.findByText('Mission Board')
    fireEvent.change(screen.getByPlaceholderText(/ask the wiki/i), { target: { value: 'Use the standard transport' } })
    fireEvent.click(screen.getByRole('button', { name: /send message/i }))

    expect(await screen.findByText('Standard streamed answer')).toBeTruthy()
    expect(chatRequest).toMatchObject({ id: 'living-wiki-chat', trigger: 'submit-message' })
    expect(JSON.stringify(chatRequest)).toContain('Use the standard transport')
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('returns standard tool approval responses through the AI SDK transport', async () => {
    const chatRequests: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/health')) return jsonResponse({ status: 'ok', model: 'fake-wiki-model' })
      if (url.endsWith('/api/pages')) return jsonResponse({ pages: [] })
      if (url.endsWith('/api/sources')) return jsonResponse({ sources: [] })
      if (url.endsWith('/api/graph')) return jsonResponse({ nodes: [], edges: [], panelSpec: { version: '1.0', title: 'Knowledge Map', sections: [] } })
      if (url.endsWith('/api/chat') && init?.method === 'POST') {
        chatRequests.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return chatRequests.length === 1 ? approvalChatResponse() : standardChatResponse('Write approved')
      }
      throw new Error(`Unhandled fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const { App } = await loadAppModule()
    render(<App />)
    await screen.findByText('Mission Board')
    fireEvent.change(screen.getByPlaceholderText(/ask the wiki/i), { target: { value: 'Update the Jaeger page' } })
    fireEvent.click(screen.getByRole('button', { name: /send message/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }))

    expect(await screen.findByText('Write approved')).toBeTruthy()
    await waitFor(() => expect(chatRequests).toHaveLength(2))
    expect(JSON.stringify(chatRequests[1])).toContain('"approved":true')
    expect(JSON.stringify(chatRequests[1])).toContain('purista-harness/tool-approval')
  })

  it('renders tools, artifacts, and review UI only from backend payloads', async () => {
    FakeEventSource.events = [
      { type: 'tool.started', callId: 'tool_1', toolId: 'search_wiki', input: { query: 'trace' } },
      { type: 'tool.finished', callId: 'tool_1', toolId: 'search_wiki', output: { hits: 2 } },
      { type: 'run.finished', outcome: { status: 'completed', output: {} } }
    ]
    const decisions: unknown[] = []
    const answers: unknown[] = []
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/health')) return jsonResponse({ status: 'ok', model: 'fake-wiki-model' })
      if (url.endsWith('/api/pages')) return jsonResponse({ pages: [{ slug: 'agent-harness', title: 'Agent Harness', summary: 'Harness flow.' }] })
      if (url.endsWith('/api/pages/agent-harness')) return jsonResponse({ slug: 'agent-harness', title: 'Agent Harness', content: '# Agent Harness\n\nContent.' })
      if (url.endsWith('/api/sources')) return jsonResponse({ sources: [] })
      if (url.endsWith('/api/graph')) return jsonResponse({ nodes: [], edges: [], highlights: [], panelSpec: { version: '1.0', title: 'Knowledge Map', sections: [] } })
      if (url.endsWith('/api/workflows/wiki_audit') && init?.method === 'POST') return jsonResponse({ runId: 'run_fake_1', status: 'running' }, 202)
      if (url.endsWith('/api/runs/run_fake_1')) {
        return jsonResponse({
          runId: 'run_fake_1',
          status: 'completed',
          result: {
            answer: 'Review the packet.',
            reviewRequest: reviewRequestFixture,
            artifacts: [
              { kind: 'markdown', title: 'Review Artifact', content: '## Artifact notes\n\nReady for review.' },
              { kind: 'drawio_xml', title: 'System Diagram', content: '<mxfile><diagram><svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg></diagram></mxfile>', url: 'https://example.test/system.drawio' }
            ]
          }
        })
      }
      if (url.endsWith('/api/reviews/run_fake_1/decision') && init?.method === 'POST') {
        decisions.push(JSON.parse(String(init.body)))
        return jsonResponse({ status: 'applied' })
      }
      if (url.endsWith('/api/reviews/run_fake_1/answer') && init?.method === 'POST') {
        answers.push(JSON.parse(String(init.body)))
        return jsonResponse({ accepted: true })
      }
      throw new Error(`Unhandled fetch ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const { App } = await loadAppModule()
    render(<App />)

    expect(await screen.findByText('Agent Harness')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(/ask the wiki/i), { target: { value: 'Needs review' } })
    fireEvent.click(screen.getByRole('button', { name: /wiki audit/i }))

    expect(await screen.findByText(/Tools used: search_wiki/i)).toBeTruthy()
    expect(await screen.findByText(/Review Artifact/i)).toBeTruthy()
    expect(await screen.findByText(/System Diagram/i)).toBeTruthy()
    expect(screen.getByRole('tab', { name: /preview/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /open system diagram/i }).getAttribute('href')).toBe('https://example.test/system.drawio')
    fireEvent.click(screen.getByRole('tab', { name: /xml/i }))
    expect(await screen.findByText(/mxfile/i)).toBeTruthy()
    expect(await screen.findByLabelText(/human review request/i)).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/revise first/i))
    await waitFor(() => {
      expect(answers).toHaveLength(1)
    })
    expect(await screen.findByText(/Answered: Publish the proposed wiki changes/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }))

    await waitFor(() => {
      expect(decisions).toHaveLength(1)
    })
    expect(decisions[0]).toMatchObject({ reviewRequestId: 'review_fixture_1', decision: 'custom_guidance', guidance: 'Revision requested from review controls.' })
  })
})
