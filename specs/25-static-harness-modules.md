# Static harness modules

**Status:** human-approved follow-up scope. This specification defines the
static composition facility for `@purista/harness`. It is the authoritative
contract for module behavior, inspection, package-family ownership, and module
testing.

## Purpose and scope

`@purista/harness` SHALL support reusable, locally imported TypeScript modules
that contribute normal harness configuration through the existing fluent
builder. A module lets an application or an independent `@purista/harness-*`
addon reuse models, tools, skills, agents, workflows, adapters, or defaults
without creating another construction or execution runtime.

The public construction path remains:

```ts
defineHarness().use(module).models(...).agents(...).build()
```

`defineHarness()` remains the sole way to construct a harness. A module SHALL
not construct, build, load, install, discover, reload, or mutate a harness
outside the caller's builder chain.

### Non-goals

The following remain out of scope:

- Cordis-style global context augmentation or declaration merging;
- YAML/JSON module manifests, remote catalogs, signed definition bundles,
  package installation, HMR, or runtime code loading;
- user- or model-authored extensions and self-modification;
- an HTTP server, gateway, CLI, UI, daemon, worker, scheduler, or hosted
  profile service;
- a new stream transport, a second lifecycle manager, or module-managed
  resource shutdown.

These exclusions preserve the library's in-process, immutable, typed
configuration model from [00-overview](./00-overview.md).

## Capability inventory and end-to-end definition

| Capability | Actor / entrypoint | Contract and state | Failure / recovery | Owner and verification |
|---|---|---|---|---|
| `C-MOD-01` static composition | application calls `builder.use(module)` | a local `HarnessModule` transform receives the accumulated builder state and returns the next state | invalid identity, duplicate id, invalid stage, or duplicate definition fails synchronously; the original builder state remains usable | core builder; module runtime/type tests |
| `C-MOD-02` typed cross-module references | module callback receives typed accumulated builder | later modules and inline definitions see literal model/tool/skill/agent keys | erased JavaScript references still fail at existing build validation before provider I/O | core builder/type tests |
| `C-MOD-03` composition provenance | operator calls `harness.inspect()` | immutable data-only module inspection rows describe contributed ids | no I/O; no content, source paths, package URLs, prompts, files, tool I/O, or credential values | core inspection/public API tests |
| `C-MOD-04` capability-family governance | maintainer changes a first-party addon or optional integration | one catalog maps definition/port, provider, consumer module, tests, and owner | forbidden dependency edge or stale generated catalog fails CI | architecture verifier and consumer fixture |

There is no frontend, HTTP client, CLI, or worker access path. Those categories
are not applicable because the harness is a library; application integrations
remain outside the harness.

## Public module contract

### `HarnessModule`

The main entry SHALL export `HarnessModule` and `defineHarnessModule`. The
factory is a module-definition helper only; it is not an alternate harness,
agent, workflow, tool, skill, or model constructor.

```ts
interface HarnessModule<Required extends BuilderState, Result extends BuilderState, Id extends string = string> {
  readonly id: Id
  readonly version?: string
  readonly requires?: readonly AdapterCapability[]
  readonly register: (builder: HarnessModuleBuilder<Required>) => HarnessModuleBuilder<Result>
}

function defineHarnessModule<Required extends BuilderState = {}>(): <const Id extends string, Result extends BuilderState>(
  id: Id,
  definition: Omit<HarnessModule<Required, Result, Id>, 'id'>
) => HarnessModule<Required, Result, Id>
```

`Required` is the explicit minimum prior state and `Result` is inferred from
the callback result. `.use()` is valid only when its accumulated state extends
`Required`; it returns `Result`. Module authors state the keys their callback
uses in `Required`; this makes an agent/workflow module's dependencies visible
at its definition site while preserving literal keys in `Result`. The shipped
declaration must demonstrate this in a compile-time spike before release; it
MUST NOT use a public `any`/`unknown` escape hatch to bypass cross-key checks.

`id` MUST match `/^[a-z][a-z0-9_.-]{1,63}$/`. `version`, when supplied, MUST
be a non-empty printable identifier of at most 128 characters. Both values are
data-only labels; neither is a package resolver or trust assertion.

`requires` is a deduplicated list of existing `AdapterCapability` values. Its
closure is validated at `build()` with `.requires(...)` values. A module does
not invent a second capability namespace.

### `HarnessModuleBuilder` and `.use(module)`

`HarnessModuleBuilder<S>` exposes the same contribution methods as
`HarnessBuilder<S>` except `build()` and `use()`. Therefore modules can only
contribute to the one harness being configured; a module cannot build a nested
harness or recursively load more module code. In this wave it may contribute
only `models`, `tools`, `skills`, `agents`, and `workflows`; foundation,
defaults, requirements, and governance remain application-owned and do not
appear as module contributions.

`HarnessBuilder<S>.use(module)` is valid when `S extends Required`; it returns
the exact `Result` inferred for that module. A module sees contributions from
every preceding `use()` and direct builder method declared by `Required`; it
does not see later calls. A module that contributes models must precede any
module whose `Required` names those models; the type constraint rejects the
reverse order. It is synchronous and atomic: provenance is recorded only after
the callback returns successfully, while the source builder remains immutable
and reusable. A module has no access to a source-level direct-builder stage
that is forbidden by the normal builder; its callbacks use the same runtime
validation as direct contributions.

The existing agent/workflow inline helper callbacks remain the required way to
retain cross-key schema inference. A module that defines an agent SHOULD use
`.agents(({ agent }) => ({ ... }))` when its definition depends on accumulated
model/tool/skill keys.

## Additive registration and deterministic resolution

Module composition changes models, tools, skills, agents, and workflows from
replacement behavior to additive registration. A direct builder method is still
callable at most once by normal source-level staging; modules may invoke a
family repeatedly. Every family is resolved by caller order and is append-only.

For each registration:

1. The next callback/method sees every preceding literal key.
2. A key already registered in the same family is an error; last-writer-wins
   behavior is forbidden.
3. Built-in tool/skill namespace validation runs against the fully merged final
   registries at `build()`.
4. Model aliases, agent model/tool/skill references, workflow agent references,
   and governance references use existing build-time validation against the
   fully merged state. This protects JavaScript callers.
5. Defaults, foundation adapters, and governance retain their existing
   single-owner duplicate rules. A module may not replace an existing value.

Duplicate module ids fail at `use()` before registration. Duplicate registry
keys fail at the originating direct method or module callback. Required adapter
capabilities are checked at `build()` so a later module may supply an adapter.

`HarnessConfigError.meta.reason` SHALL use these stable values:

- `duplicate_module` — a module id was already applied;
- `duplicate_definition` — a model, tool, skill, agent, or workflow key was
  already registered;
- `invalid_module` — an id, version, callback result, or forbidden operation is
  invalid;
- `missing_required_capability` — the existing capability failure reason, with
  module requirements included in the final required set.

Metadata includes only the module id, definition family, and definition id. It
MUST NOT include callback source, paths, prompts, model content, tool I/O,
attachments, or credentials.

## Inspection and lifecycle

`HarnessInspection` gains a readonly `modules` array. Each
`HarnessModuleInspection` is an immutable snapshot:

```ts
interface HarnessModuleInspection {
  readonly id: string
  readonly version?: string
  readonly requires: readonly AdapterCapability[]
  readonly contributions: readonly HarnessModuleContribution[]
}

interface HarnessModuleContribution {
  readonly kind: 'model' | 'tool' | 'skill' | 'agent' | 'workflow' | 'foundation'
  readonly ids: readonly string[]
}
```

Rows and ids are in caller/registration order. `foundation` is reserved for a
future explicitly specified module wave and is not emitted in this wave.
Inspection remains synchronous, data-only, and non-mutating.

Modules SHALL NOT define close hooks or own resource cleanup. The harness owns
the final resolved adapter graph. One shutdown operation is shared by concurrent
callers. It closes sequentially in this order: MCP runner registry; opened
session sandbox handles; unique model providers in reverse model-alias order;
governance adapter (if closable); context checkpoints; workspace store; runtime;
memory; configured sandbox; state; logger. Every object is identity-deduplicated
across this list and `close()` is attempted once only. It continues after every
failure, normalizes failures to `HarnessError`, and aggregates them in the
existing return value. Failures before logger close are error-logged with only
the resource kind/id; logger-close failure is aggregated without a later log
attempt. A completed second shutdown returns the stored aggregate and invokes
no close method again.

## Capability-family and package rules

Every independently evolving optional capability SHALL have one documented
family with these roles:

1. **definition/port** — stable provider-neutral contract in core;
2. **provider adapter** — implementation and its official SDK dependency;
3. **consumer integration** — model-facing tool or static harness module;
4. **optional policy/diagnostic contributor** — only with a separate lifecycle
   and contract;
5. **conformance suite** — core testing helper plus a consuming-package fixture.

Provider/adapter packages continue to depend only on public core exports and
their official SDK. They MUST NOT import core internals or another adapter.
Core MUST NOT gain an optional implementation SDK merely to support a module.
The first extraction pilot SHALL be an existing optional integration with an
independently useful release cadence; it must retain deprecated forwarding
exports for one minor release unless a documented major migration is approved.

`architecture/capability-catalog.yaml` is the hand-authored source and
`architecture/capability-catalog.generated.json` is the checked content-free
output. `scripts/verify-capability-catalog.mjs` regenerates in memory and fails
on stale output, missing owner/port/provider/consumer/conformance fields, or a
forbidden package edge read from workspace manifests. `npm run verify:architecture`
runs it in CI. Provider/adapter packages may depend only on public
`@purista/harness` plus their SDK; core may not depend on a provider/adapter;
and provider/adapter packages may not depend on each other. The first pilot is
the existing `@purista/harness-openai` provider family, with a consumer fixture
at `packages/harness-openai/test/static-module-consumer.test.ts`. The verifier
is architecture-only: it does not load modules, execute application code, or
inspect secret-bearing config.

## Security, privacy, and operations

Module registration is trusted application code, just as an inline builder
callback is. It does not grant extra sandbox, tool, model, or permission
authority. All configured tool permissions, governance policies, timeouts,
cancellation, telemetry redaction, and session isolation remain in force.

Module identities, inspection provenance, generated catalogs, graph errors,
and shutdown diagnostics MAY contain ids, versions, capability ids, and
definition ids only. They MUST NOT capture prompts, completions, tool
arguments/results, filesystem paths or content, attachment content, headers,
tokens, credentials, or module callback source.

There are no new network calls, persistent data records, retry loops, rate
limits, deployment requirements, or production configuration values.

## Acceptance and migration

Acceptance requires type tests proving later modules can reference earlier
literal model/tool/skill/agent keys and negative `@ts-expect-error` references
fail. Runtime tests must prove deterministic composition, duplicate module and
definition rejection, atomic registration, JavaScript build validation,
capability closure, ordered data-only provenance, and a module cannot call
`build()` or `use()`.

Shutdown tests cover every closable resolved adapter, shared-provider
deduplication, failure aggregation/logging, reverse ordering, and idempotent
repeated shutdown. An external workspace fixture imports a module from a
separate package without importing harness internals.

Existing inline builder definitions remain supported and equivalent when no
module is used. Former silent overwrite behavior becomes the documented early
duplicate-definition error and is called out in release notes. The README,
package README, `ai-harness` skill, and a hermetic example SHALL show one local
module and state that modules are not a remote plugin system.
