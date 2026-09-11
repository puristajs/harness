# PURISTA integration — DEC-SOWN-PURISTA

This document preserves the Framework-specific sandbox ownership behavior. The
v4 authoring and mounting API is owned by
[spec 42](../42-composable-definitions-and-catalogs.md#11-purista-integration).
Harness remains independently usable and does not import PURISTA packages or
copy their interfaces.

## Definition and runtime mapping — CTR-SOWN-PURISTA

An agent or workflow declares `sandbox: 'inherit' | 'private' | { group }` on
its own definition. `ServiceBuilder.mountHarness(definition, policy?)` mounts
the complete graph. The service's inferred `ai` instance configuration supplies
one sandbox adapter and the closed `sandboxBinding` options:

```ts
const service = serviceBuilder.mountHarness(supportHarness)

const instance = await service.getInstance(eventBridge, {
  ai: {
    models: { chat: { provider, model: 'chat-model' } },
    sandbox,
    sandboxBinding: {
      groups: ['support-review'],
      defaultPolicy: 'inherit',
      authorizeOwner,
    },
  },
})
```

The graph's exact sandbox capabilities and named groups determine whether these
fields are available and required. A graph without sandbox needs cannot receive
them. The adapter, credentials, lifecycle administration, topology, group
vocabulary, and borrowed-owner authorization remain application runtime
concerns. A target definition cannot select or replace an adapter.

Mounted root agents and workflows receive public EventBridge addresses. Their
recursive dependency closure receives private immutable routes. Every subagent
and workflow child call still crosses EventBridge and therefore cannot bypass
the receiving target's schema validation, identity checks, admission, sandbox
authorization, or lifecycle rules.

Trusted message data supplies `tenantId` and `principalId`; model input cannot
set either value. PURISTA derives stable private session and run identifiers
from a versioned tuple containing service, version, target, explicit optional
identity presence, execution mode, and the application-owned logical id. Raw
identity values never appear in logs or telemetry.

## Borrowed owners

The application may pass an explicit `sandboxOwner` only through the trusted
session attachment performed by the integration. `authorizeOwner` is mandatory
for borrowing. Tenant and principal scope checks run before the callback and the
callback runs again before each top-level invocation, nested launch, and resume.
A resolver or callback receives validated identity and application data, never a
raw broker envelope or model-controlled owner value.

Two mounted targets share files only when their resolved owner and partition
match. `canInvokeAgent` and `canInvokeWorkflow` transport identity and address;
they never transport a sandbox handle or confer owner authorization.

## Completion, replay, and cleanup

Persist the terminal Harness outcome before disposing ephemeral compute. A run
that is waiting, interrupted, retryable, or externally suspended releases its
attachment while retaining files needed for resume. A completed,
non-retryable-failed, or cancelled ephemeral run disposes owned sandbox
resources after the receipt is durable. Borrowed owners detach without deleting
shared compute.

Terminal redelivery replays the saved result before opening a sandbox or model.
Durable retries retain the same run id and partition. A cleanup failure never
replaces the already persisted execution outcome; it leaves a content-free
cleanup-pending diagnostic and an adapter journal for retry or operator sweep.

Receipt and history retention remain HarnessStorage/application concerns and
are independent from sandbox TTL. Operators retain receipts through the queue
redelivery window. No sandbox cleanup path deletes a run receipt, conversation,
business record, or another owner's files.

## Errors and verification

PURISTA maps known Harness errors to handled Framework errors while preserving
only the canonical code, category, and retry classification. Configuration and
validation map to bad request, owner denial to forbidden, conflicts/state loss
to conflict, capacity to too many requests, provider or cleanup availability to
service unavailable, and timeout/cancellation to request timeout. Unknown
failures become a content-free internal error. Interruptions and external waits
are typed expected outcomes and never become HTTP 500 responses.

Verification covers exact identity scoping, borrowed-owner authorization,
public/private EventBridge routing, restart and redelivery, interruption/resume,
terminal cleanup ordering, cleanup retry, and absence of raw identity, paths,
policy inputs, prompts, or tool payloads from diagnostics.
