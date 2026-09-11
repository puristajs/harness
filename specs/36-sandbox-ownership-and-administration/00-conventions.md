# Conventions

## CONV-SOWN-PURISTA

Reuse the canonical PURISTA skill and ai-harness skill, workspace AGENTS.md and
repository implementation guides. Feature decisions here override stale examples,
not foundational package/error/style rules. Harness uses its existing ESM .js
imports, strict TypeScript, camelCase exports and schema-derived data types;
PURISTA uses its existing builder layout, tabs, type aliases and type-only imports.
Run each repository's configured formatting only on owned files.

## CONV-SOWN-TYPES

Reuse HarnessIdentity, SandboxSessionFor, capability tuples, JsonValue, the ULID
helper, existing error serialization and cancellation handling. Closed boundary
DTOs use strict Zod schemas and inferred types; function interfaces remain typed
source. No any, unchecked double cast, copied framework DTO or permissive fallback.
Unknown input is parsed once at a boundary, not passed through domain logic.
The generation map in 03-contracts/generation-map.yaml owns source contracts,
generated declarations, manual-code boundaries and drift-check commands.

## CONV-SOWN-AUTONOMY

D0 mechanical execution and D1 private reversible helper/test placement only.
No changes to public names, defaults, lifetimes, authorization, errors, schemas,
retention promises, dependencies, package direction or compatibility policy.
Missing evidence means a blocker. Do not convert a failing test to a skip or
weaken a coverage threshold. No implementation is authorized in the planning turn.
