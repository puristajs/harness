# Modular Support Harness

A runnable, hermetic example of the static module API. It keeps reusable
model and agent definitions in local modules while the application retains
ownership of its workflow and customer-specific state.

## Run it

```bash
npm run test --workspace @purista/modular-support-harness
OPENAI_API_KEY=... npm run start --workspace @purista/modular-support-harness
```

Set `OPENAI_MODEL` to override the default `gpt-5-mini` model. The tests inject
a deterministic provider, so they never require a network call or a credential.

## What this shows

- **Share a capability safely.** `supportModels()` registers the provider alias;
  `supportAgents` requires that alias and receives full type checking. The
  builder rejects duplicate module and definition ids instead of silently
  replacing a previous contribution.
- **Keep business orchestration local.** `answer_support_ticket` is deliberately
  not a module. It owns the tenant/session state and composes the reusable
  `answer_ticket` agent with the app's domain behavior.
- **Prepare for large tool results.** The default retry-only context projection
  prunes oversized future tool results only if a model rejects the original
  context. It never mutates durable history used for audit or replay.
- **Test without leaking content.** The second test records a fixture through a
  required sanitization function, replays it with a no-network provider, and
  verifies module provenance with a content-free diagnostic invariant.

This pattern suits a support platform with a shared answer agent but
application-specific routing, approval, tenant configuration, and workflow
state. It also fits a package that publishes a stable domain agent while each
consumer keeps its own workflows and adapters.
