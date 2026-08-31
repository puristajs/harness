# Common Scenarios And Use Cases

Start with the smallest useful execution shape. Add workflow orchestration only
when the application needs explicit process control.

In this guide, an agent means one typed LLM conversation loop. A workflow means
application code that coordinates one or more agent invocations with policy,
review, persistence, or other deterministic steps.

## Decision Guide

```mermaid
flowchart TD
  Start["New use case"] --> Retrieval{"Needs external or local data?"}
  Retrieval -- "Yes" --> Tools["Define tools"]
  Retrieval -- "No" --> Schema["Define output schema"]
  Tools --> Schema
  Schema --> One{"Single agent turn?"}
  One -- "Yes" --> Direct["Direct agent"]
  One -- "No" --> Workflow["Workflow"]
  Workflow --> Review{"Human approval needed?"}
  Review -- "Yes" --> HITL["Review request + decision route"]
  Review -- "No" --> Result["Validated output"]
  Direct --> Result
  HITL --> Result
```

## RAG And Source-Grounded Q&A

Use direct agent invocation when the user asks a question and one LLM
conversation loop can retrieve enough context through tools.

```mermaid
sequenceDiagram
  participant User
  participant Agent
  participant SearchTool
  participant ReadTool
  participant Model

  User->>Agent: question
  Agent->>SearchTool: search_documents(query)
  SearchTool-->>Agent: ranked hits
  Agent->>ReadTool: read_document(ids)
  ReadTool-->>Agent: evidence
  Agent->>Model: answer with evidence
  Model-->>Agent: answer + citations
```

Recommended output schema:

```ts
z.object({
	answer: z.string(),
	citations: z.array(
		z.object({
			id: z.string(),
			quoteOrSummary: z.string(),
			confidence: z.enum(['low', 'medium', 'high']),
		}),
	),
	confidenceNotes: z.array(z.string()),
})
```

Add a workflow when you need query rewriting before the agent, multiple
retriever agents, answer grading after the agent, or durable report artifacts.

### Embeddings And Reranking

Use embeddings and reranking as retrieval workflow steps, not as hidden agent
message types. A workflow can embed the query, read candidate documents from an
application-owned vector index, rerank the candidates, then pass the selected
evidence to a normal object-output agent.

```ts
const queryEmbedding = await ctx.models.retrieval.embed({
	input: ctx.input.question,
})

const candidates = await vectorIndex.search(queryEmbedding.embeddings[0].vector)

const ranked = await ctx.models.ranker.rerank({
	query: ctx.input.question,
	documents: candidates.map(doc => ({
		id: doc.id,
		text: doc.text,
		metadata: { source: doc.source },
	})),
	topN: 5,
})
```

The harness owns provider calls, timeout/cancellation, usage metadata, and run
observation. The vector database, retrieval policy, and final prompt assembly
stay in application code.

## Application-Owned Human Review

Use a workflow when proposed changes should not be applied until a human
approves them. The proposal agent drafts the change; the application owns the
review record, user interface, identity checks, and decision persistence, then
decides whether a write tool may run. The Harness does not currently provide a
durable review queue or suspend and resume a workflow across a process restart.

```mermaid
flowchart LR
  Source["Source / request"] --> Agent["Proposal agent"]
  Agent --> Review["ReviewRequest"]
  Review --> UI["Questionnaire UI"]
  UI --> Decision["ReviewDecision"]
  Decision --> Apply{"Approved?"}
  Apply -- "Yes" --> Write["Write tool"]
  Apply -- "Revise" --> Followup["Follow-up run"]
  Apply -- "Reject" --> Log["Audit log"]
```

Required behavior:

- no mutation before approval;
- visible review questions and recommended answers;
- immediate answer capture when a user selects an option;
- idempotent final decision submission;
- stale run/review ids fail with a clear error.

## Triage And Routing

Use a direct triage agent for simple classification. Use a workflow when triage
starts downstream work such as routing, notification, enrichment, review, or
artifact generation.

Good triage output fields:

- `priority`
- `category`
- `owner`
- `nextAction`
- `confidence`
- `reason`

Keep triage outputs narrow. Downstream agents should consume typed fields, not
parse triage prose.

## Parallel Agents

Use workflows for fan-out/fan-in. Each branch can be a separate agent
conversation loop with its own instructions, tools, and output schema.

```mermaid
flowchart LR
  Input --> Planner
  Planner --> Facts["Facts agent"]
  Planner --> Risk["Risk agent"]
  Planner --> Tests["Test agent"]
  Planner --> Docs["Docs agent"]
  Facts --> Synth["Synthesis"]
  Risk --> Synth
  Tests --> Synth
  Docs --> Synth
  Synth --> Output
```

This pattern fits code review, incident analysis, research synthesis, and large
document audits.

## Plan, Reason, Reflect, Judge

Use this workflow shape when correctness matters more than raw speed.

| Phase | Responsibility |
|---|---|
| Plan | Define scope, sources, and expected output. |
| Retrieve | Gather evidence through tools. |
| Reason | Produce the draft answer, decision, or report. |
| Reflect | Find unsupported claims, contradictions, and missing context. |
| Judge | Score readiness and produce review questions when needed. |
| Publish | Persist artifacts or apply approved changes. |

The Living Wiki example uses this shape for decision memos, architecture
reviews, and wiki audits.

## Artifact Generation

Use artifacts when users need durable outputs beyond chat text:

- markdown reports;
- Mermaid diagrams;
- draw.io XML;
- JSON-rendered panels;
- SVG or image previews;
- graph nodes and edges.

Artifacts should include manifest metadata: id, title, kind, content type,
source pages, creating run id, digest, and size.

## Living Wiki Pattern

The Living Wiki Jaeger example combines:

- direct wiki Q&A agent;
- source ingest workflow;
- decision memo workflow;
- architecture review workflow;
- wiki audit workflow;
- application-owned human review task;
- SSE run inspector;
- Jaeger trace links;
- Mermaid, draw.io XML, JSON panels, and Three.js graph.

Use it as the reference for a real application that showcases the harness
without requiring external services by default.
