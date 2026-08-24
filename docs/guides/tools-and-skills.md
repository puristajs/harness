# Tools and Skills

Tools perform narrowly defined operations. Skills provide mounted, reviewable
methods for using those capabilities. An agent receives neither implicitly:
its definition names each tool and skill it may use.

## Start with one typed tool

```ts
import { z } from 'zod'

.tools({
  find_order: {
    description: 'Find one order visible to the current customer.',
    input: z.object({ orderId: z.string().min(1) }),
    output: z.object({ status: z.enum(['pending', 'shipped', 'delivered']) }),
    handler: async (_ctx, { orderId }) => orders.getVisibleOrder(orderId)
  }
})
.agents(({ agent }) => ({
  support: agent({
    model: 'assistant',
    tools: ['find_order'],
    builtinTools: false,
    instructions: 'Use find_order only when the customer provides an order id.'
  })
}))
```

Input and output schemas are security boundaries, not prose. Keep deterministic
authorization in the tool handler or application layer; do not ask the model
to decide whether a customer may access a record.

## Add a skill when the method needs reviewed files

Skills are directories mounted into the sandbox. They are not copied into a
prompt. Register the directory, allowlist it for the agent, and retain the
built-in `read` tool so the agent can open the required `SKILL.md`.

```ts
.skills({ support_methods: './skills/support-methods' })
.agents(({ agent }) => ({
  support: agent({
    model: 'assistant',
    skills: ['support_methods'],
    builtinTools: ['read'],
    tools: ['find_order'],
    instructions: 'Read the mounted support method before handling a return.'
  })
}))
```

Use a TypeScript tool for a business operation. Use a skill for a reusable,
reviewed method, checklist, or file-backed reference. Use
[MCP tools](./mcp-tools.md) only when an external tool server is the correct,
explicit integration boundary.

## Next

- [Usage and sessions](./usage.md)
- [Workflows](./workflows.md)
- [Security model](../security/security-model.md)
- [Testing](./testing.md)
