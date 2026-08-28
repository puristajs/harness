# End-to-end definition chains

Each row's detailed success/failure cases, exact tests and commands are in the
matching ACC-SOWN section of 04-verification.md. There is no frontend surface.

| Path | Actor and reachable entrypoint | Data/state and side effects | Permission, failure and recovery | Final state/observability | Acceptance |
| --- | --- | --- | --- | --- | --- |
| PATH-SOWN-POLICY | Author; builder/agent/workflow/child | Policy to partition; mount files | Literal/runtime validation; child borrower cannot delete parent | Selected partition; no group labels in metrics | ACC-SOWN-POLICY |
| PATH-SOWN-OWNER | Application; getSession/open | Session binding pending to registered; lazy partition intent | Exact identity plus callback; missing known state fails; retry registration | Active or denied/state_lost; sanitized outcome | ACC-SOWN-OWNER |
| PATH-SOWN-DURABLE | Runtime; step commit/resume | One aggregate tree and committed pin | Quiescence; reject external owner; crash uses prior committed files | Consistent restored partitions; no checkpoint refs in telemetry | ACC-SOWN-DURABLE |
| PATH-SOWN-ADMIN | Operator; list/purge | Indexed selector, revocation and delete journal | Trusted admin; partial/cancelled deletion retains progress; fence live writers | completed only after absence, otherwise cleanup_pending | ACC-SOWN-ADMIN |
| PATH-SOWN-BOUNDS | Operator; configure/sweep/admit | Finite catalog/copies; eligible unpinned GC | Reject unsupported fields; preserve pins/tombstones; deny capacity | Bounded growth with truthful disk limits; count-only alarms | ACC-SOWN-BOUNDS |
| PATH-SOWN-PURISTA | Queue caller; generated attached-agent entrypoint | Hashed scoped IDs; terminal receipt before disposal | Trust framework identity; retry/suspend retains state; borrowed owner survives | Replayed result without model/compute; normalized framework error | ACC-SOWN-PURISTA |
| PATH-SOWN-SAFETY | All callers; public boundary | Closed DTO parse and error projection | No unchecked authority/paths; cancellation does not undo revocation | Explicit safe error codes and NO_CONTENT signals | ACC-SOWN-SAFETY |
| PATH-SOWN-DELIVERY | Developer; public package imports | Atomic source cutover and generated declarations | No hidden PURISTA dependency or legacy overload; old layouts fail without writes | One coherent release; independently reviewed test evidence | ACC-SOWN-DELIVERY |
