import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import {
  defineAgent,
  defineHarness,
  defineMcpServer,
  defineWorkflow,
  sqliteHarnessStorage,
  JsonLogger,
  type JsonValue,
  type McpBinding,
  type ModelProvider,
  type ObjectRequest,
  type ObjectResponse,
  type ObjectStreamChunk,
} from '@purista/harness'
import { openai } from '@purista/harness-openai'
import { z } from 'zod'
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
  type ProposedPageChange,
  type ResearchArtifact,
  type ReviewRequest,
  type WikiQualityAuditOutput,
} from './schemas.js'

const here = dirname(fileURLToPath(import.meta.url))
const exampleRoot = resolve(here, '..', '..')

export type WorkflowId =
  | 'ingest_source'
  | 'ask_wiki'
  | 'lint_wiki'
  | 'reconcile_contradiction'
  | 'generate_research_brief'
  | 'decision_memo'
  | 'architecture_review'
  | 'wiki_audit'
export type AgentId =
  | 'wiki_curator'
  | 'wiki_answerer'
  | 'wiki_linter'
  | 'wiki_reconciler'
  | 'wiki_brief_writer'
  | 'source_extractor'
  | 'decision_memo_writer'
  | 'architecture_reviewer'
  | 'wiki_auditor'

export const workflowIds: readonly WorkflowId[] = Object.freeze([
  'ingest_source', 'ask_wiki', 'lint_wiki', 'reconcile_contradiction',
  'generate_research_brief', 'decision_memo', 'architecture_review', 'wiki_audit',
])
export const agentIds: readonly AgentId[] = Object.freeze([
  'wiki_curator', 'wiki_answerer', 'wiki_linter', 'wiki_reconciler', 'wiki_brief_writer',
  'source_extractor', 'decision_memo_writer', 'architecture_reviewer', 'wiki_auditor',
])

const workflowTarget = {
  ingest_source: 'ingestSource', ask_wiki: 'askWiki', lint_wiki: 'lintWiki',
  reconcile_contradiction: 'reconcileContradiction', generate_research_brief: 'generateResearchBrief',
  decision_memo: 'decisionMemo', architecture_review: 'architectureReview', wiki_audit: 'wikiAudit',
} as const
const agentTarget = {
  wiki_curator: 'wikiCurator', wiki_answerer: 'wikiAnswerer', wiki_linter: 'wikiLinter',
  wiki_reconciler: 'wikiReconciler', wiki_brief_writer: 'wikiBriefWriter', source_extractor: 'sourceExtractor',
  decision_memo_writer: 'decisionMemoWriter', architecture_reviewer: 'architectureReviewer', wiki_auditor: 'wikiAuditor',
} as const

export function resolveWorkflowTarget(id: WorkflowId) { return workflowTarget[id] }
export function resolveAgentTarget(id: AgentId) { return agentTarget[id] }

export function loadRootEnv(): void { loadRepositoryRootEnv(exampleRoot) }
function requireOpenAiKey(): string { return requireRepositoryOpenAiKey(exampleRoot) }

export class ScriptedLivingWikiProvider implements ModelProvider {
  public readonly id = 'scripted-living-wiki'
  public readonly genAiSystem = 'fake'
  public readonly requests: ObjectRequest[] = []
  public constructor(private readonly options: { delayMs?: number } = {}) {}
  async object<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.requests.push(req)
    if (this.options.delayMs) await new Promise((resolveDelay, reject) => {
      const timeout = setTimeout(resolveDelay, this.options.delayMs)
      req.signal.addEventListener('abort', () => { clearTimeout(timeout); reject(req.signal.reason ?? new Error('cancelled')) }, { once: true })
    })
    const text = JSON.stringify(req.messages).toLowerCase()
    const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30 }
    if (text.includes('ingest_source')) return { object: objectData({ updatedPages: ['jaeger'], extractedConcepts: ['jaeger'], followUpQuestions: ['Which service owns trace retention?'], proposedChanges: [auditNoteChange('ingest-change-1')], contradictions: [], citedEvidence: [sourceEvidence()], panelSpec: makePanelSpec('Source Ingest', [{ heading: 'Needs Review', items: ['1 proposed Jaeger page update'] }]) }) as T, usage, finishReason: 'stop' }
    if (text.includes('lint_wiki')) return { object: objectData({ orphanPages: [], missingBacklinks: [], weakClaims: [], staleNotes: [], duplicateConcepts: [], panelSpec: makePanelSpec('Lint Report', [{ heading: 'Status', items: ['No blocking wiki issues found.'] }]) }) as T, usage, finishReason: 'stop' }
    if (text.includes('reconcile_contradiction')) return { object: objectData({ summary: 'The conflict is recorded and left with a narrow follow-up.', changedPages: ['jaeger'], unresolvedQuestions: ['Confirm the authoritative wording.'] }) as T, usage, finishReason: 'stop' }
    if (text.includes('generate_research_brief')) return { object: objectData({ markdown: '## Research Brief\n\nJaeger traces make local harness runs observable.', panelSpec: makePanelSpec('Research Brief', [{ heading: 'Cited Pages', items: ['jaeger'] }]), citedPages: ['jaeger'] }) as T, usage, finishReason: 'stop' }
    if (text.includes('decision_memo')) return { object: objectData(decisionMemoFixture()) as T, usage, finishReason: 'stop' }
    if (text.includes('architecture_review')) return { object: objectData(architectureReviewFixture()) as T, usage, finishReason: 'stop' }
    if (text.includes('wiki_audit')) return { object: objectData(wikiAuditFixture()) as T, usage, finishReason: 'stop' }
    return { object: objectData({ answer: 'Jaeger stores and visualizes traces for local harness workflow runs.', citedPages: ['jaeger'], confidenceNotes: ['Fake provider response for hermetic tests.'] }) as T, usage, finishReason: 'stop' }
  }
  async *objectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    const response = await this.object(req)
    yield { kind: 'partial', partial: response.object }
    yield { kind: 'finish', object: response.object, usage: response.usage, finishReason: response.finishReason }
  }
}

export function createScriptedLivingWikiProvider(options: { delayMs?: number } = {}) { return new ScriptedLivingWikiProvider(options) }

const drawioDiagramInputSchema = z.object({
  title: z.string().min(1),
  nodes: z.array(z.string().min(1)).min(1),
})
const drawioDiagramOutputSchema = z.object({ xml: z.string().min(1) })

/** Optional remote diagram capability selected explicitly by the architecture-review agent. */
export const drawioMcpServer = defineMcpServer('drawio', {
  tools: {
    createDrawioDiagram: {
      remoteName: 'create_drawio_diagram',
      description: 'Create a draw.io XML diagram from a title and labeled nodes.',
      input: drawioDiagramInputSchema,
      output: drawioDiagramOutputSchema,
    },
  },
})

export interface LivingWikiHarnessOptions {
  dataRoot?: string
  provider?: ModelProvider
  model?: string
  store?: FileWikiStore
  /** Runtime-only HTTP or stdio transport for the optional draw.io MCP server. */
  drawioMcp?: McpBinding
}

export async function createLivingWikiHarness(options: LivingWikiHarnessOptions = {}) {
  loadRootEnv()
  const model = options.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-mini'
  const provider = options.provider ?? openai({ apiKey: requireOpenAiKey() })
  const dataRoot = options.dataRoot ?? join(exampleRoot, 'data')
  const store = options.store ?? createFileWikiStore({ dataDir: dataRoot })
  const storage = sqliteHarnessStorage({ file: join(dataRoot, 'harness.sqlite') })
  const skillsRoot = join(exampleRoot, 'skills')
  const tools = createLivingWikiTools(store)
  const readTools = [tools.readSource, tools.searchWiki, tools.readWikiPage, tools.listBacklinks, tools.renderPanelSpec] as const
  const answerTools = [...readTools, tools.writeWikiPage] as const
  const drawioMcpBinding = options.drawioMcp ?? drawioMcpBindingFromEnvironment()
  const baseInstructions = 'Use the mounted skills and tools to ground the answer in the local wiki. Return only data matching the output schema.'
  const wikiCurator = defineAgent('wikiCurator', { model: 'wikiModel', input: ingestSourceInputSchema, output: ingestSourceOutputSchema, tools: readTools, instructions: `${baseInstructions} Workflow: ingest_source.`, prompt: input => ({ role: 'user', content: JSON.stringify(input) }) })
  const sourceExtractor = defineAgent('sourceExtractor', { model: 'wikiModel', input: ingestSourceInputSchema, output: ingestSourceOutputSchema, tools: readTools, instructions: `${baseInstructions} Workflow: ingest_source. Plan source extraction and proposed page changes.`, prompt: input => ({ role: 'user', content: JSON.stringify(input) }) })
  const wikiAnswerer = defineAgent('wikiAnswerer', {
    model: 'wikiModel', input: askWikiInputSchema, output: askWikiOutputSchema, tools: answerTools,
    instructions: `${baseInstructions} Workflow: ask_wiki. Ask for approval before applying any requested page change.`,
    prompt: input => ({ role: 'user', content: JSON.stringify(input) }),
    governance: ({ native, rule }) => ({
      defaultEffect: 'allow',
      policies: [native({
        id: 'wikiWritePolicy',
        rules: [rule({ id: 'approveWikiWrite', tools: ['writeWikiPage'], effect: 'require_approval', reasonCode: 'wiki_write' })],
      })],
    }),
  })
  const wikiLinter = defineAgent('wikiLinter', { model: 'wikiModel', input: lintWikiInputSchema, output: lintWikiOutputSchema, tools: readTools, instructions: `${baseInstructions} Workflow: lint_wiki.`, prompt: input => ({ role: 'user', content: JSON.stringify(input) }) })
  const wikiReconciler = defineAgent('wikiReconciler', { model: 'wikiModel', input: reconcileContradictionInputSchema, output: reconcileContradictionOutputSchema, tools: readTools, instructions: `${baseInstructions} Workflow: reconcile_contradiction.`, prompt: input => ({ role: 'user', content: JSON.stringify(input) }) })
  const wikiBriefWriter = defineAgent('wikiBriefWriter', { model: 'wikiModel', input: generateResearchBriefInputSchema, output: generateResearchBriefOutputSchema, tools: readTools, instructions: `${baseInstructions} Workflow: generate_research_brief.`, prompt: input => ({ role: 'user', content: JSON.stringify(input) }) })
  const decisionMemoWriter = defineAgent('decisionMemoWriter', { model: 'wikiModel', input: decisionMemoInputSchema, output: decisionMemoOutputSchema, tools: readTools, instructions: `${baseInstructions} Workflow: decision_memo.`, prompt: input => ({ role: 'user', content: JSON.stringify(input) }) })
  const architectureReviewer = defineAgent('architectureReviewer', { model: 'wikiModel', input: architectureReviewInputSchema, output: architectureReviewOutputSchema, tools: readTools, instructions: `${baseInstructions} Workflow: architecture_review.`, prompt: input => ({ role: 'user', content: JSON.stringify(input) }) })
  const architectureReviewerWithDrawio = defineAgent('architectureReviewer', { model: 'wikiModel', input: architectureReviewInputSchema, output: architectureReviewOutputSchema, tools: [...readTools, drawioMcpServer.tools.createDrawioDiagram], instructions: `${baseInstructions} Workflow: architecture_review. Use createDrawioDiagram when a remote draw.io server is available.`, prompt: input => ({ role: 'user', content: JSON.stringify(input) }) })
  const wikiAuditor = defineAgent('wikiAuditor', { model: 'wikiModel', input: wikiQualityAuditInputSchema, output: wikiQualityAuditOutputSchema, tools: readTools, instructions: `${baseInstructions} Workflow: wiki_audit.`, prompt: input => ({ role: 'user', content: JSON.stringify(input) }) })

  const ingestSource = defineWorkflow('ingestSource', { input: ingestSourceInputSchema, output: ingestSourceOutputSchema, agents: [sourceExtractor], async handler(ctx) { await store.readSource(ctx.input.sourceSlug); const output = ingestSourceOutputSchema.parse(await ctx.agents.sourceExtractor.run(ctx.input, { callId: 'extractSource' })); return { ...output, reviewRequest: withRunId(output.reviewRequest ?? reviewRequest(ctx.runId, 'source-ingest', 'Review source ingest changes', 'Approve extracted wiki edits before applying them.'), ctx.runId), phases: phases('sourceExtractor') } } })
  const askWiki = defineWorkflow('askWiki', { input: askWikiInputSchema, output: askWikiOutputSchema, agents: [wikiAnswerer], handler: ctx => ctx.agents.wikiAnswerer.run(ctx.input, { callId: 'answerWiki' }) })
  const lintWiki = defineWorkflow('lintWiki', { input: lintWikiInputSchema, output: lintWikiOutputSchema, agents: [wikiLinter], handler: ctx => ctx.agents.wikiLinter.run(ctx.input, { callId: 'lintWiki' }) })
  const reconcileContradiction = defineWorkflow('reconcileContradiction', { input: reconcileContradictionInputSchema, output: reconcileContradictionOutputSchema, agents: [wikiReconciler], async handler(ctx) { await store.readWikiPage(ctx.input.leftRef); await store.readWikiPage(ctx.input.rightRef); const output = await ctx.agents.wikiReconciler.run(ctx.input, { callId: 'reconcileWiki' }); await store.appendLog({ workflow: 'reconcile_contradiction', message: ctx.input.conflict, pages: output.changedPages }); return output } })
  const generateResearchBrief = defineWorkflow('generateResearchBrief', { input: generateResearchBriefInputSchema, output: generateResearchBriefOutputSchema, agents: [wikiBriefWriter], async handler(ctx) { const pages = await Promise.all(ctx.input.pageSlugs.map(slug => store.readWikiPage(slug))); const output = generateResearchBriefOutputSchema.parse(await ctx.agents.wikiBriefWriter.run(ctx.input, { callId: 'writeBrief' })); const markdown = researchBriefMarkdown(ctx.input.goal, pages.map(page => page.slug), output.markdown); const panelSpec = output.panelSpec ?? makePanelSpec('Research Brief', [{ heading: 'Cited Pages', items: output.citedPages }]); const artifacts = await createStudioArtifactSet(store, { runId: ctx.runId, baseTitle: 'Research Brief', markdown, panelSpec, sourcePageIds: output.citedPages, mermaid: researchBriefMermaid(output.citedPages), drawioXml: drawioArchitectureXml('Research Brief Studio', ['Evidence', 'Synthesis', 'Risks', 'Next actions'], 'Research brief') }); return generateResearchBriefOutputSchema.parse({ ...output, markdown, panelSpec, artifacts: [...(output.artifacts ?? []), ...artifacts], phases: phases('wikiBriefWriter') }) } })
  const decisionMemo = defineWorkflow('decisionMemo', { input: decisionMemoInputSchema, output: decisionMemoOutputSchema, agents: [decisionMemoWriter], async handler(ctx) { const output = decisionMemoOutputSchema.parse(await ctx.agents.decisionMemoWriter.run(ctx.input, { callId: 'writeDecisionMemo' })); const markdown = decisionMemoMarkdown(ctx.input.proposal, output); const panelSpec = output.panelSpec ?? makePanelSpec('Decision Memo', [{ heading: 'Recommendation', items: [output.recommendation] }]); const artifacts = await createStudioArtifactSet(store, { runId: ctx.runId, baseTitle: 'Decision Memo', markdown, panelSpec, sourcePageIds: citedPageIds(output.citedEvidence), mermaid: decisionMemoMermaid(output.recommendation), drawioXml: drawioArchitectureXml('Decision Memo Studio', ['Proposal', 'Options', 'Recommendation', 'Pilot plan'], `Recommendation: ${output.recommendation}`) }); return decisionMemoOutputSchema.parse({ ...output, ...(output.reviewRequest ? { reviewRequest: withRunId(output.reviewRequest, ctx.runId) } : {}), markdown, panelSpec, artifacts: [...output.artifacts, ...artifacts], phases: phases('decisionMemoWriter') }) } })
  const architectureReview = defineWorkflow('architectureReview', { input: architectureReviewInputSchema, output: architectureReviewOutputSchema, agents: [architectureReviewer], async handler(ctx) { if (ctx.input.sourceSlug) await store.readSource(ctx.input.sourceSlug); if (ctx.input.pageSlug) await store.readWikiPage(ctx.input.pageSlug); const output = architectureReviewOutputSchema.parse(await ctx.agents.architectureReviewer.run(ctx.input, { callId: 'reviewArchitecture' })); const markdown = architectureReviewMarkdown(ctx.input.focus, output); const panelSpec = output.panelSpec ?? makePanelSpec('Architecture Review', [{ heading: 'Readiness', items: [output.readiness] }]); const artifacts = await createStudioArtifactSet(store, { runId: ctx.runId, baseTitle: 'Architecture Review', markdown, panelSpec, sourcePageIds: ctx.input.pageSlug ? [ctx.input.pageSlug] : citedPageIds(output.citedEvidence), mermaid: architectureReviewMermaid(output.readiness), drawioXml: drawioArchitectureXml('Architecture Board Studio', ['API surface', 'Data ownership', 'Operations', 'Security', 'Migration', 'Observability'], `Readiness: ${output.readiness}`) }); return architectureReviewOutputSchema.parse({ ...output, ...(output.reviewRequest ? { reviewRequest: withRunId(output.reviewRequest, ctx.runId) } : {}), markdown, panelSpec, artifacts: [...output.artifacts, ...artifacts], phases: phases('architectureReviewer') }) } })
  const architectureReviewWithDrawio = defineWorkflow('architectureReview', { input: architectureReviewInputSchema, output: architectureReviewOutputSchema, agents: [architectureReviewerWithDrawio], async handler(ctx) { if (ctx.input.sourceSlug) await store.readSource(ctx.input.sourceSlug); if (ctx.input.pageSlug) await store.readWikiPage(ctx.input.pageSlug); const output = architectureReviewOutputSchema.parse(await ctx.agents.architectureReviewer.run(ctx.input, { callId: 'reviewArchitecture' })); const markdown = architectureReviewMarkdown(ctx.input.focus, output); const panelSpec = output.panelSpec ?? makePanelSpec('Architecture Review', [{ heading: 'Readiness', items: [output.readiness] }]); const artifacts = await createStudioArtifactSet(store, { runId: ctx.runId, baseTitle: 'Architecture Review', markdown, panelSpec, sourcePageIds: ctx.input.pageSlug ? [ctx.input.pageSlug] : citedPageIds(output.citedEvidence), mermaid: architectureReviewMermaid(output.readiness), drawioXml: drawioArchitectureXml('Architecture Board Studio', ['API surface', 'Data ownership', 'Operations', 'Security', 'Migration', 'Observability'], `Readiness: ${output.readiness}`) }); return architectureReviewOutputSchema.parse({ ...output, ...(output.reviewRequest ? { reviewRequest: withRunId(output.reviewRequest, ctx.runId) } : {}), markdown, panelSpec, artifacts: [...output.artifacts, ...artifacts], phases: phases('architectureReviewer') }) } })
  const wikiAudit = defineWorkflow('wikiAudit', { input: wikiQualityAuditInputSchema, output: wikiQualityAuditOutputSchema, agents: [wikiAuditor], async handler(ctx) { const output = wikiQualityAuditOutputSchema.parse(await ctx.agents.wikiAuditor.run(ctx.input, { callId: 'auditWiki' })); return { ...output, reviewRequest: withRunId(output.reviewRequest, ctx.runId), phases: phases('wikiAuditor') } } })

  const definition = defineHarness({ name: 'livingWikiJaegerExample', revision: 'v1' })
    .addAgent(wikiCurator).addAgent(sourceExtractor).addAgent(wikiAnswerer).addAgent(wikiLinter)
    .addAgent(wikiReconciler).addAgent(wikiBriefWriter).addAgent(decisionMemoWriter).addAgent(wikiAuditor)
    .addWorkflow(ingestSource).addWorkflow(askWiki).addWorkflow(lintWiki).addWorkflow(reconcileContradiction)
    .addWorkflow(generateResearchBrief).addWorkflow(decisionMemo).addWorkflow(wikiAudit)
  const runtime = { models: { wikiModel: { provider, model } }, storage, logger: new JsonLogger({ level: 'info' }), telemetry: { flavor: 'dual' as const, contentCaptureMode: 'NO_CONTENT' as const } }
  try {
    const harness = drawioMcpBinding === undefined
      ? await definition.addAgent(architectureReviewer).addWorkflow(architectureReview).getInstance(runtime)
      : await definition.addAgent(architectureReviewerWithDrawio).addWorkflow(architectureReviewWithDrawio).getInstance({ ...runtime, mcp: { drawio: drawioMcpBinding } })
    return { harness, store, provider, model, storage }
  } catch (error) {
    await storage.close().catch(() => undefined)
    throw error
  }
}

function sourceEvidence() {
  return {
    id: 'evidence-jaeger-source',
    title: 'Jaeger Source',
    sourceType: 'uploaded_source' as const,
    reference: 'jaeger',
    quoteOrSummary: 'Jaeger stores traces for local harness runs.',
    confidence: 'high' as const,
  }
}

function judgeFixture(verdict: 'approved' | 'needs_human_review' | 'revise' | 'rejected' = 'approved') {
  return {
    score: verdict === 'approved' ? 8 : 6,
    maxScore: 10,
    verdict,
    criteria: [
      {
        id: 'evidence',
        label: 'Evidence grounding',
        score: verdict === 'approved' ? 4 : 3,
        maxScore: 5,
        rationale: 'Uses wiki and source evidence.',
      },
      {
        id: 'risk',
        label: 'Risk coverage',
        score: verdict === 'approved' ? 4 : 3,
        maxScore: 5,
        rationale: 'Calls out operational follow-ups.',
      },
    ],
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
    citations: [
      {
        id: `${id}-citation`,
        pageId: 'jaeger',
        sourceRef: 'jaeger',
        claim: 'Trace retention ownership remains an open operational question.',
        operation: 'add',
      },
    ],
    risk: 'low',
    targetRefs: ['page:jaeger'],
  }
}

function reviewRequest(runId: string, idSuffix: string, title: string, reason: string): ReviewRequest {
  return {
    id: `review-${idSuffix}`,
    runId,
    title,
    reason,
    questions: [
      {
        id: 'approval',
        label: 'Apply the proposed changes?',
        kind: 'approval',
        required: true,
      },
    ],
    defaultDecision: 'approve',
  }
}

function withRunId(request: ReviewRequest, runId: string): ReviewRequest {
  return { ...request, runId }
}

function phases(agentId: string) {
  const now = new Date().toISOString()
  return [
    {
      phase: 'plan' as const,
      status: 'completed' as const,
      agentId,
      summary: 'Planned the analysis scope.',
      startedAt: now,
      finishedAt: now,
    },
    {
      phase: 'retrieve' as const,
      status: 'completed' as const,
      agentId,
      summary: 'Retrieved wiki/source evidence.',
      startedAt: now,
      finishedAt: now,
    },
    {
      phase: 'reason' as const,
      status: 'completed' as const,
      agentId,
      summary: 'Produced the structured output.',
      startedAt: now,
      finishedAt: now,
    },
    {
      phase: 'reflect' as const,
      status: 'completed' as const,
      agentId,
      summary: 'Checked for unsupported claims.',
      startedAt: now,
      finishedAt: now,
    },
    {
      phase: 'judge' as const,
      status: 'completed' as const,
      agentId,
      summary: 'Scored the result with a rubric.',
      startedAt: now,
      finishedAt: now,
    },
  ]
}

function decisionMemoFixture(): DecisionMemoOutput {
  return {
    markdown:
      '## Decision Memo\n\nPilot Jaeger tracing for local harness workflow observability before broad adoption.',
    recommendation: 'pilot',
    citedEvidence: [sourceEvidence()],
    risks: ['Trace retention ownership must be explicit.'],
    counterarguments: ['A simpler log-only setup may be enough for small local demos.'],
    openQuestions: ['Who owns trace retention settings?'],
    nextActions: ['Run a one-week pilot with Jaeger enabled.'],
    judge: judgeFixture('approved'),
    artifacts: [],
    panelSpec: makePanelSpec('Decision Memo', [{ heading: 'Recommendation', items: ['Pilot Jaeger tracing'] }]),
  }
}

function architectureReviewFixture(): ArchitectureReviewOutput {
  return {
    markdown:
      '## Architecture Review\n\nThe RFC is directionally sound but needs explicit retention, ownership, and rollout criteria.',
    readiness: 'changes_requested',
    blockingIssues: ['Define trace retention ownership.'],
    nonBlockingIssues: ['Add rollout success metrics.'],
    requiredFollowUps: ['Document retention configuration and operational owner.'],
    citedEvidence: [sourceEvidence()],
    judge: judgeFixture('needs_human_review'),
    artifacts: [],
    reviewRequest: reviewRequest(
      'pending-run',
      'architecture-review',
      'Review architecture board decision',
      'Confirm whether requested changes are sufficient.',
    ),
    panelSpec: makePanelSpec('Architecture Review', [{ heading: 'Readiness', items: ['Changes requested'] }]),
  }
}

function wikiAuditFixture(): WikiQualityAuditOutput {
  return {
    markdown:
      '## Wiki Audit\n\nThe wiki is mostly coherent. Add a low-risk retention ownership note to the Jaeger page.',
    proposedChanges: [auditNoteChange()],
    citedEvidence: [sourceEvidence()],
    judge: judgeFixture('needs_human_review'),
    graphHighlights: [
      {
        nodeIds: ['page:jaeger'],
        edgeIds: [],
        kind: 'changed',
        label: 'Proposed Jaeger page update',
      },
    ],
    reviewRequest: reviewRequest(
      'pending-run',
      'wiki-audit',
      'Review wiki audit changes',
      'Audit changes are proposed only and require approval before mutation.',
    ),
    panelSpec: makePanelSpec('Wiki Audit', [
      { heading: 'Proposed Changes', items: ['Add trace retention ownership note'] },
    ]),
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
    panelSpec: JsonValue
    sourcePageIds: string[]
  },
): Promise<ResearchArtifact[]> {
  const jsonPanel = JSON.stringify(args.panelSpec, null, 2)
  return Promise.all([
    createWorkflowArtifact(
      store,
      args.runId,
      `${args.baseTitle} Document`,
      'markdown',
      'text/markdown',
      args.markdown,
      args.sourcePageIds,
      {
        renderMode: 'document',
        content: args.markdown,
      },
    ),
    createWorkflowArtifact(
      store,
      args.runId,
      `${args.baseTitle} Mermaid Map`,
      'mermaid',
      'text/vnd.mermaid',
      args.mermaid,
      args.sourcePageIds,
      {
        content: args.mermaid,
      },
    ),
    createWorkflowArtifact(
      store,
      args.runId,
      `${args.baseTitle} draw.io Board`,
      'drawio_xml',
      'application/vnd.jgraph.mxfile',
      args.drawioXml,
      args.sourcePageIds,
      {
        renderMode: 'document',
        content: args.drawioXml,
        drawioEditorUrl: drawioEditorUrl(args.drawioXml),
        viewerConfig: {
          mode: 'viewer',
          page: args.baseTitle,
          mcpFallback: drawioMcpStatus(),
        },
      },
    ),
    createWorkflowArtifact(
      store,
      args.runId,
      `${args.baseTitle} JSON Panel`,
      'json_panel',
      'application/json',
      jsonPanel,
      args.sourcePageIds,
      {
        panelSpec: args.panelSpec,
        data: args.panelSpec,
        content: jsonPanel,
      },
    ),
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
    panelSpec?: JsonValue
    data?: JsonValue
    drawioEditorUrl?: string
    viewerConfig?: Record<string, JsonValue>
  } = {},
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
    ...(options.viewerConfig ? { viewerConfig: options.viewerConfig } : {}),
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
    ...(manifest.viewerConfig ? { viewerConfig: manifest.viewerConfig } : {}),
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
    ...citedPages.map((slug) => `- [[${slug}]]`),
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
    ...output.nextActions.map((action) => `- ${action}`),
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
    ...output.requiredFollowUps.map((item) => `- ${item}`),
  ].join('\n')
}

function researchBriefMermaid(citedPages: string[]): string {
  const pages = citedPages.length ? citedPages : ['wiki']
  return [
    'graph LR',
    '  evidence["Selected evidence"] --> synthesis["Research synthesis"]',
    '  synthesis --> risks["Risks and unknowns"]',
    '  synthesis --> actions["Next actions"]',
    ...pages.map((slug, index) => `  page${index}["[[${escapeMermaid(slug)}]]"] --> evidence`),
  ].join('\n')
}

function decisionMemoMermaid(recommendation: DecisionMemoOutput['recommendation']): string {
  return [
    'graph LR',
    '  proposal["Proposal"] --> criteria["Decision criteria"]',
    '  criteria --> evidence["Evidence"]',
    '  evidence --> options["Options"]',
    `  options --> recommendation["Recommendation: ${recommendation}"]`,
    '  recommendation --> next["Pilot / next actions"]',
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
    '  observability --> readiness',
  ].join('\n')
}

function drawioArchitectureXml(title: string, nodes: string[], conclusion: string): string {
  const cells = [
    '<mxCell id="0"/>',
    '<mxCell id="1" parent="0"/>',
    ...nodes.map((label, index) =>
      drawioVertex(`node-${index}`, label, 40 + (index % 3) * 210, 80 + Math.floor(index / 3) * 110),
    ),
    drawioVertex(
      'conclusion',
      conclusion,
      250,
      330,
      'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
    ),
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
    '</mxfile>',
  ].join('\n')
}

function drawioVertex(
  id: string,
  label: string,
  x: number,
  y: number,
  style = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;',
): string {
  return `<mxCell id="${xmlAttr(id)}" value="${xmlAttr(label)}" style="${xmlAttr(style)}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="160" height="64" as="geometry"/></mxCell>`
}

function drawioEdge(id: string, source: string, target: string): string {
  return `<mxCell id="${xmlAttr(id)}" style="endArrow=block;html=1;rounded=0;" edge="1" parent="1" source="${xmlAttr(source)}" target="${xmlAttr(target)}"><mxGeometry relative="1" as="geometry"/></mxCell>`
}

function xmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeMermaid(value: string): string {
  return value.replaceAll('"', '\\"')
}

function slugId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'diagram'
  )
}

function citedPageIds(evidence: Array<{ sourceType: string; reference: string }>): string[] {
  return [
    ...new Set(
      evidence
        .filter((item) => item.sourceType === 'wiki_page' && slugSchema.safeParse(item.reference).success)
        .map((item) => item.reference),
    ),
  ]
}

function drawioMcpStatus(): string {
  const mcpConfigured = Boolean(process.env['LIVING_WIKI_DRAWIO_MCP_URL'])
  return mcpConfigured ? 'configured-optional-tool' : 'unavailable-mermaid-is-canonical'
}

/** Reads the optional draw.io MCP HTTP transport without placing secrets in the definition. */
export function drawioMcpBindingFromEnvironment(): McpBinding | undefined {
  const url = process.env['LIVING_WIKI_DRAWIO_MCP_URL']?.trim()
  if (!url) return undefined
  const token = process.env['LIVING_WIKI_DRAWIO_MCP_AUTH_TOKEN']?.trim()
  return Object.freeze({
    transport: 'http' as const,
    url,
    ...(token ? { headers: Object.freeze({ authorization: `Bearer ${token}` }) } : {}),
  })
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
