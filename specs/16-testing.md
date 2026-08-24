# Testing

**Purpose.** Specifies the test framework, the port contract test suites every adapter must pass, coverage gates, and the fakes shipped under `@purista/harness/testing`.

## Framework

- Vitest `^4`. Node test environment (`environment: 'node'`).
- Coverage provider: `v8`. Reporters: `text`, `lcov`, `json-summary`.
- Each package owns its `vitest.config.ts` with the settings above; no shared base config is exported.

## Coverage gates (CI-enforced)

| Package              | Statements | Branches | Functions | Lines |
|----------------------|------------|----------|-----------|-------|
| `@purista/harness`   | ≥85%       | ≥80%     | ≥85%      | ≥85%  |
| `@purista/harness-openai` | ≥80%  | ≥75%     | ≥80%      | ≥80%  |
| `@purista/harness-anthropic` | ≥80%  | ≥75%     | ≥80%      | ≥80%  |
| `@purista/harness-bedrock` | ≥80%  | ≥75%     | ≥80%      | ≥80%  |
| `@purista/harness-azure-foundry` | ≥80%  | ≥75%     | ≥80%      | ≥80%  |
| `@purista/harness-agent-plugins` | ≥85% | ≥80%     | ≥85%      | ≥85%  |

CI fails if any gate is unmet.

## `@purista/harness/testing` exports

The authoritative testing-subpath export list (fakes, contract suites, and
helpers) is locked in [13-public-api](./13-public-api.md). Adapter packages
must run the matching contract suite against every port implementation they
ship; first-party model provider packages run `modelProviderContract` against
their adapter wired to an offline fake client.

There is no `streamContract` — streaming is internal to the harness; see "Streaming generator" in the core test catalog below.

## Port contract test catalogs

Each contract suite calls `make()` per test for isolation. Required tests:

### HarnessStorage

1. `getSession` returns undefined for unknown id.
2. `upsertSession` then `getSession` returns the record.
3. `appendMessages` is order-preserving across calls.
4. `listMessages` honors `limit`, `before` (exclusive).
5. `appendMessages` is atomic — partial writes not observable on concurrent reads.
6. `clearMessages` removes every message for the session and is atomic.
7. `createRun` then `getRun` returns the record.
8. `finishRun` updates only the listed fields.
9. `listRuns` returns runs for a session ordered by `startedAt` descending then `id` descending; `listMessages` returns ascending by `(timestamp, id)`.
10. `appendEvents` and `listEvents` round-trip; `after` cursor is exclusive.
11. Backend failure surfaces as `StateError`.

### Sandbox

1. `open()` returns a `SandboxSession` whose `executor` matches the contract option.
2. `read`/`write`/`list`/`stat`/`exists`/`remove` round-trip a file at an absolute POSIX path.
3. `mount(files, '/skills/foo')` makes every entry visible under `/skills/foo/`.
4. Relative paths throw `SandboxError{reason:'invalid_path'}`.
5. When `executor === 'available'`: `exec('echo hi')` returns `{stdout:'hi\n', exitCode:0}`; `timeoutMs` honored; `signal` honored.
6. When `executor === 'unavailable'`: precise TypeScript session types do not expose `exec`; dynamically widened calls to `exec(...)` throw `SandboxNoExecutorError`.
7. Optional snapshot/resume/hibernate adapters pass the sandbox snapshot contract: snapshot ids are stable, resumed sessions can read prior files, unknown snapshots throw `SandboxError`, and hibernation closes the active session after snapshotting.

### ModelProvider

The shared `modelProviderContract` suite covers the capability/shape/abort
basics (1–3, 5, 7–9, 12); the base-provider unit tests and each adapter's own
test suite cover the scripted tool-use, capability-gate, and error/retry items
(4, 6, 10, 11).

1. Each claimed method exists on the provider.
2. `text`/`object`/`embed`/`rerank` honor `signal`.
3. `textStream` and `objectStream` propagate abort and provider failures.
4. `tools[]` round-trips into `toolCalls` on response when a scripted tool-use case is configured (FakeModelProvider provides scripted mode).
5. `usage` is populated where the response type supports usage.
6. Content parts require matching capabilities (`vision_input`, `audio_input`, `file_input`) before provider I/O.
7. Final structured objects validate against schema.
8. Embedding output count matches input count and vectors honor requested dimensions when provided.
9. Rerank result ids and indexes point back to submitted documents and results are sorted descending by score.
10. Provider maps a "context length exceeded" response to `ModelError{meta.reason:'context_length_exceeded'}`.
11. Provider errors preserve sanitized retry metadata: `retryAfterMs`,
    `retryKind`, `retryAttempt`, `retryMaxAttempts`, safe `providerHeaders`,
    and parsed `rateLimit` when headers are present.
12. Provider finish/stop/status reasons map to the normalized `FinishReason`
    union and preserve raw provider reason/status in `outcome`.

### Logger

1. Each level method emits a record at that level.
2. `child(bindings)` merges bindings; child-scope shadows parent.
3. `time` is RFC3339.

### MemoryAdapter

1. `info.id`, `info.packageName`, and `info.capabilities` pass [20-memory-adapters](./20-memory-adapters.md) validation.
2. `open(scope, ctx)` returns an isolated store for `session`, `run`, `agent`, `user`, and `tenant` scopes when the matching capability is advertised.
3. `get` returns `undefined` for unknown keys and the stored JSON value for known keys.
4. `set` then `get` round-trips JSON values; non-serializable values are rejected by the core facade before adapter I/O.
5. `delete` removes a key and is idempotent.
6. `list` returns sorted keys, honors `prefix`, `limit`, and `cursor` when supported by the facade contract.
7. Unsupported `search` fails through the core capability gate before adapter I/O. When `opts.search === 'available'`, search returns deterministic results sorted by descending score.
8. Unsupported `ttlMs` fails through the core capability gate before adapter I/O. When `'memory.ttl'` is advertised, expired entries are not returned by `get`, `list`, or `search`.
9. `signal` cancellation causes `OperationCancelledError{meta.scope:'memory'}`.
10. Backend failures surface as `StateError{meta.adapter:'memory'}` unless already a `HarnessError`.
11. Standard memory spans and metrics are emitted by the core wrapper, not by adapter code.
12. Content capture tests cover `NO_CONTENT`, `SPAN_ONLY`, `EVENT_ONLY`, and `SPAN_AND_EVENT`; raw keys/values/queries/results appear only in the modes allowed by [20-memory-adapters](./20-memory-adapters.md).

### DurableWorkspace

1. `info.id`, `info.packageName`, and `info.capabilities` pass [21-durable-workspaces](./21-durable-workspaces.md) validation.
2. `startWorkspace` is idempotent for the same idempotency key and throws `WorkspaceError{meta.reason:'idempotency_conflict'}` for conflicting input.
3. `pauseWorkspace` returns stable `workspaceRef`, `checkpointRef`, and optional `snapshotRef`.
4. `resumeWorkspace` succeeds only for committed, non-expired, non-aborted, non-cleaned checkpoints.
5. `abortWorkspace` is idempotent and blocks later resume.
6. `cleanupWorkspace` is idempotent, returns `cleaned` for full deletion, and returns `cleanup_pending` with retry metadata for partial deletion.
7. `inspectWorkspace` is read-only and returns policy metadata when `workspace.inspect`, `workspace.retention`, `workspace.encrypted_storage`, or `workspace.quota` is advertised.
8. Quota failures throw `WorkspaceQuotaExceededError` and expose no visible partial checkpoint except an inspectable orphan marked for cleanup.
9. `signal` cancellation causes `OperationCancelledError{meta.scope:'workspace'}`.
10. Backend failures surface as `WorkspaceError` or `WorkspaceCleanupError`.
11. Standard workspace spans and metrics are emitted by the core wrapper, not by adapter code.
12. Logs, spans, metrics, errors, and persisted events omit file content, checkpoint payload content, prompts, completions, credentials, raw references, and raw paths in every content-capture mode.

## Core test catalog (non-port)

The harness package additionally has integration tests:

- `defineHarness` builder validation: every `HarnessConfigError` path, thrown synchronously by the originating builder method.
- Built-in tools: `bash`/`read`/`write`/`edit`/`glob`/`grep`/`list` round-trip against a sandbox; alias dispatch (PascalCase → canonical) verified; `bash` auto-disabled when `executor === 'unavailable'`; `grep` falls back to read+match.
- Skills:
  1. Strict YAML parsing accepts quoted strings, block scalars, nested `metadata`, comments, and colons inside quoted/block values.
  2. Lenient parsing retries common unquoted colon scalar failures without mutating files.
  3. Optional `license`, `compatibility`, `metadata`, and `allowed-tools` frontmatter fields are preserved on `ResolvedSkill`.
  4. Invalid names cover uppercase, leading hyphen, trailing hyphen, consecutive hyphens, empty name, and overlong name.
  5. Missing or empty `description` skips the skill and reports the locked diagnostic/error.
  6. Project/user/client/Claude compatibility discovery paths are covered with hermetic temp directories.
  7. Scan bounds stop traversal and report `scan_limit_reached`.
  8. Project skills are skipped unless the project root is trusted or the explicit binding is trusted.
  9. Collision precedence is deterministic and logs one warning diagnostic per shadowed skill.
  10. Skill catalogs include `name`, `description`, `Location`, and optional `Compatibility`, and are omitted when no skills exist.
  11. Default-loop agents with declared skills fail before model I/O when the `read` built-in is disabled.
  12. Reading `/skills/<name>/SKILL.md` marks the skill activated without duplicate mounting.
  13. History compaction either preserves activated skill tool results or keeps the catalog sufficient for reread activation.
  14. Logs, spans, metrics, persisted events, and sanitized errors exclude skill bodies, supporting file content, prompts, completions, credentials, headers, and raw attachments in every content-capture mode.
- Permissions: `'allow'` proceeds; `'deny'` produces a `PERMISSION_DENIED` tool result message and run continues; `'ask'` invokes the hook; hook failure denies and increments `harness.permission.denials`; read-only built-ins cannot be denied.
- Builder ordering: out-of-order or repeated direct calls (`.tools()` before `.models()`, two direct `.agents()` calls, `.build()` without models) fail at the type level (verified via `tsd` or equivalent type tests). Static-module type tests prove cross-module literal inference and that module builders expose neither `.build()` nor `.use()`.
- Static modules: composition across separate model/tool/skill/agent/workflow modules, duplicate module and definition rejection, atomic failure, JavaScript reference validation, ordered data-only inspection provenance, capability closure, and comprehensive deduplicated/idempotent shutdown.
- Context projection: UTF-8 boundaries, idempotence, tool-call/result pairing, precedence, one context-length retry, cancellation, no duplicate tool execution/history/events, skill preservation, and redacted byte-only diagnostics.
- Test replay and diagnostic invariants: explicit sanitizer requirement, no-provider-I/O replay, strict ordering/mismatch/exhaustion/unused fixture failures, disabled-by-default invariants, and content-free invariant findings.
- Default agent loop: tool-use round trip, iteration cap triggers `AgentLoopBudgetError`, explicit agent and harness-default budgets above 64 are honored without silent clamping, non-positive or non-integer budgets are rejected at configuration time, output validation, abort propagation.
- Guardrails: deterministic `FakeModelProvider` tests prove ordered input/output transformation, fail-closed blocking before history persistence and tool side effects, explicit retrieval filtering, strict NeMo-shaped YAML rejection, and model-check rails resolved through registered Harness model handles.
- MCP tools: fake stdio and HTTP MCP servers cover `tools/list`, `tools/call`, auth failure, schema validation failure, malformed response, process death, timeout, cancellation, SDK dynamic import behavior, and shutdown cleanup.
- Current MCP: hermetic MCP `2026-07-28` fixtures cover stateless routing and
  protocol headers, list-cache TTL/invalidation, task-augmented `tools/call`,
  task polling/result/cancellation, and rejection of legacy stateful/HTTP+SSE
  configuration. No compatibility transport or fallback is tested or shipped.
- Workflow: parallel agent calls, abort propagates to all.
- Session: serial concurrency rule throws `SessionBusyError` synchronously on overlap; `clearHistory` / `replaceHistory` reject with `SessionBusyError` when a run is in flight; `replaceHistory` validation failure throws `ValidationError{where:'session_history'}`.
- `SessionMemory` round-trip: `write('foo', value)` then `read('foo')` returns the value; `list()` returns the keys; non-serializable value throws `ValidationError{where:'memory_value'}`; the model can read the same `/memory/foo.json` file via the built-in `read` tool.
- Memory adapter integration: default `sandboxMemory()` is used when `.memory(...)` is omitted; `.memory(custom)` replaces it; `.requires(['memory.persistent'])` fails at `build()` unless the configured memory adapter advertises the capability; `ctx.memory.session`, `ctx.memory.run`, `ctx.memory.agent`, `ctx.memory.user()`, and `ctx.memory.tenant()` scope isolation is verified.
- `sandboxMemory()` behavior: writes and reads session memory from `/memory/session/<key>.json`, writes and reads run memory from `/memory/runs/<runId>/<key>.json`, and rejects search through the capability gate.
- Durable workspace integration: `.workspace(custom)` registers a durable workspace; `.requires(['workspace.durable'])` fails at `build()` without it; `harness.inspect()` reports adapter id, package, capabilities, and policy without opening a workspace; workflow checkpoint tests cover start, pause, storage checkpoint commit, resume, abort, cleanup, crash-after-workspace-before-runtime-commit, crash-after-runtime-commit-before-return, and missing workspace checkpoint.
- Local durable execution: `localDurableExecution({ root })` wires `.storage(local.storage)`, `.sandbox(local.sandbox)`, and `.workspace(local.workspace)`; a workflow writes a file under `/workspace`, commits a step, rebuilds the bundle/harness from the same root/database, retries with the same durable `runId`, reads the file, and proves the committed step was not re-run.
- SQLite durable storage: fresh run, retry, process-style rebuild, active lease conflict, stale lease takeover after `leaseTtlMs`, checkpoint idempotency, checkpoint conflict, terminal-run retry rejection, JSON serialization rejection, cancellation, WAL/busy timeout setup, and `close()`.
- Local directory workspace: start/pause/resume/abort/cleanup/inspect, idempotency conflict, missing checkpoint, expired/aborted/cleaned resume rejection, orphan inspection, realpath cleanup guard, and quota metadata.
- Local directory sandbox: read/write/list/stat/remove/mount, files-only default, disabled exec behavior, enabled exec behavior, command allow-list, cwd jailing, symlink escape prevention, timeout, minimal env, and close.
- Context checkpoint store: write/read/list/delete, process-style rebuild, ordering by sequence, kind filtering, payload JSON serialization rejection, delete idempotency, capability gates, and OTel/log privacy.
- Durable run state ordering: durable lease acquisition happens before `HarnessStorage.createRun`; retrying the same durable `runId` is idempotent for non-terminal state and does not overwrite terminal state.
- History window: `historyWindow=undefined` passes all messages; `historyWindow=0` keeps only system messages; `historyWindow=N` keeps the most recent `N` non-system messages plus all system messages.
- Streaming generator (replaces the deleted Stream contract suite):
  1. `stream()` yields `run.started` first and `run.finished` last.
  2. Slow consumers do not pace the producer; bounded queues emit sanitized overflow notifications when non-terminal live events are dropped.
  3. Events emitted before consumer attaches are not replayed.
  4. Breaking out of a stream iterator detaches that consumer but does not cancel the underlying run; explicit `opts.signal` cancellation still aborts the run.
  5. Consumer `take()` throwing logs `STREAM_SUBSCRIBER_FAILED` and removes the subscription; the run continues.
  6. Per-run total ordering matches the rules in [12-streaming](./12-streaming.md).
  7. Persistence: every emitted event is written to `storage.appendEvents`; `appendEvents` failure increments `harness.events.persist_errors` without failing the run.
- Provider runtime parity:
  1. Missing `object`, `object_stream`, `embeddings`, or `rerank` capability fails before provider I/O.
  2. Missing provider method fails with `ModelCapabilityError{meta.reason:'method_missing'}`.
  3. Type tests assert capability-projected handles: absent operation capabilities remove methods; absent marker capabilities reject `tools`, tool-role messages, and unsupported content parts.
  4. `FakeModelProvider` and `BaseModelProvider` tests cover text, object, text stream, object stream, multimodal capability checks, embeddings, reranking, abort, timeout, non-cooperative provider work/iterators, provider errors, malformed structured output, bad embedding counts, and bad rerank ids.
  5. Active model retry succeeds after a short retriable failure; `retry:false`
     throws after one attempt; long provider `Retry-After` produces
     `ModelError{meta.retryKind:'deferred'}` without sleeping; streaming retry
     happens only before the first yielded chunk.
  6. First-party adapters disable hidden official-SDK retries by default where
     supported and allow explicit SDK retry options as provider-specific escape
     hatches.
  7. Persisted `model.delta`, `model.object.partial`, `model.object`, `model.embedding.completed`, and `model.rerank.completed` events omit content in every telemetry content capture mode.
  8. Opted-in model stream events carry generated `streamId` values that are stable within one stream invocation and distinct across parallel stream invocations; public invocation context does not accept caller-provided stream ids or UI labels.
- Adapter capability policy:
  1. `.requires(...)` fails during `build()` when required adapter capabilities are missing.
  2. `harness.inspect()` returns only data and includes effective capabilities, required capabilities, and adapter descriptors.
  3. `inMemorySandbox()` type tests assert files-only sessions do not expose `exec`.
- Public API surface: actual exports of `@purista/harness` (main entry) and `@purista/harness/testing` match [13-public-api](./13-public-api.md) symbol lists.
- Error catalog: every class is exported; every `code`/`category`/`retriable` matches [15-error-catalog](./15-error-catalog.md).
- OTel: every span name and metric in [14-otel-conventions](./14-otel-conventions.md) is emitted at least once across the integration tests; verified via an in-memory tracer/meter, including `harness.memory.*`, `harness.workspace.*`, `harness.storage.*`, and `harness.local_sandbox.open` spans and metrics.
- Agent Plugins addon: valid/invalid 1.0.0 manifest and `mcp.json` fixtures,
  no-schema-fetch behavior, component failure isolation, trusted-root/default
  denial/digest checks, explicit alias/type allowlists, and no automatic
  tool exposure. Filesystem fixtures prove POSIX symlink plus Windows
  junction/drive/UNC containment under a platform-aware test matrix. Stdio
  fixtures cover staged root/data, reserved environment names, one-pass
  placeholder expansion, update-persistent data, sandbox-only execution, and
  close/cancellation; HTTP fixtures cover URL/header/redirect/auth rules.
  Plugin spans/logs/inspection prove no paths, command/env/header values,
  schemas, skill content, credentials, or tool content leak in any capture
  mode.
- Telemetry flavor: `dual`, `gen_ai_only`, and `openinference_only` are covered by integration tests that assert namespace presence and absence exactly.
- Content capture modes: `NO_CONTENT`, `SPAN_ONLY`, `EVENT_ONLY`, and `SPAN_AND_EVENT` are covered by tests asserting content appears only on the allowed span attributes/events.
- Trace Context: valid inbound `traceparent` becomes the parent of the run span and all child spans; invalid inbound context logs `INVALID_TRACE_CONTEXT` and starts a new trace.
- Run summary: `Session.getRunSummary(runId)` derives status, token totals, model/tool/agent counts, and errors from `HarnessStorage` data without reading OTel spans.
- AI eval core: deterministic scorer helper and `evaluatePromptCandidates` tests listed in [19-ai-eval-core](./19-ai-eval-core.md) are required.

## Fixtures

- Skill fixtures live under `packages/harness/src/testing/fixtures/skills/**`. At minimum include `example-skill/SKILL.md`, a supporting `scripts/run.sh`, a `references/REFERENCE.md`, and malformed/lenient frontmatter fixtures. All fixtures are hermetic and contain no secrets.
- MCP fixtures live under `packages/harness/src/testing/fixtures/mcp/**` and must run without external network, credentials, or real draw.io services. Real MCP integration tests are opt-in only and skipped unless their documented environment variables are present.
- Agent Plugins fixtures live under
  `packages/harness-agent-plugins/test/fixtures/**`; they are local-only and
  include skills-only, stdio, Streamable HTTP, malformed, containment, and
  digest-update packages. They contain no secrets, executable host-side setup,
  or network dependency.
- Used by the agents and sandbox contract suites to verify mount-at-`/skills/<name>/` behavior and frontmatter parsing.

## Cross-references

- [04-state-queue-stream](./04-state-queue-stream.md), [05-sandbox](./05-sandbox.md), [06-models](./06-models.md).
- [12-streaming](./12-streaming.md), [13-public-api](./13-public-api.md), [14-otel-conventions](./14-otel-conventions.md), [15-error-catalog](./15-error-catalog.md).
- [21-durable-workspaces](./21-durable-workspaces.md).
- [29-agent-plugins](./29-agent-plugins.md).
- [17-implementation-plan](./17-implementation-plan.md).
