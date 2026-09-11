# Implementation plan authority

**Status:** active v4 planning pointer.

The executable clean-break plan is
[`plans/harness-v4-clean-break/plan.json`](../../plans/harness-v4-clean-break/plan.json)
with its generated Markdown view in the same directory. The plan is rebuilt
after the v4 specification and independent-readiness digests are final.

[Spec 42](./42-composable-definitions-and-catalogs.md) owns the implementation
acceptance detail and ticket identifiers for Harness v4. The workspace plan
orders that work across Harness, PURISTA, starter, create-purista, declared
downstream consumers, examples, documentation, tutorials, CLI generation, skills, package
verification, and coordinated publication gates.

Implementation agents must use the current plan ticket assigned to them. They
must not infer work from an earlier release phase, reintroduce a removed API to
make an old test pass, or implement a compatibility bridge.

## Required order

The plan maintains these dependency boundaries:

1. freeze independently reviewed v4 definitions, inference, runtime, stream,
   tool-caller, and host integration contracts;
2. implement immutable definitions, graph compilation, and exact runtime
   requirements;
3. implement runtime binding validation and optional process-local admission;
4. implement Skill/MCP initialization and the shared tool pipeline;
5. implement agents, subagents, workflows, model invokers, managed-call replay,
   sessions, streaming, interruption, and durable recovery;
6. implement the host-integrator SPI and AI SDK UI Message Stream v1 adapter;
7. align provider and infrastructure addons;
8. delete every replaced implementation and verify removal;
9. align PURISTA Core, Hono, service export, queue, CLI, and testing;
10. align starter, create-purista, declared downstream consumers, examples, handbook, API docs,
    tutorials, public knowledge, and canonical skills;
11. verify packed installs, coordinated versions, clean consumers, and release
    artifacts;
12. ask for the explicit human publication/merge actions only after all
    reversible implementation and verification work is complete.

## Per-ticket completion

A ticket is complete only when:

- its declared source and consumer scope uses the current v4 contract;
- positive runtime, type-inference, and negative removed-API tests pass;
- no placeholder, compatibility shim, legacy alias, dual path, or copied
  contract remains;
- changed public TypeScript APIs have concise TypeDoc-ready documentation;
- examples and documentation use installable public package shapes;
- focused tests plus the plan's broader acceptance commands pass;
- the implementation and verification evidence is committed under the ticket.

The plan's final review must scan code, declarations, examples, Mermaid
diagrams, generated templates, docs, handbook, tutorials, skills, and locks.
Passing a narrow unit suite does not prove repository-wide completion.

## Publication boundary

Source changes, local builds, packed-install verification, commits, pushes, and
pull requests follow the task's existing authorization. Publishing packages,
merging release pull requests, or creating release tags requires the explicit
release gate in the plan. Runtime code contains no release migration mechanism.
