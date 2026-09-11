import { z } from 'zod'

export const slugPattern = /^[a-z0-9][a-z0-9-]{0,79}$/

export const slugSchema = z.string().regex(slugPattern, 'Invalid slug.')

export const pageRefSchema = z.object({
  slug: slugSchema,
  title: z.string(),
  summary: z.string(),
})

export const markdownDocumentSchema = pageRefSchema.extend({
  content: z.string(),
})

export const searchWikiInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(25).default(10),
})

export const searchWikiOutputSchema = z.object({
  results: z.array(
    pageRefSchema.extend({
      score: z.number(),
      snippet: z.string(),
    }),
  ),
})

export const backlinksOutputSchema = z.object({
  target: slugSchema,
  pages: z.array(pageRefSchema),
})

/** Arbitrary panel payloads still cross Harness boundaries as strict JSON. */
export const panelSpecSchema = z.json()

export const workflowPhaseSchema = z.enum(['plan', 'retrieve', 'reason', 'reflect', 'judge', 'human_review', 'publish'])

export const workflowPhaseStatusSchema = z.object({
  phase: workflowPhaseSchema,
  status: z.enum(['pending', 'running', 'completed', 'blocked', 'failed']),
  agentId: z.string().optional(),
  summary: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
})

export const evidenceItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sourceType: z.enum(['wiki_page', 'uploaded_source', 'artifact', 'mcp_result']),
  reference: z.string().min(1),
  quoteOrSummary: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
})

export const reviewQuestionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['single_choice', 'multi_choice', 'free_text', 'approval']),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        recommended: z.boolean().optional(),
      }),
    )
    .optional(),
  required: z.boolean().default(true),
})

export const reviewRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  title: z.string().min(1),
  reason: z.string().min(1),
  questions: z.array(reviewQuestionSchema),
  defaultDecision: z.enum(['approve', 'revise', 'reject']),
})

export const reviewDecisionSchema = z
  .object({
    reviewRequestId: z.string().min(1),
    decision: z.enum(['accept_all', 'reject_all', 'accept_selected', 'choose_alternative', 'custom_guidance']),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.boolean()])),
    acceptedChangeIds: z.array(z.string()).optional(),
    selectedAlternativeIds: z.array(z.string()).optional(),
    guidance: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'accept_selected' && !value.acceptedChangeIds?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['acceptedChangeIds'],
        message: 'acceptedChangeIds is required for accept_selected.',
      })
    }
    if (value.decision === 'choose_alternative' && !value.selectedAlternativeIds?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['selectedAlternativeIds'],
        message: 'selectedAlternativeIds is required for choose_alternative.',
      })
    }
    if (value.decision === 'custom_guidance' && !value.guidance?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['guidance'], message: 'guidance is required for custom_guidance.' })
    }
  })

export const reviewAnswerSchema = z.object({
  reviewRequestId: z.string().min(1),
  questionId: z.string().min(1),
  value: z.union([z.string(), z.array(z.string()), z.boolean()]),
})

export const reviewOutcomeSchema = z.object({
  reviewRequestId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(['applied', 'rejected', 'revision_started']),
  appliedChangeIds: z.array(z.string()),
  followUpRunId: z.string().optional(),
  logEntryId: z.string().min(1),
})

export const judgeRubricSchema = z.object({
  score: z.number(),
  maxScore: z.number().positive(),
  verdict: z.enum(['approved', 'needs_human_review', 'revise', 'rejected']),
  criteria: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      score: z.number(),
      maxScore: z.number().positive(),
      rationale: z.string().min(1),
    }),
  ),
})

export const artifactKindSchema = z.enum(['markdown', 'mermaid', 'svg', 'drawio_xml', 'json_panel'])
export const artifactRenderModeSchema = z.enum(['inline', 'document', 'download'])

export const researchArtifactSchema = z.object({
  id: z.string().min(1),
  kind: artifactKindSchema,
  title: z.string().min(1),
  mimeType: z.string().min(1),
  contentRef: z.string().min(1),
  createdAt: z.string().min(1),
  generatedByRunId: z.string().min(1),
  content: z.string().optional(),
  panelSpec: z.json().optional(),
  data: z.json().optional(),
  renderMode: artifactRenderModeSchema.optional(),
  drawioEditorUrl: z.string().url().optional(),
  viewerConfig: z.record(z.string(), z.json()).optional(),
})

export const artifactManifestSchema = z.object({
  artifactId: z.string().min(1),
  kind: artifactKindSchema,
  title: z.string().min(1),
  contentType: z.string().min(1),
  storagePath: z.string().min(1),
  createdByRunId: z.string().min(1),
  sourcePageIds: z.array(slugSchema),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().min(1),
  renderMode: artifactRenderModeSchema,
  drawioEditorUrl: z.string().url().optional(),
  viewerConfig: z.record(z.string(), z.json()).optional(),
})

export const citationChangeSchema = z.object({
  id: z.string().min(1),
  pageId: slugSchema,
  sourceRef: z.string().min(1),
  claim: z.string().min(1),
  operation: z.enum(['add', 'update', 'remove']),
})

export const proposedPageChangeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['create_page', 'update_page', 'merge_pages', 'add_citation', 'mark_stale']),
  targetPageId: slugSchema.optional(),
  title: z.string().min(1),
  beforeMarkdown: z.string().optional(),
  afterMarkdown: z.string().optional(),
  rationale: z.string().min(1),
  citations: z.array(citationChangeSchema),
  risk: z.enum(['low', 'medium', 'high']),
  targetRefs: z.array(z.string()).optional(),
})

export const contradictionSchema = z.object({
  id: z.string().min(1),
  claimA: z.string().min(1),
  claimB: z.string().min(1),
  refs: z.array(z.string().min(1)),
  severity: z.enum(['low', 'medium', 'high']),
})

export const graphNodeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(['page', 'source', 'concept', 'artifact']),
    ref: z.string().min(1),
  })
  .passthrough()

export const graphEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    kind: z.enum(['wiki_link', 'citation', 'derived_relationship', 'artifact_reference']),
    weight: z.number(),
  })
  .passthrough()

export const graphHighlightSchema = z.object({
  nodeIds: z.array(z.string()),
  edgeIds: z.array(z.string()),
  kind: z.enum(['cited', 'changed', 'contradiction', 'orphan', 'merge_candidate']),
  label: z.string().min(1),
})

export const graphResponseSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  highlights: z.array(graphHighlightSchema),
  latestRunId: z.string().optional(),
  panelSpec: z.json(),
})

export const agentRunRequestSchema = z.object({
  input: z.json(),
  sessionId: z.string().optional(),
  stream: z.boolean().optional(),
})

export const artifactCreateRequestSchema = z.object({
  kind: artifactKindSchema,
  title: z.string().min(1),
  contentType: z.string().min(1),
  content: z.string().min(1),
  sourcePageIds: z.array(slugSchema).optional(),
  renderMode: artifactRenderModeSchema.optional(),
  drawioEditorUrl: z.string().url().optional(),
  viewerConfig: z.record(z.string(), z.json()).optional(),
})

export const ingestSourceInputSchema = z.object({
  sourceSlug: slugSchema,
})

export const ingestSourceOutputSchema = z.object({
  updatedPages: z.array(slugSchema),
  extractedConcepts: z.array(z.string()),
  followUpQuestions: z.array(z.string()),
  proposedChanges: z.array(proposedPageChangeSchema).optional(),
  contradictions: z.array(contradictionSchema).optional(),
  citedEvidence: z.array(evidenceItemSchema).optional(),
  reviewRequest: reviewRequestSchema.optional(),
  phases: z.array(workflowPhaseStatusSchema).optional(),
  panelSpec: z.json().optional(),
})

export const askWikiInputSchema = z.object({
  question: z.string().min(1).max(4_000),
})

export const askWikiOutputSchema = z.object({
  answer: z.string(),
  citedPages: z.array(slugSchema),
  confidenceNotes: z.array(z.string()),
})

export const lintWikiInputSchema = z.object({
  scope: z.union([z.literal('all'), z.array(slugSchema)]).optional(),
})

export const lintWikiOutputSchema = z.object({
  orphanPages: z.array(slugSchema),
  missingBacklinks: z.array(z.object({ from: slugSchema, to: slugSchema })),
  weakClaims: z.array(z.object({ page: slugSchema, claim: z.string(), reason: z.string() })),
  staleNotes: z.array(z.object({ page: slugSchema, reason: z.string() })),
  duplicateConcepts: z.array(z.object({ pages: z.array(slugSchema), reason: z.string() })),
  panelSpec: panelSpecSchema,
})

export const reconcileContradictionInputSchema = z.object({
  leftRef: slugSchema,
  rightRef: slugSchema,
  conflict: z.string().min(1).max(4_000),
})

export const reconcileContradictionOutputSchema = z.object({
  summary: z.string(),
  changedPages: z.array(slugSchema),
  unresolvedQuestions: z.array(z.string()),
})

export const generateResearchBriefInputSchema = z.object({
  pageSlugs: z.array(slugSchema).min(1).max(20),
  goal: z.string().min(1).max(4_000),
})

export const generateResearchBriefOutputSchema = z.object({
  markdown: z.string(),
  panelSpec: panelSpecSchema,
  citedPages: z.array(slugSchema),
  artifacts: z.array(researchArtifactSchema).default([]),
  phases: z.array(workflowPhaseStatusSchema).optional(),
})

export const decisionMemoInputSchema = z.object({
  proposal: z.string().min(1).max(4_000),
  question: z.string().min(1).max(4_000).optional(),
})

export const decisionMemoOutputSchema = z.object({
  markdown: z.string(),
  recommendation: z.enum(['adopt', 'pilot', 'defer', 'reject']),
  citedEvidence: z.array(evidenceItemSchema),
  risks: z.array(z.string()),
  counterarguments: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextActions: z.array(z.string()),
  judge: judgeRubricSchema,
  artifacts: z.array(researchArtifactSchema),
  reviewRequest: reviewRequestSchema.optional(),
  panelSpec: z.json(),
  phases: z.array(workflowPhaseStatusSchema).optional(),
})

export const architectureReviewInputSchema = z
  .object({
    sourceSlug: slugSchema.optional(),
    pageSlug: slugSchema.optional(),
    focus: z.string().min(1).max(4_000).optional(),
  })
  .refine((value) => value.sourceSlug || value.pageSlug, { message: 'sourceSlug or pageSlug is required.' })

export const architectureReviewOutputSchema = z.object({
  markdown: z.string(),
  readiness: z.enum(['approved', 'changes_requested', 'rejected']),
  blockingIssues: z.array(z.string()),
  nonBlockingIssues: z.array(z.string()),
  requiredFollowUps: z.array(z.string()),
  citedEvidence: z.array(evidenceItemSchema),
  judge: judgeRubricSchema,
  artifacts: z.array(researchArtifactSchema),
  reviewRequest: reviewRequestSchema.optional(),
  panelSpec: z.json(),
  phases: z.array(workflowPhaseStatusSchema).optional(),
})

export const wikiQualityAuditInputSchema = z.object({
  scope: z.union([z.literal('all'), z.array(slugSchema)]).optional(),
})

export const wikiQualityAuditOutputSchema = z.object({
  markdown: z.string(),
  proposedChanges: z.array(
    proposedPageChangeSchema.extend({
      targetRefs: z.array(z.string()),
    }),
  ),
  citedEvidence: z.array(evidenceItemSchema),
  judge: judgeRubricSchema,
  graphHighlights: z.array(graphHighlightSchema),
  reviewRequest: reviewRequestSchema,
  panelSpec: z.json(),
  phases: z.array(workflowPhaseStatusSchema).optional(),
})

export const workflowSchemas = {
  ingest_source: {
    input: ingestSourceInputSchema,
    output: ingestSourceOutputSchema,
  },
  ask_wiki: {
    input: askWikiInputSchema,
    output: askWikiOutputSchema,
  },
  lint_wiki: {
    input: lintWikiInputSchema,
    output: lintWikiOutputSchema,
  },
  reconcile_contradiction: {
    input: reconcileContradictionInputSchema,
    output: reconcileContradictionOutputSchema,
  },
  generate_research_brief: {
    input: generateResearchBriefInputSchema,
    output: generateResearchBriefOutputSchema,
  },
  decision_memo: {
    input: decisionMemoInputSchema,
    output: decisionMemoOutputSchema,
  },
  architecture_review: {
    input: architectureReviewInputSchema,
    output: architectureReviewOutputSchema,
  },
  wiki_audit: {
    input: wikiQualityAuditInputSchema,
    output: wikiQualityAuditOutputSchema,
  },
} as const

export type WorkflowId = keyof typeof workflowSchemas

export const workflowIdSchema = z.enum([
  'ingest_source',
  'ask_wiki',
  'lint_wiki',
  'reconcile_contradiction',
  'generate_research_brief',
  'decision_memo',
  'architecture_review',
  'wiki_audit',
])

export const wikiAgentInputSchema = z.discriminatedUnion('workflow', [
  ingestSourceInputSchema.extend({ workflow: z.literal('ingest_source') }),
  askWikiInputSchema.extend({ workflow: z.literal('ask_wiki') }),
  lintWikiInputSchema.extend({ workflow: z.literal('lint_wiki') }),
  reconcileContradictionInputSchema.extend({ workflow: z.literal('reconcile_contradiction') }),
  generateResearchBriefInputSchema.extend({ workflow: z.literal('generate_research_brief') }),
  decisionMemoInputSchema.extend({ workflow: z.literal('decision_memo') }),
  architectureReviewInputSchema.extend({ workflow: z.literal('architecture_review') }),
  wikiQualityAuditInputSchema.extend({ workflow: z.literal('wiki_audit') }),
])

export const wikiAgentOutputSchema = z.union([
  ingestSourceOutputSchema,
  askWikiOutputSchema,
  lintWikiOutputSchema,
  reconcileContradictionOutputSchema,
  generateResearchBriefOutputSchema,
  decisionMemoOutputSchema,
  architectureReviewOutputSchema,
  wikiQualityAuditOutputSchema,
])

export type IngestSourceInput = z.infer<typeof ingestSourceInputSchema>
export type AskWikiInput = z.infer<typeof askWikiInputSchema>
export type LintWikiInput = z.infer<typeof lintWikiInputSchema>
export type ReconcileContradictionInput = z.infer<typeof reconcileContradictionInputSchema>
export type GenerateResearchBriefInput = z.infer<typeof generateResearchBriefInputSchema>
export type ArtifactCreateRequest = z.infer<typeof artifactCreateRequestSchema>
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>
export type ReviewAnswer = z.infer<typeof reviewAnswerSchema>
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>
export type ReviewRequest = z.infer<typeof reviewRequestSchema>
export type ProposedPageChange = z.infer<typeof proposedPageChangeSchema>
export type ResearchArtifact = z.infer<typeof researchArtifactSchema>
export type GraphResponse = z.infer<typeof graphResponseSchema>
export type DecisionMemoOutput = z.infer<typeof decisionMemoOutputSchema>
export type ArchitectureReviewOutput = z.infer<typeof architectureReviewOutputSchema>
export type WikiQualityAuditOutput = z.infer<typeof wikiQualityAuditOutputSchema>
