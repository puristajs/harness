# Definitions and composition

## Tool

```ts
const findAccount = defineTool('findAccount', {
  description: 'Find one account by public reference.',
  input: z.object({ reference: z.string() }),
  output: z.object({ accountId: z.string() }),
  requires: { memory: ['memory.kv'] },
  async handler(context, input) {
    const account = await context.memory.tenant().read<{ accountId: string }>(input.reference)
    if (!account) throw new Error('Account not found')
    return account
  },
})
```

Portable tools declare the memory or sandbox capabilities they need, and their
context exposes only those operations. A framework integration can create a
branded host tool with its own typed context for service resources, command
invocation, queue operations, or emitted events. Validate input before effects
and return output accepted by the declared schema.

## Agent

```ts
const answerQuestion = defineAgent('answerQuestion', {
  model: 'primary',
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string() }),
  tools: [findAccount],
  instructions: 'Use available tools when the question requires account data.',
  prompt: input => ({ role: 'user', content: input.question }),
})
```

An agent is the standard bounded model loop. It can declare tools, skills, subagents, memory policy, guardrails, governance, permissions, and sandbox policy. Use a workflow for custom procedural logic.

## Workflow

```ts
const resolveQuestion = defineWorkflow('resolveQuestion', {
  input: questionSchema,
  output: answerSchema,
  agents: { answerQuestion },
  agentCalls: { maxCalls: 2, maxParallel: 1 },
  async handler(context) {
    return context.agents.answerQuestion.run(context.input, { callId: 'answerQuestion' })
  },
})
```

Workflow agent calls always go through the runtime dispatcher and preserve tracing, storage, limits, cancellation, and future hosted routing. Use stable `callId` values. Use `context.childTasks` for isolated background turns and `context.step` for durable replay-safe application effects.

## Composition

```ts
const shared = defineCatalog('supportCatalog', { tools: [findAccount], agents: [answerQuestion] })
const definition = defineHarness({ name: 'support' }).use(shared).addWorkflow(resolveQuestion)
```

Catalogs contain definitions only. Duplicate ids fail during composition. Runtime adapters are never catalog members.
