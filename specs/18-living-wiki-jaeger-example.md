# Living Wiki Intelligence Workspace

**Purpose.** Defines the current canonical contract for
`examples/living-wiki-jaeger`: a runnable Hono + React/Vite research workspace
that demonstrates `@purista/harness`, `@purista/harness-openai`, typed tools,
skills, agents, workflows, direct agent streaming, human review, local
artifacts, optional MCP graphics, SSE observation, and OpenTelemetry tracing
with Jaeger.

This spec consolidates the former Living Wiki Jaeger example baseline and the
later intelligence-workspace/MCP refactor into one current-state contract.

## Package

- Workspace path: `examples/living-wiki-jaeger`.
- Package name: `@purista/living-wiki-jaeger-example`.
- Package visibility: private.
- Runtime: Node 20+.
- Backend: Hono.
- Frontend: React + Vite.
- Styling/components: project-local React components; AI Elements patterns for
  chat; shadcn-compatible controls where useful.
- Model provider: `@purista/harness-openai` for real runs, fake provider for
  default tests.

The example imports harness runtime APIs only from `@purista/harness` and model
adapter APIs only from `@purista/harness-openai`.

## Runtime Defaults

Default startup must not require OpenAI, draw.io MCP, or Jaeger.

Environment variables:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Enables real OpenAI model calls. |
| `OPENAI_MODEL` | Optional override, default `gpt-5-mini`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional trace exporter endpoint, default `http://localhost:4318/v1/traces`. |
| `LIVING_WIKI_DRAWIO_MCP_COMMAND` | Optional draw.io MCP stdio integration. |
| `LIVING_WIKI_DRAWIO_MCP_ARGS` | Optional draw.io MCP stdio args. |
| `LIVING_WIKI_DRAWIO_MCP_URL` | Optional draw.io MCP HTTP integration. |
| `LIVING_WIKI_DRAWIO_MCP_AUTH_TOKEN` | Optional bearer token for draw.io MCP HTTP. |

When optional variables are absent:

- model calls use a deterministic fake provider in tests and demo-safe local
  fallback behavior where applicable;
- draw.io MCP is disabled and Mermaid/Three.js remain available;
- tracing runs as no-op or exports only when configured;
- no OpenAI network call is made by default tests.

## Repository Boundaries

| Area | Owner path | Responsibility |
|---|---|---|
| Harness MCP runtime | `packages/harness/src/tools/mcp/**` | MCP stdio/http tool execution, schema validation, lifecycle, telemetry, errors |
| Example backend | `examples/living-wiki-jaeger/src/backend/**` | Hono API, local file data, workflow definitions, direct agent routes, artifact storage, example tools |
| Example frontend | `examples/living-wiki-jaeger/src/frontend/**` | React UI, AI Elements chat, markdown/Mermaid rendering, graph, drawers, review forms |
| Example skills | `examples/living-wiki-jaeger/skills/**` | skill manifests and instruction content used by agents |
| Docs | `docs/**`, `examples/living-wiki-jaeger/README.md` | usage, operations, scenarios, MCP setup, migration guide |

MCP runtime support belongs in `@purista/harness`, not as example-only code.

## Data Model

All example data is local file data under `examples/living-wiki-jaeger/data`.

Required directories:

```text
data/
  sources/
  wiki/
  runs/
  artifacts/
```

Wiki pages are markdown files with frontmatter:

```yaml
---
id: page-id
title: Page Title
summary: Short summary
tags: [example]
updatedAt: 2026-05-06T00:00:00.000Z
---
```

Source files are markdown files with frontmatter:

```yaml
---
id: source-id
title: Source Title
kind: markdown
createdAt: 2026-05-06T00:00:00.000Z
---
```

Rules:

- slugs are lowercase URL-safe identifiers;
- callers cannot choose filesystem paths;
- all reads/writes stay under the example data directory;
- path traversal is rejected before sandbox/file access;
- destructive edits require an explicit tool call or approved review decision.

## Harness Definition

The backend builds one harness using:

- `defineHarness()`;
- an in-memory or local-file state store suitable for the example;
- a local sandbox rooted at the example workspace;
- the OpenAI provider when `OPENAI_API_KEY` is present;
- fake provider scripts for tests;
- built-in tools only when allowlisted by agents;
- local TypeScript tools for wiki operations;
- optional MCP tools only when configured.

The default model alias is `main`. The default real model is `gpt-5-mini`.

Privacy defaults:

- telemetry content capture is disabled by default;
- run events are sanitized before SSE and persistence;
- validation errors identify invalid fields without echoing confidential payload
  content;
- tool/model/provider logs never include API keys, auth headers, token values,
  uploaded source content, prompts, or raw model outputs unless an explicitly
  documented content-capture mode allows safe non-secret payload capture.

## Local Tools

The example defines TypeScript tools with Zod input/output schemas.

### `list_wiki_pages`

Input:

```ts
{ tag?: string }
```

Output:

```ts
{
  pages: Array<{
    slug: string
    title: string
    summary: string
    tags: string[]
    updatedAt: string
  }>
}
```

### `read_wiki_page`

Input:

```ts
{ slug: string }
```

Output:

```ts
{
  slug: string
  title: string
  frontmatter: Record<string, unknown>
  markdown: string
}
```

### `write_wiki_page`

Input:

```ts
{
  slug: string
  title: string
  summary: string
  tags: string[]
  markdown: string
}
```

Output:

```ts
{ slug: string; updatedAt: string }
```

### `search_sources`

Input:

```ts
{ query: string; limit?: number }
```

Output:

```ts
{
  results: Array<{
    slug: string
    title: string
    excerpt: string
  }>
}
```

### `append_research_log`

Input:

```ts
{
  message: string
  refs: string[]
}
```

Output:

```ts
{ entryId: string; createdAt: string }
```

### `store_artifact`

Input:

```ts
{
  kind: ArtifactManifest['kind']
  title: string
  contentType: string
  content: string
  sourcePageIds?: string[]
  renderMode?: ArtifactManifest['renderMode']
}
```

Output:

```ts
ArtifactManifest
```

The tool rejects unsupported artifact kinds, path traversal, oversized payloads,
and unsafe SVG content.

## Skills

Skills are mounted through the harness skill system. They must not be inlined
into workflow handlers.

Required skills:

- `wiki-curator`: compact linked wiki maintenance and citation discipline.
- `research-brief-writer`: report structure, Mermaid guidance, open-question
  handling, and confidence language.
- `diagram-designer`: converts research structure into Mermaid or draw.io-ready
  artifact instructions.
- `decision-memo-planner`: evaluation criteria, evidence needs, and options.
- `reflective-critic`: checks drafts for missing evidence, contradictions,
  unsupported claims, and bias.
- `judge-rubric`: produces structured `JudgeRubric` output.

## Shared Output Contracts

```ts
interface EvidenceItem {
  ref: string
  title: string
  quote?: string
  relevance: string
}

interface JudgeRubric {
  score: number
  confidence: 'low' | 'medium' | 'high'
  strengths: string[]
  risks: string[]
  missingEvidence: string[]
}

interface ReviewRequest {
  id: string
  runId: string
  title: string
  reason: string
  proposedChanges: ProposedPageChange[]
  contradictions: Contradiction[]
  alternatives: Array<{ id: string; label: string; description: string }>
}
```

```ts
interface ProposedPageChange {
  id: string
  kind: 'create_page' | 'update_page' | 'merge_pages' | 'add_citation' | 'mark_stale'
  targetPageId?: string
  title: string
  beforeMarkdown?: string
  afterMarkdown?: string
  rationale: string
  citations: CitationChange[]
  risk: 'low' | 'medium' | 'high'
}

interface CitationChange {
  id: string
  pageId: string
  sourceRef: string
  claim: string
  operation: 'add' | 'update' | 'remove'
}

interface Contradiction {
  id: string
  claimA: string
  claimB: string
  refs: string[]
  severity: 'low' | 'medium' | 'high'
}

interface ReviewOutcome {
  reviewRequestId: string
  runId: string
  status: 'applied' | 'rejected' | 'revision_started'
  appliedChangeIds: string[]
  followUpRunId?: string
  logEntryId: string
}
```

## Agents

Required agents:

- `wiki_answerer`: reads wiki pages and sources, answers direct chat questions,
  cites local refs, and may return typed panels/artifacts.
- `page_curator`: improves one wiki page at a time and must write only through
  `write_wiki_page`.
- `source_extractor`: reads selected sources and proposes page changes,
  citations, contradictions, and open questions.
- `research_synthesizer`: produces briefs and structured panels from selected
  pages/sources.
- `diagram_designer`: produces Mermaid or draw.io-ready artifact instructions.
- `critic`: reflects on drafts and identifies unsupported claims, contradictions,
  and missing evidence.
- `judge`: emits `JudgeRubric` assessments.

Agents must use tool allowlists. Missing tools fail with the normal harness tool
errors. Agents must not read or write outside the example data boundary.

## Workflow Model

Workflows use plan/reason/reflect/judge phases when the task requires durable
analysis:

1. `plan`: choose evidence needs, tools, risk level, and acceptance criteria.
2. `reason`: gather evidence and produce a first structured result.
3. `reflect`: critique the result for gaps, contradiction, and unsafe edits.
4. `judge`: emit a rubric and decide whether human review is required.
5. `apply`: mutate local wiki/artifacts only after tool validation and, where
   required, human approval.

Every workflow output must include enough typed data for the UI to render
markdown, panel specs, citations, affected pages, graph highlights, and review
requests without scraping prose.

## Required Workflows

### `answer_question`

Input:

```ts
{ question: string }
```

Output:

```ts
{
  answer: string
  citations: string[]
  relatedPages: string[]
}
```

### `improve_page`

Input:

```ts
{ slug: string; instruction: string }
```

Output:

```ts
{
  slug: string
  summary: string
  changed: boolean
}
```

### `audit_wiki`

Input:

```ts
{ focus?: string }
```

Output:

```ts
{
  orphanPages: string[]
  missingBacklinks: Array<{ from: string; to: string }>
  weakClaims: Array<{ page: string; claim: string; reason: string }>
  staleNotes: Array<{ page: string; reason: string }>
  duplicateConcepts: Array<{ pages: string[]; reason: string }>
  panelSpec: unknown
}
```

### `reconcile_contradiction`

Input:

```ts
{
  leftRef: string
  rightRef: string
  conflict: string
}
```

Output:

```ts
{
  summary: string
  changedPages: string[]
  unresolvedQuestions: string[]
}
```

### `generate_research_brief`

Input:

```ts
{
  pageSlugs: string[]
  goal: string
}
```

Output:

```ts
{
  markdown: string
  panelSpec: unknown
  citedPages: string[]
}
```

### `source_ingest`

Human-in-the-loop source ingest:

1. User uploads or selects a source.
2. `source_extractor` proposes new pages, updates, claims, citations,
   contradictions, and open questions.
3. Workflow emits or returns a `ReviewRequest`.
4. UI shows the review form only while review is required.
5. User accepts, rejects, chooses alternatives, or provides custom guidance.
6. Approved decisions apply edits through tools and append a log entry.

The workflow must not mutate wiki pages before approval.

### `decision_memo`

Input:

```ts
{
  question: string
  options: string[]
  criteria?: string[]
  pageRefs?: string[]
  sourceRefs?: string[]
}
```

Output:

```ts
{
  markdown: string
  recommendation: string
  options: Array<{ id: string; label: string; pros: string[]; cons: string[] }>
  citedEvidence: EvidenceItem[]
  judge: JudgeRubric
  graphHighlights: GraphHighlight[]
  panelSpec: unknown
}
```

### `architecture_review`

Input:

```ts
{
  focus: string
  pageRefs?: string[]
  sourceRefs?: string[]
  includeDiagram?: boolean
}
```

Output:

```ts
{
  markdown: string
  risks: Array<{ title: string; severity: 'low' | 'medium' | 'high'; mitigation: string }>
  citedEvidence: EvidenceItem[]
  diagramArtifactId?: string
  mermaid?: string
  judge: JudgeRubric
  graphHighlights: GraphHighlight[]
  panelSpec: unknown
}
```

When draw.io MCP is configured, this workflow may create a draw.io/SVG/PNG
artifact. Without MCP, it uses Mermaid and stores the Mermaid source.

### `wiki_quality_audit`

Input:

```ts
{
  focus?: string
  allowHighRiskSuggestions?: boolean
}
```

Output:

```ts
{
  markdown: string
  proposedChanges: ProposedPageChange[]
  citedEvidence: EvidenceItem[]
  judge: JudgeRubric
  graphHighlights: GraphHighlight[]
  reviewRequest: ReviewRequest
  panelSpec: unknown
}
```

This workflow must never mutate wiki pages before a human decision is submitted.

## Direct Agent Chat

The main chat invokes `session.agents.wiki_answerer.stream(...)` directly.

Required behavior:

- answer questions from current wiki pages and sources;
- stream run events and show model/tool progress;
- show exactly one pending state: `Thinking`;
- render tool calls as one collapsible tool section, not duplicate messages;
- collapse tool details once answer text starts streaming or when the run
  finishes;
- render markdown, tables, code blocks, links, wiki links, and Mermaid diagrams;
- not trigger workflow-only review cards unless a typed `ReviewRequest` is
  returned.

## Review Decisions

`POST /api/reviews/:runId/decision` is the canonical resume entrypoint. It
starts follow-up work itself; implementations must not add a second public
`apply_reviewed_ingest` endpoint. The endpoint is idempotent for
`(runId, reviewRequestId)`.

Allowed decisions:

- `accept_all`: apply every proposed change.
- `reject_all`: apply nothing and append a rejection log entry.
- `accept_selected`: apply only `acceptedChangeIds`.
- `choose_alternative`: apply selected alternatives identified by
  `selectedAlternativeIds`.
- `custom_guidance`: starts follow-up work at `plan` for source ingest/wiki
  audit, or at `reason` for decision memo/architecture review.

## Knowledge Graph

The map view is a practical analysis surface.

Required behavior:

- use Three.js for the primary graph view;
- nodes are wiki pages, sources, concepts, and artifacts;
- edges are wiki links, citations, derived relationships, and artifact refs;
- clicking a node opens the page/source/artifact or filters concepts;
- latest run metadata can highlight cited pages, changed pages, contradiction
  clusters, orphan pages, and recommended merges;
- graph side panel uses `json-renderer` for stats and recommended actions.

```ts
interface GraphNode {
  id: string
  label: string
  kind: 'page' | 'source' | 'concept' | 'artifact'
  ref: string
}

interface GraphEdge {
  id: string
  source: string
  target: string
  kind: 'wiki_link' | 'citation' | 'derived_relationship' | 'artifact_reference'
  weight: number
}

interface GraphHighlight {
  nodeIds: string[]
  edgeIds: string[]
  kind: 'cited' | 'changed' | 'contradiction' | 'orphan' | 'merge_candidate'
  label: string
}

interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  highlights: GraphHighlight[]
  latestRunId?: string
  panelSpec: unknown
}
```

Stable ids:

- page nodes: `page:<pageId>`;
- uploaded source nodes: `source:<sourceId>`;
- concept nodes: `concept:<slug>`;
- artifact nodes: `artifact:<artifactId>`;
- edges: `<kind>:<sourceNodeId>:<targetNodeId>`.

## Markdown, Mermaid, And Artifacts

Markdown rendering must support:

- GitHub-flavored markdown;
- tables;
- fenced code blocks;
- wiki links;
- Mermaid code fences through lazy-loaded `beautiful-mermaid`;
- safe Mermaid fallback when rendering fails.

`json-renderer` panels are allowed only when returned by direct agents or
workflows as typed panel specs.

Artifacts are stored by manifest plus content file:

```ts
interface ArtifactManifest {
  artifactId: string
  kind: 'markdown' | 'mermaid' | 'svg' | 'drawio_xml' | 'json_panel'
  title: string
  contentType: string
  storagePath: string
  createdByRunId: string
  sourcePageIds: string[]
  digest: string
  createdAt: string
  renderMode: 'inline' | 'document' | 'download'
}
```

Rules:

- Mermaid source remains canonical; rendered SVG may be cached separately.
- SVG is sanitized before rendering and capped at 1 MB by default.
- draw.io XML is previewed when possible and otherwise offered as an artifact.
- PNG data URLs from MCP are accepted only under the artifact size limit.
- artifact ids are backend-generated;
- artifact paths are always below the example data directory.

## MCP Runtime Support

The public MCP tool shapes from [07-tools](./07-tools.md) are executable:

- `kind: 'mcp_stdio'`;
- `kind: 'mcp_http'`.

Locked decisions:

- MCP runners are executable in this wave.
- `@modelcontextprotocol/client` v2 is loaded through dynamic import by MCP runner
  modules. TS-only harnesses must not import or require the SDK at runtime.
- Public `McpAuth` is:

```ts
type McpAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'oauth2'; accessToken: string }
  | { kind: 'api_key'; header: string; value: string }
  | { kind: 'basic'; username: string; password: string }
```

- Async bearer token functions are not public API in this wave.
- `inputAdapter` and `outputAdapter` are supported on stdio and HTTP tools.
- `McpProtocolError.meta.phase` is `'connect' | 'list' | 'call'`.
- Schema discovery failures before the model call use phase `'list'`.
- Transport connection failures use phase `'connect'`.
- Tool envelope failures and process death during a call use phase `'call'`.

Required resolved MCP tool shape:

```ts
interface ResolvedMcpTool {
  localToolId: string
  kind: 'mcp_stdio' | 'mcp_http'
  description: string
  upstreamToolName: string
  inputSchema: unknown
  outputSchema?: unknown
  timeoutMs: number
  serverKey: string
}
```

No network, process, or MCP SDK work happens during `.tools(...)` or `.build()`.
For an agent that allowlists MCP tools, schemas are initialized immediately
before the first model call of the run. Initialization creates/reuses the runner,
runs optional stdio install commands inside the sandbox, calls `tools/list`,
verifies the upstream tool exists, caches the schema for that runner, and builds
`ModelToolSpec` entries.

MCP output normalization:

- prefer `structuredContent` when present and JSON-compatible;
- otherwise join text content blocks with `\n`;
- image/resource blocks become `{ contentType, data?, uri? }`;
- mixed content becomes `{ content: [...] }`;
- `isError: true` throws `ToolError` with `tool_kind`;
- output JSON Schema validation runs after normalization and before
  `outputAdapter`.

Stdio behavior:

- stdio exchanges execute through the current `SandboxSession.exec`;
- optional install/bootstrap commands run through the same sandbox;
- if `SandboxSession.executor === 'unavailable'`, stdio MCP fails with
  `SandboxNoExecutorError`;
- concurrent calls to the same stdio runner are serialized;
- process death respawns on the next call;
- shutdown cancels in-flight calls and clears runner state;
- stderr and payloads are redacted unless content capture is explicitly enabled.

HTTP behavior:

- use SDK streamable HTTP transport where available;
- support auth none, bearer, OAuth2 token, API key header, and basic auth;
- apply user headers first and auth headers second so auth wins;
- `401` and `403` map to `McpAuthError`;
- other non-2xx transport failures map to `McpProtocolError` unless the SDK
  exposes a more precise error.

Schema validation:

- use a local JSON Schema validator for the draft 2020-12 subset in
  [07-tools](./07-tools.md);
- unsupported keywords warn once per `(toolId, keyword)`;
- `additionalProperties:false` rejects unknown keys;
- omitted `additionalProperties` allows unknown keys;
- type arrays are supported for nullable fields;
- malformed MCP schemas map to `McpProtocolError{phase:'list'}`;
- validation failure throws `ValidationError{where:'mcp_input'|'mcp_output'}`;
- `ValidationError.meta.issues` contains
  `{ path: string; message: string; keyword?: string }[]`.

Lifecycle:

- the harness exposes an idempotent shutdown path for MCP runners;
- no new MCP calls start after shutdown begins;
- in-flight MCP calls receive cancellation;
- MCP runners close before state and sandbox adapters;
- close failures are aggregated when the public shutdown surface supports a
  result, otherwise logged and rethrown as the first error.

Telemetry:

- MCP calls use normal tool spans;
- required attributes include `gen_ai.tool.type`, `gen_ai.tool.name`,
  `harness.mcp.server`, `harness.mcp.tool`, `harness.mcp.transport`,
  `harness.run.id`, `harness.session.id`, `harness.agent.id`, and optional
  `harness.workflow.id`;
- request/response bodies are not recorded by default;
- auth headers, tokens, API keys, and configured env values are always redacted.

## API

Hono exposes these routes:

| Method | Route | Behavior |
|---|---|---|
| `GET` | `/api/health` | Returns service status and current model name. |
| `GET` | `/api/pages` | Lists wiki pages with slug, title, and summary metadata. |
| `GET` | `/api/pages/:slug` | Returns one wiki page. |
| `PUT` | `/api/pages/:slug` | Replaces one wiki page after validation. |
| `GET` | `/api/sources` | Lists source markdown files. |
| `GET` | `/api/sources/:slug` | Returns one source markdown file. |
| `GET` | `/api/graph` | Returns graph nodes, edges, panel spec, and latest highlights. |
| `POST` | `/api/agents/:agentId` | Starts a direct agent run. |
| `POST` | `/api/workflows/:workflowId` | Starts one typed workflow and returns `runId` plus initial status. |
| `GET` | `/api/runs/:runId` | Returns current run status, terminal result, and trace metadata when known. |
| `GET` | `/api/runs/:runId/events` | Streams sanitized live run events as SSE. |
| `POST` | `/api/runs/:runId/cancel` | Cancels an in-flight run. |
| `POST` | `/api/reviews/:runId/decision` | Submits a human review decision and starts/resumes follow-up work. |
| `GET` | `/api/artifacts/:artifactId` | Returns generated Mermaid/draw.io/SVG artifacts. |
| `POST` | `/api/artifacts` | Stores an approved generated artifact. |

API errors are JSON:

```ts
interface ApiErrorResponse {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
```

Required error responses:

| Case | Status | Code |
|---|---:|---|
| unknown agent/workflow/artifact | 404 | `NOT_FOUND` |
| invalid request body | 400 | `VALIDATION_ERROR` |
| stale or already superseded review request | 409 | `STALE_REVIEW_REQUEST` |
| invalid review decision for request | 400 | `INVALID_REVIEW_DECISION` |
| unsupported artifact kind | 400 | `UNSUPPORTED_ARTIFACT_TYPE` |
| artifact render failure | 422 | `ARTIFACT_RENDER_FAILED` |
| MCP optional tool unavailable | 503 | `MCP_UNAVAILABLE` |
| session already running | 409 | `SESSION_BUSY` |

## SSE

`GET /api/runs/:runId/events` is the primary live observation surface.

Required behavior:

- standard `text/event-stream` responses;
- sanitized harness run events;
- delivered order for the subscribed run;
- terminal status when available;
- browser reconnect best-effort;
- no promise of complete replay;
- slow browser consumers do not block workflow/model/tool execution;
- persisted harness events remain authoritative.

The UI handles idle, invoking workflow, SSE connected, reconnecting, completed,
failed, cancelled, and overflow notice states.

## UI

The first screen is the working application, not a landing page.

Required layout:

- left sidebar: wiki tree, source list, workflow launcher;
- center/document and chat split defaults to 50:50 after the sidebar;
- split is user-resizable;
- page itself does not scroll;
- sidebar, document, chat, graph, and drawers scroll independently;
- inspector is an on-demand drawer with active run, SSE events, trace id/link,
  structured output, and affected pages;
- graph/map view uses Three.js as the primary visual surface.

Required interaction:

- AI Elements-style messages, tool displays, and prompt input;
- multiline prompt with autofocus;
- auto-scroll to latest message while user is at the bottom;
- tool details collapse once answer text starts or run finishes;
- one visible pending label: `Thinking`;
- review forms appear only for active review requests;
- `json-renderer` panels appear only when returned by a run.

The UI is dense, readable, and suited for repeated research work. It avoids
marketing-page composition, decorative gradients/orbs, and overlapping text.

## OpenTelemetry And Jaeger

The example uses standard OpenTelemetry packages and does not implement a custom
tracing backend.

Required packages include:

- `@opentelemetry/sdk-node`;
- an OTLP HTTP trace exporter;
- `@opentelemetry/resources`;
- `@opentelemetry/semantic-conventions`.

The service name is:

```text
purista-living-wiki-example
```

The default exporter endpoint is:

```text
http://localhost:4318/v1/traces
```

The `jaeger` npm script wraps this exact command:

```bash
docker run --rm --name jaeger -p 16686:16686 -p 4317:4317 -p 4318:4318 -p 5778:5778 -p 9411:9411 cr.jaegertracing.io/jaegertracing/jaeger:2.17.0
```

Traces show:

```text
Hono request -> session/invoke -> direct agent or workflow -> agent -> model provider -> tools -> state/sandbox/MCP/artifact where used
```

The UI exposes a trace id or Jaeger link for the active run when trace metadata
is available. Missing Jaeger does not prevent local app usage.

## Documentation

The example README covers:

- setup;
- root `.env` usage;
- `OPENAI_API_KEY`;
- default `gpt-5-mini` model;
- Jaeger startup;
- development commands;
- direct agent chat and all workflows;
- UI usage;
- privacy-safe telemetry defaults;
- fake-provider test behavior;
- manual OpenAI verification;
- draw.io MCP optional setup;
- artifact storage;
- graph/visualization use case.

Docs must also cover:

- direct agent vs workflow execution;
- MCP tool configuration and security;
- human-in-the-loop workflow pattern;
- plan/reason/reflect/judge workflow pattern;
- operational notes for MCP child processes, timeouts, auth, shutdown, and
  observability.

## Tests

Required harness tests:

- MCP stdio happy path with a fake MCP server;
- MCP stdio process death and respawn;
- MCP HTTP happy path with fake server;
- MCP auth failure mapping;
- MCP input/output validation failure;
- timeout/cancellation propagation;
- MCP tools appear in model tool specs;
- shutdown closes stdio processes;
- MCP SDK is not imported for harnesses that only use TS tools.

Required example tests:

- slug and path traversal protection;
- tool schemas and file IO behavior;
- direct agent API run;
- workflow run;
- all baseline workflows using a fake model provider;
- source ingest review request rendering and decision submission;
- decision memo workflow happy path;
- architecture review workflow happy path;
- wiki quality audit blocks mutation until review approval;
- graph route and Three.js component smoke test;
- API workflow start, run lookup, SSE subscription, and cancellation;
- markdown Mermaid rendering fallback;
- draw.io MCP disabled fallback;
- fake draw.io MCP artifact creation when configured;
- artifact path traversal rejection;
- UI happy path with fake backend/provider;
- default tests prove no OpenAI network call is made.

Required fixtures:

| Fixture | Owner path |
|---|---|
| fake model outputs for direct chat and workflows | `examples/living-wiki-jaeger/src/backend/__fixtures__/**` |
| review request and decision payloads | `examples/living-wiki-jaeger/src/backend/__fixtures__/reviews/**` |
| decision memo output | `examples/living-wiki-jaeger/src/backend/__fixtures__/workflows/decision-memo.json` |
| architecture review output | `examples/living-wiki-jaeger/src/backend/__fixtures__/workflows/architecture-review.json` |
| wiki audit output | `examples/living-wiki-jaeger/src/backend/__fixtures__/workflows/wiki-audit.json` |
| graph payload | `examples/living-wiki-jaeger/src/frontend/__fixtures__/graph.json` |
| artifact manifests | `examples/living-wiki-jaeger/src/frontend/__fixtures__/artifacts/**` |
| Mermaid render failure | frontend renderer test fixture |
| fake draw.io MCP response | `packages/harness/src/testing/fixtures/mcp/**` and example backend fixture |

Layered tests:

- harness MCP contract tests run without external MCP servers;
- backend route tests use fake providers and fixture payloads;
- workflow unit tests use fake model outputs;
- frontend component tests use fixture JSON and do not call backend routes;
- UI smoke tests verify layout, independent scrolling, graph canvas, chat
  pending state, and artifact rendering.

Manual verification:

1. `npm run jaeger --workspace @purista/living-wiki-jaeger-example`
2. Start the example with root `.env` containing `OPENAI_API_KEY`.
3. Run direct chat.
4. Upload source and approve ingest review.
5. Run each workflow.
6. Generate a diagram artifact through configured draw.io MCP.
7. Confirm Jaeger shows request, session, direct agent, workflow, model, TS
   tool, MCP tool, state/sandbox, and artifact spans without content capture.

Repository gate:

```bash
npm run lint
npm run typecheck
npm run test:types
npm test
npm run test:contracts
npm run test:integration
npm run test:failure
npm run build
```

Generated build output is removed after verification when it is not tracked.

## Non-goals

This example and refactor still do not add:

- database persistence;
- authentication;
- multi-user sync;
- cloud deployment manifests;
- telemetry content capture by default;
- provider-specific model APIs in app code;
- a new model provider adapter.

## Cross-references

- [02-harness-config](./02-harness-config.md) — harness builder and defaults.
- [07-tools](./07-tools.md) — typed and MCP tool behavior.
- [08-skills](./08-skills.md) — skill loading and mounting.
- [09-agents](./09-agents.md) — default agent loop and tool use.
- [10-workflows](./10-workflows.md) — typed workflow handlers.
- [11-sessions](./11-sessions.md) — direct agents, workflows, and session invoke semantics.
- [12-streaming](./12-streaming.md) — bounded live observation and event privacy.
- [14-otel-conventions](./14-otel-conventions.md) — span and metric conventions.
- [15-error-catalog](./15-error-catalog.md) — MCP and harness error mapping.
