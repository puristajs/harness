import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { bashSandbox, defineHarness, inMemorySandbox, JsonLogger, type Harness, type HarnessAdapterContext, type JsonValue, type McpHttpToolDefinition, type McpStdioToolDefinition, type ObjectRequest, type ObjectResponse, type ModelProvider, type Sandbox } from '../../../../packages/harness/src/index.js'
import { createFileWikiStore, type FileWikiStore } from './data.js'
import { loadRootEnv as loadRepositoryRootEnv, requireOpenAiKey as requireRepositoryOpenAiKey } from './env.js'
import { createLivingWikiTools, makePanelSpec } from './tools.js'
import {
  architectureReviewInputSchema,
  architectureReviewOutputSchema,
  askWikiInputSchema,
  askWikiOutputSchema,
  decisionMemoInputSchema,
  decisionMemoOutputSchema,
  generateResearchBriefInputSchema,
  generateResearchBriefOutputSchema,
  ingestSourceInputSchema,
  ingestSourceOutputSchema,
  lintWikiInputSchema,
  lintWikiOutputSchema,
  reconcileContradictionInputSchema,
  reconcileContradictionOutputSchema,
  slugSchema,
  wikiQualityAuditInputSchema,
  wikiQualityAuditOutputSchema,
  type ArchitectureReviewOutput,
  type DecisionMemoOutput,
  type IngestSourceInput,
  type ProposedPageChange,
  type ResearchArtifact,
  type ReviewRequest,
  type WikiQualityAuditOutput
} from './schemas.js'

const here = dirname(fileURLToPath(import.meta.url))
const exampleRoot = resolve(here, '..', '..')

export type WorkflowId = 'ingest_source' | 'ask_wiki' | 'lint_wiki' | 'reconcile_contradiction' | 'generate_research_brief' | 'decision_memo' | 'architecture_review' | 'wiki_audit'
export type AgentId = 'wiki_curator' | 'wiki_answerer' | 'wiki_linter' | 'wiki_reconciler' | 'wiki_brief_writer' | 'source_extractor' | 'decision_memo_writer' | 'architecture_reviewer' | 'wiki_auditor'

export const workflowIds: WorkflowId[] = ['ingest_source', 'ask_wiki', 'lint_wiki', 'reconcile_contradiction', 'generate_research_brief', 'decision_memo', 'architecture_review', 'wiki_audit']
export const agentIds: AgentId[] = ['wiki_curator', 'wiki_answerer', 'wiki_linter', 'wiki_reconciler', 'wiki_brief_writer', 'source_extractor', 'decision_memo_writer', 'architecture_reviewer', 'wiki_auditor']

export function loadRootEnv(): void {
  loadRepositoryRootEnv(exampleRoot)
}

function requireOpenAiKey(): string {
  return requireRepositoryOpenAiKey(exampleRoot)
}

export class ScriptedLivingWikiProvider implements ModelProvider {
  public readonly id = 'scripted-living-wiki'
  public readonly genAiSystem = 'fake'
  public readonly requests: ObjectRequest[] = []

  public constructor(private readonly options: { delayMs?: number } = {}) {}

  async object<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.requests.push(req)
    if (this.options.delayMs) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, this.options.delayMs)
        req.signal.addEventListener('abort', () => {
          clearTimeout(timeout)
          reject(req.signal.reason ?? new Error('cancelled'))
        }, { once: true })
      })
    }

    const text = JSON.stringify(req.messages).toLowerCase()
    const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30 }
    if (text.includes('ingest_source')) {
      return { object: objectData({
        updatedPages: ['jaeger'],
        extractedConcepts: ['jaeger'],
        followUpQuestions: ['Which service owns trace retention?'],
        proposedChanges: [auditNoteChange('ingest-change-1')],
        contradictions: [],
        citedEvidence: [sourceEvidence()],
        panelSpec: makePanelSpec('Source Ingest', [{ heading: 'Needs Review', items: ['1 proposed Jaeger page update'] }])
      }) as T, usage, finishReason: 'stop' }
    }
    if (text.includes('lint_wiki')) {
      return { object: objectData({ orphanPages: [], missingBacklinks: [], weakClaims: [], staleNotes: [], duplicateConcepts: [], panelSpec: makePanelSpec('Lint Report', [{ heading: 'Status', items: ['No blocking wiki issues found.'] }]) }) as T, usage, finishReason: 'stop' }
    }
    if (text.includes('reconcile_contradiction')) {
      return { object: objectData({ summary: 'The conflict is recorded and left with a narrow follow-up.', changedPages: ['jaeger'], unresolvedQuestions: ['Confirm the authoritative wording.'] }) as T, usage, finishReason: 'stop' }
    }
    if (text.includes('generate_research_brief')) {
      return { object: objectData({ markdown: '## Research Brief\n\nJaeger traces make local harness runs observable.', panelSpec: makePanelSpec('Research Brief', [{ heading: 'Cited Pages', items: ['jaeger'] }]), citedPages: ['jaeger'] }) as T, usage, finishReason: 'stop' }
    }
    if (text.includes('decision_memo')) {
      return { object: objectData(decisionMemoFixture()) as T, usage, finishReason: 'stop' }
    }
    if (text.includes('architecture_review')) {
      return { object: objectData(architectureReviewFixture()) as T, usage, finishReason: 'stop' }
    }
    if (text.includes('wiki_audit')) {
      return { object: objectData(wikiAuditFixture()) as T, usage, finishReason: 'stop' }
    }
    return { object: objectData({ answer: 'Jaeger stores and visualizes traces for local harness workflow runs.', citedPages: ['jaeger'], confidenceNotes: ['Fake provider response for hermetic tests.'] }) as T, usage, finishReason: 'stop' }
  }
}

export function createScriptedLivingWikiProvider(options: { delayMs?: number } = {}): ScriptedLivingWikiProvider {
  return new ScriptedLivingWikiProvider(options)
}

export interface LivingWikiHarnessOptions {
  dataRoot?: string
  skillDirectory?: string
  provider?: ModelProvider
  model?: string
  store?: FileWikiStore
  sandbox?: Sandbox
}

export interface LivingWikiHarnessResult {
  harness: Harness<any>
  store: FileWikiStore
  provider: ModelProvider
  model: string
}

export function createLivingWikiHarness(options: LivingWikiHarnessOptions = {}): LivingWikiHarnessResult {
  loadRootEnv()
  const model = options.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-mini'
  const provider = options.provider ?? lazyOpenAiProvider(requireOpenAiKey())
  const store = options.store ?? createFileWikiStore({ dataDir: options.dataRoot ?? join(exampleRoot, 'data') })
  const skillDirectory = options.skillDirectory ?? join(exampleRoot, 'skills/wiki-curator')
  const skillsRoot = join(exampleRoot, 'skills')
  const drawioMcpTool = createDrawioMcpTool()
  const builtInAgentTools = ['read_source', 'search_wiki', 'read_wiki_page', 'write_wiki_page', 'append_log', 'list_backlinks', 'render_panel_spec'] as const
  const agentTools = drawioMcpTool ? [...builtInAgentTools, 'drawio_mcp_diagram'] as const : builtInAgentTools
  const baseInstructions = [
    'Use the mounted wiki-curator skill.',
    'Keep markdown compact and linked with [[page-slug]] syntax.',
    'Use tools for source/wiki reads, wiki writes, backlinks, panels, and log entries.',
    'Return only JSON matching the requested workflow schema.'
  ].join('\n')

  const harness = defineHarness({ name: 'living-wiki-jaeger-example' })
    .logger(new JsonLogger({ level: 'info' }))
    .telemetry({})
    .sandbox(options.sandbox ?? (drawioMcpTool?.kind === 'mcp_stdio' ? bashSandbox() : inMemorySandbox()))
    .models({
      wiki_model: {
        provider,
        model,
        capabilities: ['text', 'object', 'tool_use']
      }
    })
    .tools(({ tool }) => ({ ...createLivingWikiTools({ tool }, store), ...(drawioMcpTool ? { drawio_mcp_diagram: drawioMcpTool } : {}) }))
    .skills({
      'wiki-curator': { directory: skillDirectory },
      'research-brief-writer': { directory: join(skillsRoot, 'research-brief-writer') },
      'diagram-designer': { directory: join(skillsRoot, 'diagram-designer') },
      'decision-memo-planner': { directory: join(skillsRoot, 'decision-memo-planner') },
      'reflective-critic': { directory: join(skillsRoot, 'reflective-critic') },
      'judge-rubric': { directory: join(skillsRoot, 'judge-rubric') }
    })
    .agents(({ agent }) => ({
      wiki_curator: agent({
        model: 'wiki_model',
        input: ingestSourceInputSchema,
        output: ingestSourceOutputSchema,
        tools: agentTools,
        builtinTools: ['read'],
        skills: ['wiki-curator'],
        instructions: (ctx) => `${baseInstructions}\nWorkflow: ingest_source\nInput: ${JSON.stringify(ctx.input)}`
      }),
      source_extractor: agent({
        model: 'wiki_model',
        input: ingestSourceInputSchema,
        output: ingestSourceOutputSchema,
        tools: agentTools,
        builtinTools: ['read'],
        skills: ['wiki-curator', 'reflective-critic'],
        instructions: (ctx) => `${baseInstructions}\nWorkflow: ingest_source\nPlan source extraction and produce proposed page changes for human review.\nInput: ${JSON.stringify(ctx.input)}`
      }),
      wiki_answerer: agent({
        model: 'wiki_model',
        input: askWikiInputSchema,
        output: askWikiOutputSchema,
        tools: agentTools,
        builtinTools: ['read'],
        skills: ['wiki-curator'],
        instructions: (ctx) => `${baseInstructions}\nWorkflow: ask_wiki\nInput: ${JSON.stringify(ctx.input)}`
      }),
      wiki_linter: agent({
        model: 'wiki_model',
        input: lintWikiInputSchema,
        output: lintWikiOutputSchema,
        tools: agentTools,
        builtinTools: ['read'],
        skills: ['wiki-curator'],
        instructions: (ctx) => `${baseInstructions}\nWorkflow: lint_wiki\nInput: ${JSON.stringify(ctx.input)}`
      }),
      wiki_reconciler: agent({
        model: 'wiki_model',
        input: reconcileContradictionInputSchema,
        output: reconcileContradictionOutputSchema,
        tools: agentTools,
        builtinTools: ['read'],
        skills: ['wiki-curator'],
        instructions: (ctx) => `${baseInstructions}\nWorkflow: reconcile_contradiction\nInput: ${JSON.stringify(ctx.input)}`
      }),
      wiki_brief_writer: agent({
        model: 'wiki_model',
        input: generateResearchBriefInputSchema,
        output: generateResearchBriefOutputSchema,
        tools: agentTools,
        builtinTools: ['read'],
        skills: ['wiki-curator', 'research-brief-writer'],
        instructions: (ctx) => `${baseInstructions}\nWorkflow: generate_research_brief\nInput: ${JSON.stringify(ctx.input)}`
      }),
      decision_memo_writer: agent({
        model: 'wiki_model',
        input: decisionMemoInputSchema,
        output: decisionMemoOutputSchema,
        tools: agentTools,
        builtinTools: ['read'],
        skills: ['decision-memo-planner', 'research-brief-writer', 'diagram-designer', 'reflective-critic', 'judge-rubric'],
        instructions: (ctx) => `${baseInstructions}\nWorkflow: decision_memo\nUse plan, retrieve, reason, reflect, judge, publish phases.\nInput: ${JSON.stringify(ctx.input)}`
      }),
      architecture_reviewer: agent({
        model: 'wiki_model',
        input: architectureReviewInputSchema,
        output: architectureReviewOutputSchema,
        tools: agentTools,
        builtinTools: ['read'],
        skills: ['wiki-curator', 'reflective-critic', 'judge-rubric', 'diagram-designer'],
        instructions: (ctx) => `${baseInstructions}\nWorkflow: architecture_review\nReview API, data, operations, security, migration, and observability concerns.\nInput: ${JSON.stringify(ctx.input)}`
      }),
      wiki_auditor: agent({
        model: 'wiki_model',
        input: wikiQualityAuditInputSchema,
        output: wikiQualityAuditOutputSchema,
        tools: agentTools,
        builtinTools: ['read'],
        skills: ['wiki-curator', 'reflective-critic', 'judge-rubric'],
        instructions: (ctx) => `${baseInstructions}\nWorkflow: wiki_audit\nAudit without mutating pages; return proposed changes and a review request.\nInput: ${JSON.stringify(ctx.input)}`
      })
    }))
    .workflows(({ workflow }) => ({
      ingest_source: workflow({
        input: ingestSourceInputSchema,
        output: ingestSourceOutputSchema,
        delegation: { agents: ['source_extractor'] },
        handler: async (ctx) => {
          await store.readSource(ctx.input.sourceSlug)
          const output = await ctx.agents.source_extractor(ctx.input, { signal: ctx.signal })
          return {
            ...output,
            reviewRequest: withRunId(output.reviewRequest ?? reviewRequest(ctx.runId, 'source-ingest', 'Review source ingest changes', 'Approve extracted wiki edits before applying them.'), ctx.runId),
            phases: phases('source_extractor')
          }
        }
      }),
      ask_wiki: workflow({
        input: askWikiInputSchema,
        output: askWikiOutputSchema,
        delegation: { agents: ['wiki_answerer'] },
        handler: async (ctx) => ctx.agents.wiki_answerer(ctx.input, { signal: ctx.signal })
      }),
      lint_wiki: workflow({
        input: lintWikiInputSchema,
        output: lintWikiOutputSchema,
        delegation: { agents: ['wiki_linter'] },
        handler: async (ctx) => ctx.agents.wiki_linter(ctx.input, { signal: ctx.signal })
      }),
      reconcile_contradiction: workflow({
        input: reconcileContradictionInputSchema,
        output: reconcileContradictionOutputSchema,
        delegation: { agents: ['wiki_reconciler'] },
        handler: async (ctx) => {
          await store.readWikiPage(ctx.input.leftRef)
          await store.readWikiPage(ctx.input.rightRef)
          const output = await ctx.agents.wiki_reconciler(ctx.input, { signal: ctx.signal })
          await store.appendLog({ workflow: 'reconcile_contradiction', message: ctx.input.conflict, pages: output.changedPages })
          return output
        }
      }),
      generate_research_brief: workflow({
        input: generateResearchBriefInputSchema,
        output: generateResearchBriefOutputSchema,
        delegation: { agents: ['wiki_brief_writer'] },
        handler: async (ctx) => {
          const pages = await Promise.all(ctx.input.pageSlugs.map((slug) => store.readWikiPage(slug)))
          const output = await ctx.agents.wiki_brief_writer(ctx.input, { signal: ctx.signal })
          const markdown = researchBriefMarkdown(ctx.input.goal, pages.map((page) => page.slug), output.markdown)
          const panelSpec = output.panelSpec ?? makePanelSpec('Research Brief', [{ heading: 'Cited Pages', items: output.citedPages }])
          const artifacts = await createStudioArtifactSet(store, {
            runId: ctx.runId,
            baseTitle: 'Research Brief',
            markdown,
            panelSpec,
            sourcePageIds: output.citedPages,
            mermaid: researchBriefMermaid(output.citedPages),
            drawioXml: drawioArchitectureXml('Research Brief Studio', [
              'Evidence',
              'Synthesis',
              'Risks',
              'Next actions'
            ], 'Research brief')
          })
          return { ...output, markdown, panelSpec, artifacts: [...(output.artifacts ?? []), ...artifacts], phases: phases('wiki_brief_writer') }
        }
      }),
      decision_memo: workflow({
        input: decisionMemoInputSchema,
        output: decisionMemoOutputSchema,
        delegation: { agents: ['decision_memo_writer'] },
        handler: async (ctx) => {
          const output = await ctx.agents.decision_memo_writer(ctx.input, { signal: ctx.signal })
          const markdown = decisionMemoMarkdown(ctx.input.proposal, output)
          const panelSpec = output.panelSpec ?? makePanelSpec('Decision Memo', [{ heading: 'Recommendation', items: [output.recommendation] }])
          const artifacts = await createStudioArtifactSet(store, {
            runId: ctx.runId,
            baseTitle: 'Decision Memo',
            markdown,
            panelSpec,
            sourcePageIds: citedPageIds(output.citedEvidence),
            mermaid: decisionMemoMermaid(output.recommendation),
            drawioXml: drawioArchitectureXml('Decision Memo Studio', [
              'Proposal',
              'Options',
              'Recommendation',
              'Pilot plan'
            ], `Recommendation: ${output.recommendation}`)
          })
          return { ...output, ...(output.reviewRequest ? { reviewRequest: withRunId(output.reviewRequest, ctx.runId) } : {}), markdown, panelSpec, artifacts: [...output.artifacts, ...artifacts], phases: phases('decision_memo_writer') }
        }
      }),
      architecture_review: workflow({
        input: architectureReviewInputSchema,
        output: architectureReviewOutputSchema,
        delegation: { agents: ['architecture_reviewer'] },
        handler: async (ctx) => {
          if (ctx.input.sourceSlug) await store.readSource(ctx.input.sourceSlug)
          if (ctx.input.pageSlug) await store.readWikiPage(ctx.input.pageSlug)
          const output = await ctx.agents.architecture_reviewer(ctx.input, { signal: ctx.signal })
          const markdown = architectureReviewMarkdown(ctx.input.focus, output)
          const panelSpec = output.panelSpec ?? makePanelSpec('Architecture Review', [{ heading: 'Readiness', items: [output.readiness] }])
          const artifacts = await createStudioArtifactSet(store, {
            runId: ctx.runId,
            baseTitle: 'Architecture Review',
            markdown,
            panelSpec,
            sourcePageIds: ctx.input.pageSlug ? [ctx.input.pageSlug] : citedPageIds(output.citedEvidence),
            mermaid: architectureReviewMermaid(output.readiness),
            drawioXml: drawioArchitectureXml('Architecture Board Studio', [
              'API surface',
              'Data ownership',
              'Operations',
              'Security',
              'Migration',
              'Observability'
            ], `Readiness: ${output.readiness}`)
          })
          return { ...output, ...(output.reviewRequest ? { reviewRequest: withRunId(output.reviewRequest, ctx.runId) } : {}), markdown, panelSpec, artifacts: [...output.artifacts, ...artifacts], phases: phases('architecture_reviewer') }
        }
      }),
      wiki_audit: workflow({
        input: wikiQualityAuditInputSchema,
        output: wikiQualityAuditOutputSchema,
        delegation: { agents: ['wiki_auditor'] },
        handler: async (ctx) => {
          const output = await ctx.agents.wiki_auditor(ctx.input, { signal: ctx.signal })
          return {
            ...output,
            reviewRequest: withRunId(output.reviewRequest, ctx.runId),
            phases: phases('wiki_auditor')
          }
        }
      })
    }))
    .build()

  return { harness, store, provider, model }
}

function sourceEvidence() {
  return {
    id: 'evidence-jaeger-source',
    title: 'Jaeger Source',
    sourceType: 'uploaded_source' as const,
    reference: 'jaeger',
    quoteOrSummary: 'Jaeger stores traces for local harness runs.',
    confidence: 'high' as const
  }
}

function judgeFixture(verdict: 'approved' | 'needs_human_review' | 'revise' | 'rejected' = 'approved') {
  return {
    score: verdict === 'approved' ? 8 : 6,
    maxScore: 10,
    verdict,
    criteria: [
      { id: 'evidence', label: 'Evidence grounding', score: verdict === 'approved' ? 4 : 3, maxScore: 5, rationale: 'Uses wiki and source evidence.' },
      { id: 'risk', label: 'Risk coverage', score: verdict === 'approved' ? 4 : 3, maxScore: 5, rationale: 'Calls out operational follow-ups.' }
    ]
  }
}

function auditNoteChange(id = 'audit-change-1'): ProposedPageChange & { targetRefs: string[] } {
  return {
    id,
    kind: 'update_page',
    targetPageId: 'jaeger',
    title: 'Add audit note to Jaeger',
    beforeMarkdown: '# Jaeger\n',
    afterMarkdown: '# Jaeger\n\nAudit note: confirm trace retention ownership before production rollout.\n',
    rationale: 'The wiki has operational traceability content but no explicit retention owner.',
    citations: [{
      id: `${id}-citation`,
      pageId: 'jaeger',
      sourceRef: 'jaeger',
      claim: 'Trace retention ownership remains an open operational question.',
      operation: 'add'
    }],
    risk: 'low',
    targetRefs: ['page:jaeger']
  }
}

function reviewRequest(runId: string, idSuffix: string, title: string, reason: string): ReviewRequest {
  return {
    id: `review-${idSuffix}`,
    runId,
    title,
    reason,
    questions: [{
      id: 'approval',
      label: 'Apply the proposed changes?',
      kind: 'approval',
      required: true
    }],
    defaultDecision: 'approve'
  }
}

function withRunId(request: ReviewRequest, runId: string): ReviewRequest {
  return { ...request, runId }
}

function phases(agentId: string) {
  const now = new Date().toISOString()
  return [
    { phase: 'plan' as const, status: 'completed' as const, agentId, summary: 'Planned the analysis scope.', startedAt: now, finishedAt: now },
    { phase: 'retrieve' as const, status: 'completed' as const, agentId, summary: 'Retrieved wiki/source evidence.', startedAt: now, finishedAt: now },
    { phase: 'reason' as const, status: 'completed' as const, agentId, summary: 'Produced the structured output.', startedAt: now, finishedAt: now },
    { phase: 'reflect' as const, status: 'completed' as const, agentId, summary: 'Checked for unsupported claims.', startedAt: now, finishedAt: now },
    { phase: 'judge' as const, status: 'completed' as const, agentId, summary: 'Scored the result with a rubric.', startedAt: now, finishedAt: now }
  ]
}

function decisionMemoFixture(): DecisionMemoOutput {
  return {
    markdown: '## Decision Memo\n\nPilot Jaeger tracing for local harness workflow observability before broad adoption.',
    recommendation: 'pilot',
    citedEvidence: [sourceEvidence()],
    risks: ['Trace retention ownership must be explicit.'],
    counterarguments: ['A simpler log-only setup may be enough for small local demos.'],
    openQuestions: ['Who owns trace retention settings?'],
    nextActions: ['Run a one-week pilot with Jaeger enabled.'],
    judge: judgeFixture('approved'),
    artifacts: [],
    panelSpec: makePanelSpec('Decision Memo', [{ heading: 'Recommendation', items: ['Pilot Jaeger tracing'] }])
  }
}

function architectureReviewFixture(): ArchitectureReviewOutput {
  return {
    markdown: '## Architecture Review\n\nThe RFC is directionally sound but needs explicit retention, ownership, and rollout criteria.',
    readiness: 'changes_requested',
    blockingIssues: ['Define trace retention ownership.'],
    nonBlockingIssues: ['Add rollout success metrics.'],
    requiredFollowUps: ['Document retention configuration and operational owner.'],
    citedEvidence: [sourceEvidence()],
    judge: judgeFixture('needs_human_review'),
    artifacts: [],
    reviewRequest: reviewRequest('pending-run', 'architecture-review', 'Review architecture board decision', 'Confirm whether requested changes are sufficient.'),
    panelSpec: makePanelSpec('Architecture Review', [{ heading: 'Readiness', items: ['Changes requested'] }])
  }
}

function wikiAuditFixture(): WikiQualityAuditOutput {
  return {
    markdown: '## Wiki Audit\n\nThe wiki is mostly coherent. Add a low-risk retention ownership note to the Jaeger page.',
    proposedChanges: [auditNoteChange()],
    citedEvidence: [sourceEvidence()],
    judge: judgeFixture('needs_human_review'),
    graphHighlights: [{
      nodeIds: ['page:jaeger'],
      edgeIds: [],
      kind: 'changed',
      label: 'Proposed Jaeger page update'
    }],
    reviewRequest: reviewRequest('pending-run', 'wiki-audit', 'Review wiki audit changes', 'Audit changes are proposed only and require approval before mutation.'),
    panelSpec: makePanelSpec('Wiki Audit', [{ heading: 'Proposed Changes', items: ['Add trace retention ownership note'] }])
  }
}

async function createStudioArtifactSet(
  store: FileWikiStore,
  args: {
    runId: string
    baseTitle: string
    markdown: string
    mermaid: string
    drawioXml: string
    panelSpec: unknown
    sourcePageIds: string[]
  }
): Promise<ResearchArtifact[]> {
  const jsonPanel = JSON.stringify(args.panelSpec, null, 2)
  return Promise.all([
    createWorkflowArtifact(store, args.runId, `${args.baseTitle} Document`, 'markdown', 'text/markdown', args.markdown, args.sourcePageIds, {
      renderMode: 'document',
      content: args.markdown
    }),
    createWorkflowArtifact(store, args.runId, `${args.baseTitle} Mermaid Map`, 'mermaid', 'text/vnd.mermaid', args.mermaid, args.sourcePageIds, {
      content: args.mermaid
    }),
    createWorkflowArtifact(store, args.runId, `${args.baseTitle} draw.io Board`, 'drawio_xml', 'application/vnd.jgraph.mxfile', args.drawioXml, args.sourcePageIds, {
      renderMode: 'document',
      content: args.drawioXml,
      drawioEditorUrl: drawioEditorUrl(args.drawioXml),
      viewerConfig: {
        mode: 'viewer',
        page: args.baseTitle,
        mcpFallback: drawioMcpStatus()
      }
    }),
    createWorkflowArtifact(store, args.runId, `${args.baseTitle} JSON Panel`, 'json_panel', 'application/json', jsonPanel, args.sourcePageIds, {
      panelSpec: args.panelSpec,
      data: args.panelSpec,
      content: jsonPanel
    })
  ])
}

async function createWorkflowArtifact(
  store: FileWikiStore,
  runId: string,
  title: string,
  kind: ResearchArtifact['kind'],
  mimeType: string,
  content: string,
  sourcePageIds: string[],
  options: {
    renderMode?: ResearchArtifact['renderMode']
    content?: string
    panelSpec?: unknown
    data?: unknown
    drawioEditorUrl?: string
    viewerConfig?: Record<string, unknown>
  } = {}
): Promise<ResearchArtifact> {
  const { manifest } = await store.storeArtifact({
    kind,
    title,
    contentType: mimeType,
    content,
    createdByRunId: runId,
    sourcePageIds,
    renderMode: options.renderMode ?? 'inline',
    ...(options.drawioEditorUrl ? { drawioEditorUrl: options.drawioEditorUrl } : {}),
    ...(options.viewerConfig ? { viewerConfig: options.viewerConfig } : {})
  })
  return {
    id: manifest.artifactId,
    kind: manifest.kind,
    title: manifest.title,
    mimeType: manifest.contentType,
    contentRef: `/api/artifacts/${manifest.artifactId}`,
    createdAt: manifest.createdAt,
    generatedByRunId: runId,
    renderMode: manifest.renderMode,
    ...(options.content ? { content: options.content } : {}),
    ...(options.panelSpec !== undefined ? { panelSpec: options.panelSpec } : {}),
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(manifest.drawioEditorUrl ? { drawioEditorUrl: manifest.drawioEditorUrl } : {}),
    ...(manifest.viewerConfig ? { viewerConfig: manifest.viewerConfig } : {})
  }
}

function researchBriefMarkdown(goal: string, citedPages: string[], modelMarkdown: string): string {
  return [
    '# Research Brief',
    '',
    `Goal: ${goal}`,
    '',
    modelMarkdown.trim(),
    '',
    '## Architecture Studio Notes',
    '',
    '- Evidence is grounded in the selected wiki pages.',
    '- The Mermaid map is the canonical editable diagram source.',
    '- The draw.io board is stored as plain XML so it can be opened outside the app when a draw.io-capable MCP server is unavailable.',
    '',
    '## Cited Pages',
    '',
    ...citedPages.map((slug) => `- [[${slug}]]`)
  ].join('\n')
}

function decisionMemoMarkdown(proposal: string, output: DecisionMemoOutput): string {
  return [
    '# Decision Memo',
    '',
    `Proposal: ${proposal}`,
    '',
    `Recommendation: ${output.recommendation}`,
    '',
    output.markdown.trim(),
    '',
    '## Evidence',
    '',
    ...output.citedEvidence.map((item) => `- ${item.title} (${item.confidence}): ${item.quoteOrSummary}`),
    '',
    '## Risks',
    '',
    ...output.risks.map((risk) => `- ${risk}`),
    '',
    '## Counterarguments',
    '',
    ...output.counterarguments.map((item) => `- ${item}`),
    '',
    '## Next Actions',
    '',
    ...output.nextActions.map((action) => `- ${action}`)
  ].join('\n')
}

function architectureReviewMarkdown(focus: string | undefined, output: ArchitectureReviewOutput): string {
  return [
    '# Architecture Review',
    '',
    `Readiness: ${output.readiness}`,
    ...(focus ? ['', `Focus: ${focus}`] : []),
    '',
    output.markdown.trim(),
    '',
    '## Blocking Issues',
    '',
    ...(output.blockingIssues.length ? output.blockingIssues.map((issue) => `- ${issue}`) : ['- None recorded.']),
    '',
    '## Non-Blocking Issues',
    '',
    ...(output.nonBlockingIssues.length ? output.nonBlockingIssues.map((issue) => `- ${issue}`) : ['- None recorded.']),
    '',
    '## Required Follow-Ups',
    '',
    ...output.requiredFollowUps.map((item) => `- ${item}`)
  ].join('\n')
}

function researchBriefMermaid(citedPages: string[]): string {
  const pages = citedPages.length ? citedPages : ['wiki']
  return [
    'graph LR',
    '  evidence["Selected evidence"] --> synthesis["Research synthesis"]',
    '  synthesis --> risks["Risks and unknowns"]',
    '  synthesis --> actions["Next actions"]',
    ...pages.map((slug, index) => `  page${index}["[[${escapeMermaid(slug)}]]"] --> evidence`)
  ].join('\n')
}

function decisionMemoMermaid(recommendation: DecisionMemoOutput['recommendation']): string {
  return [
    'graph LR',
    '  proposal["Proposal"] --> criteria["Decision criteria"]',
    '  criteria --> evidence["Evidence"]',
    '  evidence --> options["Options"]',
    `  options --> recommendation["Recommendation: ${recommendation}"]`,
    '  recommendation --> next["Pilot / next actions"]'
  ].join('\n')
}

function architectureReviewMermaid(readiness: ArchitectureReviewOutput['readiness']): string {
  return [
    'graph LR',
    '  rfc["Architecture Review source"] --> api["API"]',
    '  rfc --> data["Data"]',
    '  rfc --> ops["Operations"]',
    '  rfc --> security["Security"]',
    '  rfc --> migration["Migration"]',
    '  rfc --> observability["Observability"]',
    `  api --> readiness["Readiness: ${readiness}"]`,
    '  data --> readiness',
    '  ops --> readiness',
    '  security --> readiness',
    '  migration --> readiness',
    '  observability --> readiness'
  ].join('\n')
}

function drawioArchitectureXml(title: string, nodes: string[], conclusion: string): string {
  const cells = [
    '<mxCell id="0"/>',
    '<mxCell id="1" parent="0"/>',
    ...nodes.map((label, index) => drawioVertex(`node-${index}`, label, 40 + (index % 3) * 210, 80 + Math.floor(index / 3) * 110)),
    drawioVertex('conclusion', conclusion, 250, 330, 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;')
  ]
  const edges = nodes.map((_, index) => drawioEdge(`edge-${index}`, `node-${index}`, 'conclusion'))
  return [
    '<mxfile host="app.diagrams.net" type="device">',
    `  <diagram id="${xmlAttr(slugId(title))}" name="${xmlAttr(title)}">`,
    '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">',
    '      <root>',
    ...cells.map((cell) => `        ${cell}`),
    ...edges.map((edge) => `        ${edge}`),
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>'
  ].join('\n')
}

function drawioVertex(id: string, label: string, x: number, y: number, style = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;'): string {
  return `<mxCell id="${xmlAttr(id)}" value="${xmlAttr(label)}" style="${xmlAttr(style)}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="160" height="64" as="geometry"/></mxCell>`
}

function drawioEdge(id: string, source: string, target: string): string {
  return `<mxCell id="${xmlAttr(id)}" style="endArrow=block;html=1;rounded=0;" edge="1" parent="1" source="${xmlAttr(source)}" target="${xmlAttr(target)}"><mxGeometry relative="1" as="geometry"/></mxCell>`
}

function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeMermaid(value: string): string {
  return value.replaceAll('"', '\\"')
}

function slugId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram'
}

function citedPageIds(evidence: Array<{ sourceType: string; reference: string }>): string[] {
  return [...new Set(evidence
    .filter((item) => item.sourceType === 'wiki_page' && slugSchema.safeParse(item.reference).success)
    .map((item) => item.reference))]
}

function drawioMcpStatus(): string {
  const mcpConfigured = Boolean(process.env['LIVING_WIKI_DRAWIO_MCP_COMMAND'] || process.env['LIVING_WIKI_DRAWIO_MCP_URL'])
  return mcpConfigured ? 'configured-optional-tool' : 'unavailable-mermaid-is-canonical'
}

function createDrawioMcpTool(): McpHttpToolDefinition | McpStdioToolDefinition | undefined {
  const httpUrl = process.env['LIVING_WIKI_DRAWIO_MCP_URL']
  if (httpUrl) {
    const token = process.env['LIVING_WIKI_DRAWIO_MCP_AUTH_TOKEN']
    return {
      kind: 'mcp_http',
      description: 'Create draw.io diagrams through an optional remote MCP server.',
      url: httpUrl,
      ...(token ? { auth: { kind: 'bearer', token } } : {}),
      tool: process.env['LIVING_WIKI_DRAWIO_MCP_TOOL'] ?? 'drawio.create'
    }
  }

  const command = process.env['LIVING_WIKI_DRAWIO_MCP_COMMAND']
  if (!command) return undefined
  const installCommand = process.env['LIVING_WIKI_DRAWIO_MCP_INSTALL']
  return {
    kind: 'mcp_stdio',
    description: 'Create draw.io diagrams through an optional sandbox-local MCP server.',
    command,
    args: splitArgs(process.env['LIVING_WIKI_DRAWIO_MCP_ARGS']),
    ...(installCommand ? {
      install: {
        command: installCommand,
        cwd: process.env['LIVING_WIKI_DRAWIO_MCP_CWD'] ?? '/workspace',
        timeoutMs: Number(process.env['LIVING_WIKI_DRAWIO_MCP_INSTALL_TIMEOUT_MS'] ?? 120_000)
      }
    } : {}),
    tool: process.env['LIVING_WIKI_DRAWIO_MCP_TOOL'] ?? 'drawio.create'
  }
}

function splitArgs(value: string | undefined): string[] {
  if (!value?.trim()) return []
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')) ?? []
}

function drawioEditorUrl(xml: string): string {
  const encodedXml = encodeURIComponent(xml)
  const compressed = deflateRawSync(Buffer.from(encodedXml, 'utf8')).toString('base64')
  const createPayload = encodeURIComponent(JSON.stringify({ type: 'xml', compressed: true, data: compressed }))
  return `https://app.diagrams.net/?pv=0&grid=0#create=${createPayload}`
}

function objectData<T extends JsonValue = JsonValue>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function lazyOpenAiProvider(apiKey: string): ModelProvider {
  let delegate: ModelProvider | undefined
  let harnessContext: HarnessAdapterContext | undefined
  const configureDelegate = (provider: ModelProvider, context: HarnessAdapterContext) => {
    (provider as ModelProvider & { configureHarnessContext?: (ctx: HarnessAdapterContext) => void }).configureHarnessContext?.(context)
  }
  const load = async (): Promise<ModelProvider> => {
    if (!delegate) {
      const packageName = '@purista/harness-openai'
      const module = await import(packageName) as { openai: (options: { apiKey: string }) => ModelProvider }
      delegate = module.openai({ apiKey })
      if (harnessContext) configureDelegate(delegate, harnessContext)
    }
    return delegate
  }
  const provider: ModelProvider & { configureHarnessContext(context: HarnessAdapterContext): void } = {
    id: 'openai',
    genAiSystem: 'openai',
    configureHarnessContext(context) {
      harnessContext = context
      if (delegate) configureDelegate(delegate, context)
    },
    async text(req) {
      const provider = await load()
      if (!provider.text) throw new Error('OpenAI provider does not implement text generation.')
      return provider.text(req)
    },
    textStream(req) {
      return lazyStream(async () => {
        const provider = await load()
        if (!provider.textStream) throw new Error('OpenAI provider does not implement text streaming.')
        return provider.textStream(req)
      })
    },
    async object(req) {
      const provider = await load()
      if (!provider.object) throw new Error('OpenAI provider does not implement object generation.')
      return provider.object(req)
    },
    objectStream(req) {
      return lazyStream(async () => {
        const provider = await load()
        if (!provider.objectStream) throw new Error('OpenAI provider does not implement object streaming.')
        return provider.objectStream(req)
      })
    },
    async close() {
      await delegate?.close?.()
    }
  }
  return provider
}

async function* lazyStream<T>(load: () => Promise<AsyncIterable<T>>): AsyncIterable<T> {
  yield* await load()
}
