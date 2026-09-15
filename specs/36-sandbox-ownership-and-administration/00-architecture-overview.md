# Architecture

Application composition selects one adapter and optional sharing vocabulary.
Harness resolves policy to owner/lifetime/partition and invokes one Sandbox port.
Adapter catalogs own resource creation, offboarding, fencing, bounds and cleanup.
DurableWorkspace owns one run's aggregate files/checkpoints and pin inventory.
PURISTA is a public-API consumer mapping trusted framework context into Harness.

No control-plane package, registry storage port, grant service or background core
scheduler is added. See DEC-SOWN-BOUNDARY in 00-vision.md and the precise contracts.

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Harness | Selection, sessions, run/checkpoint publication | Provider IDs or distributed leases |
| Sandbox adapter | Files/compute, owner catalog, fencing and purge | Conversation history or framework types |
| Workspace adapter | Aggregate recovery files, pins, quota enforcement | Agent policy selection or account authentication |
| PURISTA | Message identity and builder-to-Harness mapping | A second sandbox contract |
| Application | Operator authorization, sweep scheduling, offboarding orchestration | Guessing provider IDs or editing private journals |
