# Testing

## Contents
- Default Checks
- Fake Model Providers
- Type Tests
- Contract Tests
- Streaming Tests
- Adapter Failure Tests

## Default Checks
For the harness repo, run the narrowest relevant checks first, then the package-level gates:

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

If a package script differs, inspect `package.json` and use the local script names.

## Fake Model Providers
Unit and integration tests should not require live provider credentials. Inject a fake `ModelProvider`:

```ts
import type { JsonValue, ModelProvider, ObjectRequest, ObjectResponse } from '@purista/harness'

class FakeObjectProvider implements ModelProvider {
	readonly id = 'fake'
	readonly genAiSystem = 'fake'

	async object<T extends JsonValue = JsonValue>(_req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
		return {
			object: { answer: 'fake answer' } as T,
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			finishReason: 'stop',
		}
	}
}
```

Use fake providers for:
- agent input/output validation
- workflow orchestration
- tool call loops
- permissions
- streaming event shape
- telemetry/logging behavior

Keep one explicit live-provider smoke test path if needed, gated by env vars such as `OPENAI_API_KEY`.

## Type Tests
Add type tests for builder inference:
- unknown model aliases are rejected in agents
- unknown tools/skills are rejected in agents
- governance `rule(...)` narrows `ctx.input` for selected TypeScript tools
- governance `exposureRule(...)` rejects unknown tool ids and narrows `ctx.toolId`
- workflow `ctx.agents.<id>` input/output types come from the agent schemas
- model handles expose only declared capability methods
- multimodal content parts require matching input capabilities
- `embed` and `rerank` exist only on matching aliases

Use `@ts-expect-error` for negative cases.

## Guardrails Tests

Treat Guardrails configuration as one inline TypeScript object passed to
`defineGuardrails({ config, actions })`. Test the action map and configuration
together: a flow id must resolve to an opaque `defineGuardrailAction(...)`
token with the matching phase, action outcomes must use the phase's transform
target, and invalid configuration must produce the safe
`GuardrailsConfigError` without exposing policy content or parser diagnostics.
Tool-input and tool-output action tests must reject missing or empty `tools`
selectors before a protected value can be evaluated.

Use the existing fake provider and detector helpers to prove both protected and
unprotected paths. Cover an action allow, block, transform, timeout, and
callback failure. For structured sensitive-data values, test the reviewed codec
against the exact schema/value it protects; do not test a recursive scan of
arbitrary JSON.

Test build preflight separately from invocation. Construct the complete Harness
with `defineHarness(...).build()` and assert missing active model/tool
requirements fail before creating a session or requesting a model. The runnable
`examples/guardrails` composition exposes `preflightGuardrailsExample()` for a
real zero-effect check: before shutdown, model requests, detector inspections,
tool invocations, and approval requests must all be zero. A no-effect preflight
does not replace the separate invocation tests for ordering and handler output.

## Contract Tests
Use `@purista/harness/testing` for reusable adapter contracts when available:
- `FakeModelProvider`
- `FakeMemoryEngine`
- `makeHarness`
- `FakeHarnessStorage`
- `harnessStorageContract`
- `durableWorkspaceContract`
- `memoryEngineContract`
- `sandboxContract`
- `sandboxTextSearchContract`
- `sandboxSnapshotContract`
- `fakeSnapshotSandbox`
- `adapterCapabilitiesContract`
- `fakeCapabilityAdapter`
- `createInMemoryFeedbackRecorder`

Adapters should prove cancellation, timeout, validation failure, and shutdown behavior.

`FakeModelProvider` supports queued text/object/embedding/rerank responses and queued text/object stream chunks:

```ts
const model = new FakeModelProvider()
model.enqueueObject({
	object: { answer: 'ok' },
	usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
	finishReason: 'stop',
})
model.enqueueEmbedding({
	embeddings: [{ index: 0, vector: [0.1, 0.2] }],
	usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
})
```

## Streaming Tests
Collect stream events and assert lifecycle behavior:

```ts
const events = []
for await (const event of session.workflows.audit.stream({ scope: 'all' })) {
	events.push(event)
}

expect(events.some(event => event.type === 'run.started')).toBe(true)
expect(events.some(event => event.type === 'run.finished')).toBe(true)
```

For model streaming, queue fake provider chunks and test the definition's
declared update mode. Test public consumers against `ExecutionEvent` and the
terminal `RunOutcome`. Test detailed operational consumers against the separate
`observe(...)` / `RunEvent` surface. Protocol adapters should be tested with
their own wire fixtures. Test cancellation with an `AbortSignal` or the owning
integration's cancellation bridge.

Governance tests should cover both exposure and execution layers:
- exposure-only governance hides tools before the fake provider request and does not require `policies`
- `mode: 'shadow'` emits `policy.exposure` without removing tools
- execution policies emit `policy.evaluated` with `decisionId` and optional evidence fields
- approvals receive `approvalId`, `callId`, and matching decisions
- policy and approval events do not persist raw tool input or output

## Adapter Failure Tests
Provider adapters should cover:
- provider 4xx and 5xx mapping
- rate-limit/network retry metadata
- invalid retry policy values fail before provider execution
- context-length exceeded as non-retriable
- malformed provider responses
- missing provider operation for a declared capability
- cancellation through `AbortSignal`
- model/tool/schema validation failures

State, memory, and sandbox adapters should cover:
- stable ordering
- idempotent close/shutdown
- append atomicity where required
- missing sessions/files/runs
- executor unavailable behavior
- bounded literal and `safe_regex_v1` search, adversarial patterns, cancellation, all incomplete-result reasons, data locality, and content-free telemetry when `sandbox.text_search` is advertised
- snapshot/resume behavior when implemented
- scope isolation, unsupported capability gates, and content-capture behavior for memory adapters
# Replay and diagnostics

`createReplayInteractionRecorder({ sanitize })` requires an explicit sanitizer,
wraps a test provider, and produces a caller-owned fixture. Use
`replayModelProvider(fixture)` plus `assertReplayConsumed(provider)` for strict,
offline tests. The recorder never serializes the pre-sanitized value, but the
caller must review sanitizer output. `assertDiagnosticInvariants(snapshot,
invariants)` is a synchronous, explicit, content-free test helper; it is never
enabled automatically in production.
