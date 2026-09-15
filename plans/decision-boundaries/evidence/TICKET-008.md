# TICKET-008 — in-scope consumer integration

Status: accepted after the owner explicitly excluded Voyage on 2026-08-26.

The consumer verifier uses local source aliases for Core and local built
declarations for Harness packages. It runs Core AgentQueueBuilder compilation,
41 Core runtime tests, strict declaration and runtime-export smoke checks, and
the shared removed-API scanner over starter and create-purista. It does not
read, compile, scan or change Voyage.

`node scripts/verify-decision-consumers.mjs --check` passed after the scope
revision. The 19 node fixture tests pass and prove missing in-scope consumer
directories fail, while an absent or malformed Voyage tree does not affect the
in-scope result. The checker retains no artifact directory on success.

No install, link, package/lockfile change, network request or application
startup was used. Existing Core SSE and type-forwarding changes remain covered
by the final workspace checks recorded in T010.
