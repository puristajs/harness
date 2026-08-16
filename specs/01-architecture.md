# Architecture

**Purpose.** Describes the layering, dependency direction, and package layout. Implementation agents must respect the dependency rules; violations are bugs.

## Layering

```
   ┌────────────────────────────────────────────┐
   │  User code (defineHarness().…build())      │
   └────────────────────────────────────────────┘
                       │
   ┌────────────────────────────────────────────┐
   │  Public API   (factories, types, errors)   │
   └────────────────────────────────────────────┘
                       │
   ┌────────────────────────────────────────────┐
   │  Orchestrators (Sessions, Runs, Loops)     │
   └────────────────────────────────────────────┘
        │           │            │           │
   ┌────────┐  ┌─────────┐  ┌──────────┐  ┌──────┐
   │ Agents │  │ Workflows│  │ Models   │  │ Tools│
   └────────┘  └─────────┘  └──────────┘  └──────┘
                       │
   ┌────────────────────────────────────────────┐
   │  Foundation ports (state, sandbox, memory, │
   │  model provider) + logger + telemetry      │
   └────────────────────────────────────────────┘
                       │
   ┌────────────────────────────────────────────┐
   │  In-memory implementations (in-package)    │
   └────────────────────────────────────────────┘
```

Streaming is an internal concern of the harness; there is no separate `Stream` port and no separate stream package.

## Dependency direction

- Higher layers may import lower layers; the reverse is forbidden.
- All layers may import error types and the logger interface.
- Non-core packages follow the convention `@purista/harness-{addon}`. The harness is published independently from the wider PuristaJS framework so it can be consumed standalone or composed inside [PuristaJS](https://purista.dev).
- Provider and adapter packages MUST NOT depend on harness internals; they depend only on `@purista/harness` for port interfaces/types and their official provider SDKs.
- Provider and adapter packages MUST NOT depend on each other (no provider-to-provider or adapter-to-adapter imports).
- The harness package is the only package that may depend on `@modelcontextprotocol/client` v2 (optional peer, scoped to the MCP tool runners).
- `@purista/harness-agent-plugins` is an opt-in first-party addon. It depends
  only on public core APIs and local parsing/validation dependencies; it does
  not import harness internals, providers, or another addon. Core does not
  depend on it. Core's MCP SDK peer remains the single protocol dependency;
  the addon projects portable entries onto that runtime.
- Static harness modules are imported application/addon code that calls only the
  public builder API. They neither load code dynamically nor add a runtime
  container. Optional capability families follow the port → provider adapter →
  consumer module → conformance-fixture rule in
  [25-static-harness-modules](./25-static-harness-modules.md).

## Package layout

```
packages/
  harness/                 # @purista/harness
    src/
      index.ts             # public surface (see 13-public-api.md)
      testing/index.ts     # exposed as @purista/harness/testing subpath export
    package.json           # exports map: "." and "./testing"
  harness-openai/          # @purista/harness-openai
  harness-anthropic/       # @purista/harness-anthropic
  harness-bedrock/         # @purista/harness-bedrock
  harness-azure-foundry/   # @purista/harness-azure-foundry
  harness-agent-plugins/   # @purista/harness-agent-plugins; local Agent Plugins client
  harness-memory-*/        # future external memory adapters; not part of core
    src/
      index.ts
    package.json
examples/
  quickstart/              # private, not published; minimal entry point
  ...                      # other spec-approved private examples
```

Published packages are the core `@purista/harness` package plus independent
provider and capability addons under the `@purista/harness-*` convention. Private example
workspaces are allowed under `examples/` when backed by specs. No `services/`
or `apps/` package is part of v1. Workspace tool is locked to npm workspaces.

The `harness` package contains:
- core harness (`defineHarness` chainable builder, `Harness`, `Session`)
- types and errors
- structured JSON logger (built-in, no external deps)
- OpenTelemetry deep integration (peer dep `@opentelemetry/api`)
- in-memory `StateStore` (default, only state implementation in v1)
- two default `Sandbox` factories: `inMemorySandbox()` (files-only) and `bashSandbox()` (wraps `just-bash` peer dep)
- memory adapter port plus `sandboxMemory()` reference adapter
- built-in tools (bash, read, write, edit, glob, grep, list) operating on the sandbox
- custom TS tools
- MCP stdio + MCP http tools (optional peer dep `@modelcontextprotocol/client` v2)
- generic prepared MCP stdio launch bridge used by capability addons; it does
  not know the Agent Plugins format
- testing utilities (port contract test factories, fake provider, fake sandbox), exposed via the `./testing` subpath, never via the main entry

## Dependency table

| Package             | Harness deps             | Peer deps                                                                  |
|---------------------|--------------------------|----------------------------------------------------------------------------|
| `@purista/harness`        | (none beyond peer)       | `typescript@>=5.4`, `zod@^4`, `@opentelemetry/api@^1`, `@opentelemetry/semantic-conventions@^1`, `@modelcontextprotocol/client@^2` (optional, only required when MCP tools are used; `peerDependenciesMeta.optional = true`), `just-bash@^0` (optional, only required when `bashSandbox()` is used; `peerDependenciesMeta.optional = true`), `vitest@^2` (peer of `@purista/harness/testing`) |
| `@purista/harness-openai` | `@purista/harness`       | `typescript@>=5.4`, `openai@^4`                                            |
| `@purista/harness-anthropic` | `@purista/harness`    | `typescript@>=5.4`, `@anthropic-ai/sdk`                                    |
| `@purista/harness-bedrock` | `@purista/harness`      | `typescript@>=5.4`, `@aws-sdk/client-bedrock-runtime`                      |
| `@purista/harness-azure-foundry` | `@purista/harness` | `typescript@>=5.4`, `@azure-rest/ai-inference`, `@azure/core-auth`, `@azure/core-sse` |
| `@purista/harness-agent-plugins` | `@purista/harness` | `typescript@>=5.4` plus local parsing/schema-validation dependencies only; no provider SDK or MCP SDK dependency |
| `@purista/harness-memory-*` | `@purista/harness` | `typescript@>=5.4` plus the adapter's official backend SDK only |

Dev deps for every package: `typescript@>=5.4`, `vitest@^2`, `@types/node`. Provider packages may add only their official provider SDK dependencies.

## Module shape inside the harness package

```
src/
  index.ts              # public API barrel (see 13-public-api.md)
  testing/
    index.ts            # subpath @purista/harness/testing
  errors/               # error catalog (see 15-error-catalog.md)
  logger/               # Logger interface + default JSON logger
  telemetry/            # OTel shims, attribute keys, span/metric helpers
  ulid/                 # internal ULID utility
  ports/                # state, sandbox, memory, model-provider
  state/in-memory/      # default StateStore impl
  memory/sandbox/       # sandboxMemory() reference MemoryAdapter
  sandbox/in-memory/    # inMemorySandbox() — files-only
  sandbox/bash/         # bashSandbox() — wraps just-bash peer dep
  models/               # alias registry, capability gate
  tools/builtin/        # bash, read, write, edit, glob, grep, list + alias dispatch
  tools/                # ts tool runner, tool registry, MCP stdio + http runners
  skills/               # SKILL.md frontmatter loader, mount-at-/skills/<name>
  sessions/             # session impl, run lifecycle, internal streaming generator
  agents/               # default loop, agent registry
  workflows/            # workflow registry
  harness/              # defineHarness, config schema, wiring
```

## Build & module format

- ESM only. `"type": "module"` in every package.
- Output: `dist/index.js` + `dist/index.d.ts`. `dist/testing/index.js` + `dist/testing/index.d.ts` for the testing subpath. No CJS dual build.
- Target: `ES2022`. `module: NodeNext`.
- No bundling; ship raw `.js` + `.d.ts` files.

## Cross-references

- [00-overview](./00-overview.md)
- [02-harness-config](./02-harness-config.md)
- [13-public-api](./13-public-api.md)
- [17-implementation-plan](./17-implementation-plan.md)
