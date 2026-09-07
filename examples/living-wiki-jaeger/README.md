# Living Wiki with Jaeger

This runnable React and Hono application demonstrates a larger v4 Harness graph while keeping all wiki data local. It uses direct typed definitions, application-owned file storage, structured model output, workflows, standard AI SDK UI streaming, artifacts, and OpenTelemetry traces.

## Run it

```bash
npm install
cp .env.example .env
# add OPENAI_API_KEY; OPENAI_MODEL defaults to gpt-5-mini
npm run dev
```

The Hono API listens on `http://127.0.0.1:8787`; Vite prints the web URL and proxies `/api`. Tests inject `ScriptedLivingWikiProvider` and require no network or credential.

```bash
npm run typecheck
npm test
npm run build
```

Start the pinned local Jaeger image separately when you want trace inspection:

```bash
npm run jaeger
```

## Harness structure

`src/backend/tools.ts` creates typed `defineTool(...)` definitions around the application-owned wiki store. `src/backend/harness.ts` defines structured agents and workflows, composes them with `defineHarness(...).addAgent(...).addWorkflow(...)`, and supplies the model, SQLite Harness storage, logger, and telemetry through `getInstance(...)`. The storage keeps suspended approval checkpoints across HTTP requests and process restarts; local state is written to `data/harness.sqlite` and ignored by Git.

The HTTP routes keep their readable domain names while the Harness definition ids follow lower-camel naming. Workflows use stable child-agent `callId` values and combine model output with deterministic application artifact creation.

| Capability | Example |
|---|---|
| Direct agent | `wikiAnswerer` answers a question with structured citations. |
| Workflow | `generateResearchBrief`, `decisionMemo`, and `architectureReview` coordinate an agent and artifact creation. |
| Typed tools | Source and wiki reads, search, writes, backlinks, logs, and panel validation. |
| Optional MCP | `drawioMcpServer` declares one selected diagram tool; `drawioMcp` supplies its HTTP or stdio transport only at `getInstance(...)`. |
| Portable stream | Run endpoints expose lifecycle events for the local inspector. |
| Standard chat stream | `POST /api/chat` projects `wikiAnswerer.stream(...)` through `@purista/harness-ai-sdk-ui/v1`, compatible with AI SDK `DefaultChatTransport` and AI Elements. |
| Observability | The app starts OpenTelemetry before the Harness and links runs to Jaeger. |
| Artifacts | Markdown, Mermaid, draw.io XML, JSON panels, and graph highlights. |

The AI SDK UI endpoint accepts the standard request body, maps the last user text to the agent's input schema, and returns `x-vercel-ai-ui-message-stream: v1`. The visible chat uses AI Elements with `useChat`, `DefaultChatTransport`, streamed message parts, and standard tool-approval responses. No Harness-specific browser library is required.

## Application boundaries

Wiki pages, source uploads, artifact files, and review decisions remain application-owned data. The example checks `runId` and `reviewRequestId` before applying proposed edits and makes repeated identical decisions idempotent. It is a local demonstration, so replace the file store and in-process review map with durable application services for production.

The generated draw.io artifact is plain XML with an external editor link. The
default Harness remains hermetic and does not register an MCP server. To let the
architecture-review agent use a remote draw.io MCP tool, provide the runtime
transport separately from the definition:

```ts
const token = process.env.LIVING_WIKI_DRAWIO_MCP_AUTH_TOKEN
await createLivingWikiHarness({
  drawioMcp: {
    transport: 'http',
    url: process.env.LIVING_WIKI_DRAWIO_MCP_URL!,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  },
})
```

The application entry point performs the same binding when
`LIVING_WIKI_DRAWIO_MCP_URL` is set. Tests start a local MCP server and execute
the selected tool through a complete model-call, MCP-call, normalized-result,
and second-model-call roundtrip. Contract discovery, schema comparison, and
cleanup therefore stay deterministic and require no external service.
