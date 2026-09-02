import { type CSSProperties, type PointerEvent, Suspense, lazy, useEffect, useState } from 'react'
import JsonRenderer from 'json-renderer'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, BookOpen, BrainCircuit, CheckCircle2, Compass, Database, FileText, GitBranch, Network, PanelRightOpen, PauseCircle, Play, Radio, Save, ShieldCheck, Sparkles, Upload, Wifi, WifiOff, Workflow, X } from 'lucide-react'
import { ArtifactList, type ResearchArtifact } from './components/artifacts/ArtifactRenderer.js'
import { Conversation, ConversationContent, ConversationEmptyState } from './components/ai-elements/conversation.js'
import { Message, MessageContent, MessageResponse } from './components/ai-elements/message.js'
import { PromptInput, PromptInputActionAddAttachments, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools, type ChatStatus } from './components/ai-elements/prompt-input.js'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState } from './components/ai-elements/tool.js'
import { ReviewRequestPanel, isReviewRequest, type ReviewDecisionPayload, type ReviewRequest } from './components/review/ReviewRequestPanel.js'
import { adaptRunEvent, mergeTool, readArtifacts, readReviewRequest, type RunEvent, type SseState, type ToolIndicator } from './streamAdapter.js'

const MermaidDiagram = lazy(() => import('./MermaidDiagram.js'))
const KnowledgeGraph3D = lazy(() => import('./KnowledgeGraph3D.js'))

type PageRef = { slug: string; title: string; summary?: string }
type SourceRef = { slug: string; title: string; summary?: string }
type DocumentView = { kind: 'page' | 'source'; slug: string; title: string; content: string }
type RunInfo = {
  runId: string
  kind?: 'workflow' | 'agent'
  targetId?: string
  workflowId?: string
  status: string
  result?: Record<string, unknown>
  error?: unknown
  trace?: { traceId: string; jaegerUrl: string }
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'pending' | 'streaming' | 'done' | 'failed'
  panelSpec?: unknown
  artifacts?: ResearchArtifact[]
}

type KnowledgeGraph = {
  nodes: Array<{ id?: string; slug?: string; ref?: string; label?: string; title?: string; summary?: string; kind?: 'page' | 'source' | 'concept' | 'artifact'; degree?: number }>
  edges: Array<{ id?: string; from?: string; to?: string; source?: string; target?: string; kind?: string; weight?: number }>
  highlights?: Array<{ nodeIds: string[]; edgeIds: string[]; kind: string; label: string }>
  mermaid?: string
  panelSpec: unknown
}

const workflows = [
  { id: 'ingest_source', label: 'Ingest Source', description: 'Turn an uploaded source into editable wiki knowledge.' },
  { id: 'ask_wiki', label: 'Ask Wiki', description: 'Answer a question with citations from local pages.' },
  { id: 'lint_wiki', label: 'Lint Wiki', description: 'Check wiki quality, gaps, and stale wording.' },
  { id: 'reconcile_contradiction', label: 'Reconcile', description: 'Resolve conflicting claims with a reviewable decision.' },
  { id: 'generate_research_brief', label: 'Research Brief', description: 'Produce a decision-ready artifact from selected pages.' },
  { id: 'decision_memo', label: 'Decision Memo', description: 'Use planner, critic, and judge skills to recommend a path.' },
  { id: 'architecture_review', label: 'Architecture Review', description: 'Generate Mermaid, draw.io XML, JSON panels, and review gates.' },
  { id: 'wiki_audit', label: 'Wiki Audit', description: 'Find stale claims and propose governed wiki updates.' }
]

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  return response.json() as Promise<T>
}

function workflowPayload(id: string, selected?: DocumentView, prompt = ''): Record<string, unknown> {
  const slug = selected?.slug ?? 'agent-harness'
  switch (id) {
    case 'ingest_source':
      return { sourceSlug: selected?.kind === 'source' ? selected.slug : 'harness-flow' }
    case 'lint_wiki':
      return { scope: 'all' }
    case 'reconcile_contradiction':
      return { leftRef: slug, rightRef: 'jaeger-tracing', conflict: prompt || 'Conflicting wording needs reconciliation.' }
    case 'generate_research_brief':
      return { pageSlugs: [selected?.kind === 'page' ? selected.slug : 'agent-harness'], goal: prompt || 'Summarize operational traceability.' }
    case 'decision_memo':
      return { proposal: prompt || 'Adopt the Living Wiki Studio workflow for architecture research.', question: 'Should this harness pattern be piloted?' }
    case 'architecture_review':
      return { pageSlug: selected?.kind === 'page' ? selected.slug : 'agent-harness', focus: prompt || 'Review module boundaries, adapters, tracing, MCP tools, and artifact generation.' }
    case 'wiki_audit':
      return { scope: 'all' }
    default:
      return { question: prompt || 'What does this wiki know about Jaeger tracing?' }
  }
}

function agentPayload(id: string, selected?: DocumentView, prompt = ''): Record<string, unknown> {
  const slug = selected?.slug ?? 'agent-harness'
  switch (id) {
    case 'wiki_curator':
      return { sourceSlug: selected?.kind === 'source' ? selected.slug : 'harness-flow' }
    case 'wiki_linter':
      return { scope: 'all' }
    case 'wiki_reconciler':
      return { leftRef: slug, rightRef: 'jaeger-tracing', conflict: prompt || 'Conflicting wording needs reconciliation.' }
    case 'wiki_brief_writer':
      return { pageSlugs: [selected?.kind === 'page' ? selected.slug : 'agent-harness'], goal: prompt || 'Summarize operational traceability.' }
    default:
      return { question: prompt || 'What does this wiki know about Jaeger tracing?' }
  }
}

function panelSiteJson(panel: unknown) {
  const record = panel && typeof panel === 'object' ? panel as { title?: unknown; sections?: unknown } : {}
  const sections = Array.isArray(record.sections) ? record.sections as Array<{ heading?: string; items?: string[] }> : []
  return {
    version: '1.0' as const,
    meta: { title: String(record.title ?? 'Structured Output'), description: '', favicon: null, fonts: [] },
    globalStyles: {
      bodyBackground: 'transparent',
      bodyColor: '#1f2937',
      bodyFontFamily: 'Inter, system-ui, sans-serif',
      bodyFontSize: '13px',
      bodyLineHeight: '1.5',
      linkColor: '#2563eb',
      linkHoverColor: '#1d4ed8'
    },
    pages: [{
      id: 'panel',
      name: 'Panel',
      slug: '/',
      isHome: true,
      root: {
        id: 'root',
        tag: 'section',
        style: { display: 'grid', gap: '10px' },
        children: [
          { id: 'title', tag: 'h3', style: { margin: '0', fontSize: '14px' }, textContent: String(record.title ?? 'Structured Output') },
          ...sections.map((section, index) => ({
            id: `section-${index}`,
            tag: 'div',
            style: { display: 'grid', gap: '4px' },
            children: [
              { id: `heading-${index}`, tag: 'strong', style: { fontSize: '12px' }, textContent: section.heading ?? 'Section' },
              ...(section.items ?? []).map((item, itemIndex) => ({
                id: `item-${index}-${itemIndex}`,
                tag: 'p',
                style: { margin: '0', fontSize: '12px' },
                textContent: item
              }))
            ]
          }))
        ]
      }
    }]
  }
}

function markdownWithWikiLinks(markdown: string): string {
  return markdown.replace(/\[\[([a-z0-9][a-z0-9-]{0,79})\]\]/g, (_match, slug: string) => `[${slug}](#wiki-${slug})`)
}

function withoutLeadingHeading(markdown: string): string {
  return markdown.replace(/^#\s+.+(?:\r?\n){1,2}/, '').trimStart()
}

function MarkdownView(props: { markdown: string; onWikiLink?: (slug: string) => void; compact?: boolean }) {
  const components: Components = {
    code: ({ className, children, ...codeProps }) => {
      const code = String(children ?? '')
      if (className?.includes('language-mermaid')) {
        return <Suspense fallback={<pre>Rendering diagram...</pre>}><MermaidDiagram code={code} /></Suspense>
      }
      return <code className={className} {...codeProps}>{children}</code>
    },
    a: ({ href, children, ...anchorProps }) => {
      if (href?.startsWith('#wiki-')) {
        const slug = href.slice('#wiki-'.length)
        return (
          <button className="wiki-link" type="button" onClick={() => props.onWikiLink?.(slug)}>
            {children}
          </button>
        )
      }
      return <a href={href} target={href?.startsWith('http') ? '_blank' : undefined} rel={href?.startsWith('http') ? 'noreferrer' : undefined} {...anchorProps}>{children}</a>
    }
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
    >
      {markdownWithWikiLinks(props.markdown)}
    </ReactMarkdown>
  )
}

export function App() {
  const [model, setModel] = useState('loading')
  const [pages, setPages] = useState<PageRef[]>([])
  const [sources, setSources] = useState<SourceRef[]>([])
  const [selected, setSelected] = useState<DocumentView | undefined>()
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [run, setRun] = useState<RunInfo | undefined>()
  const [events, setEvents] = useState<RunEvent[]>([])
  const [sseState, setSseState] = useState<SseState>('idle')
  const [overflow, setOverflow] = useState(0)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { id: 'welcome', role: 'assistant', content: 'Welcome. Ask a direct agent for a cited answer, or run a workflow to ingest sources, review decisions, and produce artifacts.', status: 'done' }
  ])
  const [activeTools, setActiveTools] = useState<ToolIndicator[]>([])
  const [chatBusy, setChatBusy] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [chatWidth, setChatWidth] = useState<number | undefined>()
  const [uploading, setUploading] = useState(false)
  const [viewMode, setViewMode] = useState<'document' | 'map'>('document')
  const [graph, setGraph] = useState<KnowledgeGraph | undefined>()
  const [reviewRequest, setReviewRequest] = useState<ReviewRequest | undefined>()
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [runArtifacts, setRunArtifacts] = useState<ResearchArtifact[]>([])

  useEffect(() => {
    void (async () => {
      const [health, pageList, sourceList] = await Promise.all([
        apiJson<{ model: string }>('/api/health'),
        apiJson<{ pages: PageRef[] }>('/api/pages'),
        apiJson<{ sources: SourceRef[] }>('/api/sources')
      ])
      setModel(health.model)
      setPages(pageList.pages)
      setSources(sourceList.sources)
      await refreshGraph()
    })()
  }, [])

  async function refreshGraph() {
    setGraph(await apiJson<KnowledgeGraph>('/api/graph'))
  }

  async function openPage(slug: string) {
    const page = await apiJson<DocumentView>(`/api/pages/${slug}`)
    setSelected({ ...page, kind: 'page' })
    setDraft(page.content)
    setEditing(false)
    setViewMode('document')
  }

  async function openSource(slug: string) {
    const source = await apiJson<DocumentView>(`/api/sources/${slug}`)
    setSelected({ ...source, kind: 'source' })
    setDraft(source.content)
    setEditing(false)
    setViewMode('document')
  }

  async function savePage() {
    if (!selected || selected.kind !== 'page') return
    const page = await apiJson<DocumentView>(`/api/pages/${selected.slug}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: draft })
    })
    setSelected({ ...page, kind: 'page' })
    setEditing(false)
    await refreshGraph()
  }

  async function uploadSource(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const source = await apiJson<DocumentView>('/api/sources/upload', { method: 'POST', body: form })
      setSources((current) => [...current.filter((item) => item.slug !== source.slug), source].sort((a, b) => a.slug.localeCompare(b.slug)))
      const uploaded = { ...source, kind: 'source' as const }
      setSelected(uploaded)
      setDraft(uploaded.content)
      await runWorkflow('ingest_source', uploaded, `Ingest ${uploaded.title}`)
    } finally {
      setUploading(false)
    }
  }

  function startChatResize(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = chatWidth ?? Math.max(420, Math.floor((window.innerWidth - 288) / 2))
    const onMove = (moveEvent: globalThis.PointerEvent) => setChatWidth(Math.min(900, Math.max(360, startWidth - (moveEvent.clientX - startX))))
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  async function runWorkflow(id: string, selectedOverride = selected, promptOverride = prompt) {
    setSseState('invoking workflow')
    setEvents([])
    setOverflow(0)
    setActiveTools([])
    setReviewRequest(undefined)
    setRunArtifacts([])
    const workflow = workflows.find((item) => item.id === id)
    const userMessage = id === 'ask_wiki'
      ? promptOverride || 'What does this wiki know about Jaeger tracing?'
      : promptOverride || `${workflow?.label ?? id}${selectedOverride ? ` for ${selectedOverride.title}` : ''}`
    const assistantMessageId = crypto.randomUUID()
    setChatBusy(true)
    setChatMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: userMessage, status: 'done' },
      { id: assistantMessageId, role: 'assistant', content: '', status: 'pending' }
    ])
    const started = await apiJson<RunInfo>(`/api/workflows/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowPayload(id, selectedOverride, promptOverride))
    })
    setRun(started)
    if (id === 'ask_wiki') setPrompt('')
    subscribe(started.runId, assistantMessageId)
  }

  async function runAgent(id: string, selectedOverride = selected, promptOverride = prompt) {
    setSseState('invoking agent')
    setEvents([])
    setOverflow(0)
    setActiveTools([])
    setReviewRequest(undefined)
    setRunArtifacts([])
    const userMessage = promptOverride || 'What does this wiki know about Jaeger tracing?'
    const assistantMessageId = crypto.randomUUID()
    setChatBusy(true)
    setChatMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: userMessage, status: 'done' },
      { id: assistantMessageId, role: 'assistant', content: '', status: 'pending' }
    ])
    const started = await apiJson<RunInfo>(`/api/agents/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(agentPayload(id, selectedOverride, promptOverride))
    })
    setRun(started)
    if (id === 'wiki_answerer') setPrompt('')
    subscribe(started.runId, assistantMessageId)
  }

  function subscribe(runId: string, assistantMessageId: string) {
    const source = new EventSource(`/api/runs/${runId}/events`)
    source.onopen = () => setSseState('SSE connected')
    source.onerror = () => setSseState((current) => current === 'completed' || current === 'failed' || current === 'cancelled' ? current : 'SSE reconnecting')
    source.onmessage = async (message) => {
      const event = JSON.parse(message.data) as RunEvent
      setEvents((current) => [...current, event])
      for (const update of adaptRunEvent(event)) {
        if (update.kind === 'overflow') setOverflow((current) => current + update.dropped)
        if (update.kind === 'tool') setActiveTools((current) => mergeTool(current, update.tool))
        if (update.kind === 'answer_delta') {
          setChatMessages((current) => current.map((item) => item.id === assistantMessageId
            ? { ...item, content: `${item.content}${update.delta}`, status: 'streaming' }
            : item))
        }
        if (update.kind === 'review' && isReviewRequest(update.reviewRequest)) setReviewRequest(update.reviewRequest)
        if (update.kind === 'artifacts') setRunArtifacts(normalizeArtifacts(update.artifacts))
      }
      if (event.type === 'run.finished' || event.type === 'run.failed') {
        source.close()
        const terminalState = event.type === 'run.failed'
          ? event.error?.message?.toLowerCase().includes('cancel') ? 'cancelled' : 'failed'
          : event.outcome?.status === 'interrupted' ? 'interrupted' : 'completed'
        setSseState(terminalState)
        const lookup = await apiJson<RunInfo>(`/api/runs/${runId}`)
        setRun(lookup)
        setChatBusy(false)
        const resultReviewRequest = readReviewRequest(lookup.result)
        if (isReviewRequest(resultReviewRequest)) setReviewRequest(resultReviewRequest)
        const artifacts = normalizeArtifacts(readArtifacts(lookup.result))
        setRunArtifacts(artifacts)
        if (event.type === 'run.failed') {
          setChatMessages((current) => current.map((item) => item.id === assistantMessageId ? { ...item, content: event.error?.message ?? 'Workflow failed.', status: 'failed' } : item))
        } else {
          const finalAnswer = answerFromResult(lookup.result) ?? 'Workflow completed.'
          setChatMessages((current) => current.map((item) => item.id === assistantMessageId
            ? { ...item, content: item.content.trim() ? item.content : finalAnswer, status: 'done', ...(lookup.result?.['panelSpec'] ? { panelSpec: lookup.result['panelSpec'] } : {}), ...(artifacts.length > 0 ? { artifacts } : {}) }
            : item))
        }
      }
    }
  }

  async function submitReviewDecision(decision: ReviewDecisionPayload) {
    if (!reviewRequest) return
    setReviewSubmitting(true)
    try {
      const reviewRunId = run?.runId ?? reviewRequest.runId
      await apiJson(`/api/reviews/${reviewRunId}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decision)
      })
      setReviewRequest(undefined)
      setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: reviewDecisionMessage(decision), status: 'done' }, { id: crypto.randomUUID(), role: 'assistant', content: 'Review decision submitted.', status: 'done' }])
    } catch (error) {
      setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: `Review decision captured locally. ${error instanceof Error ? error.message : ''}`.trim(), status: 'done' }])
    } finally {
      setReviewSubmitting(false)
    }
  }

  async function submitReviewAnswer(questionId: string, value: string | string[] | boolean) {
    if (!reviewRequest) return
    const question = reviewRequest.questions.find((candidate) => candidate.id === questionId)
    setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: `Answered: ${question?.label ?? questionId} -> ${formatReviewValue(value, question)}`, status: 'done' }])
    try {
      const reviewRunId = run?.runId ?? reviewRequest.runId
      await apiJson(`/api/reviews/${reviewRunId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewRequestId: reviewRequest.id, questionId, value })
      })
    } catch (error) {
      setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: `Review answer could not be sent. ${error instanceof Error ? error.message : ''}`.trim(), status: 'failed' }])
    }
  }

  function cancelEdit() {
    setDraft(selected?.content ?? '')
    setEditing(false)
  }

  async function cancelRun() {
    if (!run?.runId) return
    await apiJson(`/api/runs/${run.runId}/cancel`, { method: 'POST' })
    setSseState('cancelled')
  }

  const panelSpec = run?.result?.['panelSpec']

  return (
    <div className="wiki-app" style={(chatWidth ? { '--chat-width': `${chatWidth}px` } : {}) as CSSProperties}>
      <aside className="sidebar">
        <header className="brand"><BookOpen size={18} /> Living Wiki Studio <span>{model}</span></header>
        <button className="start-row" type="button" onClick={() => { setSelected(undefined); setEditing(false); setViewMode('document') }}>
          <Compass size={15} />
          Start here
        </button>
        <section className="showcase-card" aria-label="What this example showcases">
          <strong>Mission controls</strong>
          <p>Use agents for cited answers, workflows for governed wiki changes, and the run console for traceable tool evidence.</p>
          <div>
            <span><Bot size={12} /> Agents</span>
            <span><Workflow size={12} /> Workflows</span>
            <span><Network size={12} /> Graph</span>
          </div>
        </section>
        <section>
          <h2><FileText size={14} /> Wiki</h2>
          {pages.map((page) => <button className="nav-row" key={page.slug} onClick={() => void openPage(page.slug)}>{page.title}</button>)}
        </section>
        <section>
          <h2><Database size={14} /> Sources</h2>
          <label className="upload-source">
            <Upload size={14} />
            {uploading ? 'Uploading...' : 'Upload source'}
            <input type="file" accept=".md,.markdown,text/markdown,text/plain" disabled={uploading} onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void uploadSource(file)
            }} />
          </label>
          {sources.map((source) => <button className="nav-row" key={source.slug} onClick={() => void openSource(source.slug)}>{source.title}</button>)}
        </section>
        <section>
          <h2><Play size={14} /> Scenarios</h2>
          <div className="workflow-grid">
            {workflows.map((workflow) => (
              <button key={workflow.id} onClick={() => void runWorkflow(workflow.id)}>
                <strong>{workflow.label}</strong>
                <span>{workflow.description}</span>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <main className="document-pane">
        {selected ? (
          <div className="doc-toolbar">
            <div>
              <span className="kind">{selected.kind}</span>
              <h1>{selected.title}</h1>
            </div>
            {selected.kind === 'page' && (
              <div className="toolbar-actions">
                <button onClick={() => { setViewMode('map'); void refreshGraph() }}><Network size={15} /> Map</button>
                {editing
                  ? <>
                    <button onClick={cancelEdit}><X size={15} /> Cancel</button>
                    <button onClick={() => void savePage()}><Save size={15} /> Save</button>
                  </>
                  : <button onClick={() => { setViewMode('document'); setEditing(true) }}><FileText size={15} /> Edit</button>}
              </div>
            )}
          </div>
        ) : null}
        {!selected && viewMode !== 'map'
          ? <WelcomeWorkspace
              pageCount={pages.length}
              sourceCount={sources.length}
              model={model}
              openFirstPage={() => { if (pages[0]) void openPage(pages[0].slug) }}
              openGraph={() => { setSelected(undefined); setViewMode('map'); void refreshGraph() }}
              askAgent={() => void runAgent('wiki_answerer', selected, 'What are the most important capabilities in this workspace? Cite the pages you use.')}
              runBrief={() => void runWorkflow('generate_research_brief', selected, 'Create a decision-ready brief about how the harness uses agents, tools, tracing, and reviews.')}
              runArchitectureReview={() => void runWorkflow('architecture_review', selected, 'Review module boundaries, adapters, tracing, MCP tools, draw.io artifacts, and JSON-rendered panels.')}
              runAudit={() => void runWorkflow('wiki_audit', selected, 'Audit the wiki and propose safe governed updates.')}
            />
          : viewMode === 'map'
          ? <KnowledgeMap {...(graph ? { graph } : {})} openPage={(slug) => void openPage(slug)} />
          : editing
          ? <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
          : <section className="markdown-shell"><MarkdownView markdown={selected ? withoutLeadingHeading(selected.content) : 'Select a page or source.'} onWikiLink={(slug) => void openPage(slug)} /></section>}
      </main>

      <div className="column-resizer" role="separator" aria-label="Resize chat panel" onPointerDown={startChatResize} />

      <aside className="chat-rail">
        <ChatPanel
          messages={chatMessages}
          prompt={prompt}
          setPrompt={setPrompt}
          busy={chatBusy}
          tools={activeTools}
          sseState={sseState}
          openInspector={() => setInspectorOpen(true)}
          onAttach={(file) => void uploadSource(file)}
          reviewSubmitting={reviewSubmitting}
          submitReview={(decision) => void submitReviewDecision(decision)}
          submitReviewAnswer={(questionId, value) => void submitReviewAnswer(questionId, value)}
          runWorkflow={() => void runAgent('wiki_answerer')}
          {...(reviewRequest ? { reviewRequest } : {})}
        />
      </aside>

      {inspectorOpen && (
        <div className="drawer-backdrop" onClick={() => setInspectorOpen(false)}>
          <aside className="inspector drawer" onClick={(event) => event.stopPropagation()}>
            <header>
              <span><Radio size={16} /> Run Console</span>
              <button type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}><X size={15} /></button>
            </header>
            <div className="console-summary">
              <div className="status"><StatusIcon state={sseState} /> {sseState}</div>
              <span>{run?.runId ?? 'No active run'}</span>
            </div>
            {run?.trace && <a className="trace-link" href={run.trace.jaegerUrl} target="_blank" rel="noreferrer">{run.trace.traceId}</a>}
            {overflow > 0 && <p className="warning">Overflow notice: {overflow} events dropped.</p>}
            <button onClick={() => void cancelRun()} disabled={!run || sseState !== 'SSE connected'}><PauseCircle size={15} /> Cancel</button>
            <section>
              <h2>Event timeline</h2>
              <div className="events">{events.map((event, index) => <code key={`${event.type}-${index}`}>{event.type}</code>)}</div>
            </section>
            <section>
              <h2>Artifacts and output</h2>
              {panelSpec ? <JsonRenderer siteJson={panelSiteJson(panelSpec)} data={{}} /> : <pre>{JSON.stringify(outputSummary(run?.result), null, 2)}</pre>}
              <ArtifactList artifacts={runArtifacts} compact />
            </section>
          </aside>
        </div>
      )}
    </div>
  )
}

function WelcomeWorkspace(props: {
  pageCount: number
  sourceCount: number
  model: string
  openFirstPage: () => void
  openGraph: () => void
  askAgent: () => void
  runBrief: () => void
  runArchitectureReview: () => void
  runAudit: () => void
}) {
  const status = props.model === 'loading' ? 'Connecting runtime' : 'Runtime connected'
  return (
    <section className="welcome-workspace" aria-label="Living Wiki mission board">
      <div className="mission-board">
        <div className="mission-brief">
          <div className="mission-label"><Sparkles size={14} /> Mission Board</div>
          <h1>Living Wiki Studio</h1>
          <p>
            Run governed wiki missions from one workspace: ask a cited agent, ingest sources behind review gates,
            inspect tool evidence, and publish durable research artifacts.
          </p>
          <div className="mission-actions">
            <button type="button" className="primary-action" onClick={props.askAgent}><Bot size={16} /> Ask agent</button>
            <button type="button" onClick={props.runBrief}><BrainCircuit size={16} /> Run brief</button>
            <button type="button" onClick={props.openGraph}><GitBranch size={16} /> Open graph</button>
          </div>
        </div>
        <div className="mission-status" aria-label="Runtime status">
          <div>
            <strong>{status}</strong>
            <span>{props.pageCount + props.sourceCount} knowledge objects ready</span>
          </div>
          <dl>
            <div><dt>Pages</dt><dd>{props.pageCount}</dd></div>
            <div><dt>Sources</dt><dd>{props.sourceCount}</dd></div>
            <div><dt>Review</dt><dd>Gate</dd></div>
          </dl>
        </div>
      </div>

      <div className="scenario-grid" aria-label="Mission scenarios">
        <button type="button" className="scenario-card primary" onClick={props.askAgent}>
          <Bot size={18} />
          <strong>Ask a cited question</strong>
          <span>Use when you need a quick answer grounded in wiki pages.</span>
          <em>Starts the wiki answerer agent and streams tool evidence.</em>
        </button>
        <button type="button" className="scenario-card" onClick={props.runBrief}>
          <BrainCircuit size={18} />
          <strong>Build a research brief</strong>
          <span>Use when a decision needs a durable artifact and trace.</span>
          <em>Runs planner, reasoning, review, and artifact rendering steps.</em>
        </button>
        <button type="button" className="scenario-card" onClick={props.runArchitectureReview}>
          <Workflow size={18} />
          <strong>Generate a diagram board</strong>
          <span>Use when architecture needs Mermaid, draw.io XML, and JSON renderer output.</span>
          <em>Exercises diagram skills, optional draw.io/MCP paths, and artifact tabs.</em>
        </button>
        <button type="button" className="scenario-card" onClick={props.runAudit}>
          <ShieldCheck size={18} />
          <strong>Audit and approve changes</strong>
          <span>Use when the wiki needs stale-claim detection and human approval.</span>
          <em>Creates a review request before any page mutation is applied.</em>
        </button>
        <button type="button" className="scenario-card" onClick={props.openGraph}>
          <GitBranch size={18} />
          <strong>Explore relationships</strong>
          <span>Use when you need to understand page/source connections.</span>
          <em>Opens the 3D graph and hub list without starting a run.</em>
        </button>
        <button type="button" className="scenario-card" onClick={props.openFirstPage}>
          <BookOpen size={18} />
          <strong>Review wiki content</strong>
          <span>Use when you want to inspect or edit the seed markdown.</span>
          <em>Opens the first wiki page in the document editor.</em>
        </button>
      </div>

      <div className="capability-strip">
        <span><CheckCircle2 size={14} /> Human review before wiki mutation</span>
        <span><ShieldCheck size={14} /> Skills, MCP/draw.io fallback, and actionable errors</span>
        <span><Network size={14} /> Mermaid, JSON panels, draw.io, and 3D graph</span>
      </div>
    </section>
  )
}

function answerFromResult(result: Record<string, unknown> | undefined): string | undefined {
  return typeof result?.['answer'] === 'string' ? result['answer'] : typeof result?.['markdown'] === 'string' ? result['markdown'] : undefined
}

function formatReviewValue(value: string | string[] | boolean, question?: ReviewRequest['questions'][number]): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  const values = Array.isArray(value) ? value : [value]
  const labels = values.map((item) => question?.options?.find((option) => option.id === item)?.label ?? item).filter(Boolean)
  return labels.join(', ') || 'No answer'
}

function reviewDecisionMessage(decision: ReviewDecisionPayload): string {
  const labels: Record<ReviewDecisionPayload['decision'], string> = {
    accept_all: 'Approve review request',
    reject_all: 'Reject review request',
    accept_selected: 'Approve selected review changes',
    choose_alternative: 'Choose alternative review path',
    custom_guidance: 'Request revision'
  }
  return decision.guidance ? `${labels[decision.decision]}: ${decision.guidance}` : labels[decision.decision]
}

function outputSummary(result: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!result) return {}
  const { answer: _answer, markdown: _markdown, ...rest } = result
  return rest
}

function ChatPanel(props: {
  messages: ChatMessage[]
  prompt: string
  setPrompt: (value: string) => void
  busy: boolean
  tools: ToolIndicator[]
  sseState: SseState
  openInspector: () => void
  onAttach: (file: File) => void
  reviewRequest?: ReviewRequest
  reviewSubmitting: boolean
  submitReview: (decision: ReviewDecisionPayload) => void
  submitReviewAnswer: (questionId: string, value: string | string[] | boolean) => void
  runWorkflow: () => void
}) {
  const status: ChatStatus = props.busy ? 'streaming' : 'ready'
  const lastAssistantIndex = props.messages.findLastIndex((message) => message.role === 'assistant' && message.status !== 'done')
  const toolIndex = lastAssistantIndex >= 0 ? lastAssistantIndex : props.messages.length
  const hasAnswerText = props.messages.some((message) => message.role === 'assistant' && message.content.trim().length > 0 && message.status !== 'pending')
  const collapseTools = hasAnswerText || !props.busy
  return (
    <section className="chat-panel" aria-label="Wiki chat">
      <header className="chat-header">
        <div>
          <span><Bot size={16} /> Agent Console</span>
          <small>Ask, attach sources, and watch tools stream into the run.</small>
        </div>
        <button type="button" onClick={props.openInspector}><PanelRightOpen size={15} /> Run console</button>
      </header>
      <Conversation>
        <ConversationContent>
          {props.messages.length === 0 && <ConversationEmptyState title="Ask the wiki" description="Upload sources, inspect traces, and query local pages." />}
        {props.messages.flatMap((message, index) => [
          ...(index === toolIndex ? [<ToolStrip key="tools" tools={props.tools} collapsed={collapseTools} />] : []),
          <Message key={message.id} from={message.role}>
            <MessageContent>
            {message.status === 'pending' && message.role === 'assistant'
              ? <div className="typing">Thinking</div>
              : message.role === 'assistant'
                ? <MessageResponse><MarkdownView markdown={message.content} compact /></MessageResponse>
                : <p>{message.content}</p>}
            {message.panelSpec ? <div className="chat-rich-panel"><JsonRenderer siteJson={panelSiteJson(message.panelSpec)} data={{}} /></div> : null}
            {message.artifacts ? <ArtifactList artifacts={message.artifacts} compact /> : null}
            </MessageContent>
          </Message>
        ])}
          {toolIndex === props.messages.length && <ToolStrip tools={props.tools} collapsed={collapseTools} />}
          {props.reviewRequest ? <ReviewRequestPanel key={props.reviewRequest.id} request={props.reviewRequest} submitting={props.reviewSubmitting} onSubmit={props.submitReview} onAnswer={props.submitReviewAnswer} /> : null}
        </ConversationContent>
      </Conversation>
      <PromptInput
        accept=".md,.markdown,text/markdown,text/plain"
        onFilesChange={(files) => { if (files[0]) props.onAttach(files[0]) }}
        onSubmit={() => props.runWorkflow()}
      >
        <PromptInputBody>
          <PromptInputTextarea
            autoFocus
            value={props.prompt}
            onChange={(event) => props.setPrompt(event.target.value)}
            placeholder="Ask the wiki, request citations, or attach a source..."
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionAddAttachments label="Source" />
            <span className="mini-status"><StatusIcon state={props.sseState} /> {props.sseState}</span>
          </PromptInputTools>
          <PromptInputSubmit status={status} disabled={props.busy} />
        </PromptInputFooter>
      </PromptInput>
    </section>
  )
}

function ToolStrip(props: { tools: ToolIndicator[]; collapsed: boolean }) {
  if (props.tools.length === 0) return null
  const running = props.tools.filter((tool) => tool.status === 'running').length
  const failed = props.tools.filter((tool) => tool.status === 'failed').length
  const groupedTools = groupTools(props.tools)
  return (
    <details className="tool-list" aria-live="polite" open={!props.collapsed}>
      <summary>{toolSummary(props.tools, running, failed)}</summary>
      <div className="tool-group">
        {groupedTools.map((tool) => {
          const state: ToolState = tool.status === 'failed' ? 'output-error' : tool.status === 'done' ? 'output-available' : 'input-available'
          return (
            <Tool key={tool.id}>
              <ToolHeader type={`tool-${tool.name}`} state={state} toolName={tool.count > 1 ? `${tool.name} x${tool.count}` : tool.name} />
              <ToolContent>
                <ToolInput input={tool.input} />
                <ToolOutput
                  output={tool.output ? <pre>{JSON.stringify(tool.output, null, 2)}</pre> : null}
                  {...(tool.error ? { errorText: tool.error } : {})}
                />
              </ToolContent>
            </Tool>
          )
        })}
      </div>
    </details>
  )
}

function toolSummary(tools: ToolIndicator[], running: number, failed: number): string {
  if (running > 0) return `${running} running, ${tools.length - running} completed`
  if (failed > 0) return `${failed} failed, ${tools.length - failed} completed`
  const names = groupTools(tools).slice(0, 3).map((tool) => tool.count > 1 ? `${tool.name} x${tool.count}` : tool.name)
  return names.length > 0 ? `Tools used: ${names.join(', ')}` : 'Tools completed'
}

function groupTools(tools: ToolIndicator[]): Array<ToolIndicator & { count: number }> {
  const groups = new Map<string, ToolIndicator & { count: number }>()
  for (const tool of tools) {
    const key = `${tool.name}:${tool.status}`
    const existing = groups.get(key)
    groups.set(key, existing ? { ...existing, ...tool, input: existing.input, count: existing.count + 1 } : { ...tool, count: 1 })
  }
  return [...groups.values()]
}

function KnowledgeMap(props: { graph?: KnowledgeGraph; openPage: (slug: string) => void }) {
  if (!props.graph) return <section className="map-shell"><div className="typing">Loading map</div></section>
  const normalizedNodes = props.graph.nodes.map(normalizeGraphNode)
  const topNodes = [...normalizedNodes].sort((a, b) => b.degree - a.degree).slice(0, 6)
  return (
    <section className="map-shell">
      <div className="map-hero">
        <div>
          <h2>Knowledge Graph</h2>
          <p>Visualize relationships between wiki pages, source-derived concepts, and workflow outcomes.</p>
        </div>
        <div className="map-stats">
          <strong>{normalizedNodes.length}</strong><span>nodes</span>
          <strong>{props.graph.edges.length}</strong><span>links</span>
        </div>
      </div>
      <div className="map-grid">
        <div className="map-card graph-card">
          <Suspense fallback={<div className="typing">Rendering map</div>}><KnowledgeGraph3D nodes={normalizedNodes} edges={props.graph.edges} highlights={props.graph.highlights ?? []} onSelect={props.openPage} /></Suspense>
        </div>
        <div className="map-card">
          <JsonRenderer siteJson={panelSiteJson(props.graph.panelSpec)} data={{}} />
          <div className="hub-list">
            {topNodes.map((node) => (
              <button key={node.slug} type="button" onClick={() => props.openPage(node.slug)}>
                <span>{node.title}</span>
                <em>{node.degree} links</em>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function normalizeArtifacts(values: unknown[]): ResearchArtifact[] {
  return values.filter((value): value is ResearchArtifact => {
    if (!value || typeof value !== 'object') return false
    const record = value as Partial<ResearchArtifact>
    return typeof record.kind === 'string' && typeof record.title === 'string'
  })
}

function normalizeGraphNode(node: KnowledgeGraph['nodes'][number]) {
  return {
    slug: node.slug ?? node.ref?.replace(/^(page|source|concept|artifact):/, '') ?? node.id ?? '',
    title: node.title ?? node.label ?? node.slug ?? node.id ?? 'Node',
    degree: node.degree ?? 0,
    ...(node.kind ? { kind: node.kind } : {})
  }
}


function StatusIcon({ state }: { state: SseState }) {
  return state === 'SSE connected' || state === 'completed' ? <Wifi size={15} /> : <WifiOff size={15} />
}
