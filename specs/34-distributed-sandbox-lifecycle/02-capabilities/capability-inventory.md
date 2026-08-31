# Capability inventory

| ID | Capability | Owner/consumer | Entrypoint | Observable result |
| --- | --- | --- | --- | --- |
| CAP-SBX-IDENTITY | Bind a logical sandbox to exact Harness/session/run scope | Harness core | existing `getSession(id, identity)` and run orchestration | matching scope or validation error before sandbox access |
| CAP-SBX-OPEN | Create or attach one logical sandbox | sandbox adapter | `Sandbox.open(...)` | created, attached, resumed, restored, or typed failure |
| CAP-SBX-FENCE | Prevent a stale attachment from mutating compute | sandbox adapter/control plane | returned `SandboxSession` methods | stale mutation rejected at the compute boundary |
| CAP-SBX-RECOVER | Replace lost run compute after durable-file recovery | Harness plus compatible sandbox/workspace ports | `Sandbox.open(...)` with explicit recovery authorization | restored generation or state-lost error |
| CAP-SBX-CLEANUP | Detach or terminate without a core cleanup subsystem | Harness caller plus sandbox adapter | `SandboxSession.close()` and `Sandbox.terminate(...)` | durable termination accepted; adapter reclaims resources |
| CAP-SBX-OBSERVE | Diagnose operations without content or identity leakage | operator | standard spans and metrics | bounded content-free evidence |
| CAP-SBX-TEXT-SEARCH | Search files with one bounded provider-neutral contract where the files live | sandbox adapter | `SandboxSession.searchText(...)` with `sandbox.text_search` | ordered matches plus truthful complete/limited outcome |
| CAP-SBX-CONTRACT | Verify lifecycle behavior for every adapter and distributed behavior for production adapters | adapter author | `sandboxContract` and `sandboxMultiClientContract` | deterministic conformance result |
| CAP-SBX-PURISTA | Use Harness under PURISTA without reversing dependencies | PURISTA Core | existing AI runtime composition | public-contract-only mapping and startup gates |
| CAP-SBX-BAKEOFF | Compare E2B and Daytona with identical criteria | maintainers | opt-in probe | evidence report and provider decision gate |
| CAP-SBX-DOCKER | Execute and search in a local Docker container using one optional addon, including OrbStack | standalone application or PURISTA composition root | `dockerSandbox(options)` through ordinary `Sandbox` | retained files, data-local bounded search and reattachment on one engine, explicit state loss, scoped cleanup; no new checkpoint system |

There is no new frontend, webhook, admin UI, storage adapter, public lease API,
or Harness cleanup service in this scope. Provider credentials, retention
values, coordination deployment, and infrastructure provisioning remain
adapter/application responsibilities.
