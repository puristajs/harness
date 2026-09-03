# Tools and Skills

Tools perform narrowly defined operations. Skills provide mounted, reviewable
methods for using those capabilities. An agent receives neither implicitly:
its definition names each tool and skill it may use.

## Start with one typed tool

```ts title="Register the order lookup tool"
import { z } from 'zod'

.tool('find_order', {
    description: 'Find one order visible to the current customer.',
    input: z.object({ orderId: z.string().min(1) }),
    output: z.object({ status: z.enum(['pending', 'shipped', 'delivered']) }),
    handler: async (_ctx, { orderId }) => orders.getVisibleOrder(orderId),
  })
  .agent('support', {
    model: 'assistant',
    tools: ['find_order'],
    instructions: 'Use find_order only when the customer provides an order id.',
  })
```

Input and output schemas are security boundaries, not prose. Keep deterministic
authorization in the tool handler or application layer; do not ask the model
to decide whether a customer may access a record.

## Choose the schema boundary deliberately

Zod is the default in Harness documentation, but the public contract accepts
any [Standard Schema](https://standardschema.dev/) validator. A TypeScript
tool's `input` is different from its other boundaries: the default agent loop
must describe tool arguments to a model, so it requires a **Standard JSON
Schema**-capable `ModelSchema`. Tool `output`, agent input, workflow input, and
workflow/custom-handler output need only the validation `Schema` contract.

Harness projects every model-facing schema once during `.build()` through its
Standard JSON Schema **input** direction with target `draft-2020-12`. It owns
and freezes that JSON value before passing it unchanged to a provider. Do not
wrap a vendor schema, call a provider converter, or construct JSON Schema in a
tool handler.

Zod needs no extra adapter:

```ts title="src/harness/schemas.ts"
import { z } from 'zod'

export const orderLookupInput = z.object({ orderId: z.string().min(1) })
export const orderLookupOutput = z.object({ status: z.string() })
```

ArkType implements both Standard Schema and Standard JSON Schema directly:

```ts title="src/harness/schemas.ts"
import { type } from 'arktype'

export const orderLookupInput = type({ orderId: 'string' })
export const orderLookupOutput = type({ status: 'string' })
```

Valibot schemas are Standard Schema validators. Add the official
`@valibot/to-json-schema` wrapper only when the same schema is model-facing,
such as a TypeScript tool input or a default-loop agent output:

```ts title="src/harness/schemas.ts"
import { toStandardJsonSchema } from '@valibot/to-json-schema'
import * as v from 'valibot'

const orderLookupValidation = v.object({ orderId: v.string() })
export const orderLookupInput = toStandardJsonSchema(orderLookupValidation)
export const orderLookupOutput = v.object({ status: v.string() })
```

The wrapper is an application dependency, not a Harness adapter. Install it
beside Valibot with `npm install @valibot/to-json-schema`. Do not apply it to a
validation-only boundary unless that boundary later becomes model-facing.

## Add a skill when the method needs reviewed files

Skills are directories mounted into the sandbox. They are not copied into a
prompt. Register the directory, allowlist it for the agent, and retain the
built-in `read` tool so the agent can open the required `SKILL.md`.

```ts title="Register the support-methods skill"
.skill('support_methods', { directory: './skills/support-methods' })
  .agent('support', {
    model: 'assistant',
    skills: ['support_methods'],
    builtinTools: ['read'],
    tools: ['find_order'],
    instructions: 'Read the mounted support method before handling a return.',
  })
```

Use repeated `.tool(...)` calls for inline native tools. Use `.tools(record)`
when definitions have already been typed and collected into a reusable native,
MCP, or mixed catalog. This distinction keeps inline handler input/output and
sandbox capability inference exact without an identity helper.

Use a TypeScript tool for a business operation. Use a skill for a reusable,
reviewed method, checklist, or file-backed reference. Use
[MCP tools](./mcp-tools.md) only when an external tool server is the correct,
explicit integration boundary.

Built-ins are disabled when `builtinTools` is omitted. Skills never widen that
set: a default-loop skill agent must explicitly include `read`, and
registration fails before model or sandbox I/O if it does not.

Review a skill directory like executable source even though mounting does not
execute it. Instructions can attempt to steer allowed tools, and scripts can
run if the application separately exposes an execution-capable tool.
Frontmatter `allowed-tools` is metadata only; authorization remains in the
agent allowlists, tool handlers, governance, and sandbox.

## Search files without granting a shell

Enable `grep` when an agent needs to find text in sandbox files:

```ts title="Enable bounded file search"
.agent('support', {
  model: 'assistant',
  builtinTools: ['read', 'grep'],
  instructions: 'Search the mounted material, then open only relevant files.',
})
```

The default sandbox already provides this feature. `grep` calls the sandbox's
`sandbox.text_search` capability; it does not compile a JavaScript `RegExp`,
read every file into the agent loop, or invoke a shell. Literal search is the
simplest mode. `safe_regex_v1` is a versioned non-backtracking subset for cases
that need pattern operators; it accepts ASCII patterns and case-sensitive mode
only. Case-insensitive literal search folds ASCII letters consistently across
local and remote adapters.

Every response says whether it is exhaustive:

```ts
{
  matches: [{ path: '/workspace/runbook.md', line: 18, text: '...', textTruncated: false }],
  complete: false,
  limitReasons: ['result_limit'],
  scannedFiles: 12,
  scannedBytes: 48120,
}
```

Agents and workflows must not interpret `complete: false` as “there are no
more matches.” Narrow the path or pattern and search again. The fixed contract
caps pattern size, result count, returned-line bytes, file size, total scanned
bytes, and file count.

## Next

- [Usage and sessions](./usage.md)
- [Workflows](./workflows.md)
- [Security model](../security/security-model.md)
- [Testing](./testing.md)
