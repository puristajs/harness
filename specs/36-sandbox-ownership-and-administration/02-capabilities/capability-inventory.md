# Capability inventory

These are requirement tracking IDs, not new runtime capability flags. Deployment
topology and sharing mode never enter AdapterCapability.

| ID | Consumer and entrypoint | Contract | Lifecycle and proof |
| --- | --- | --- | --- |
| CAP-SOWN-POLICY | Definition author; builder and childTasks.start | CTR-SOWN-POLICY | Resolve partition; ACC-SOWN-POLICY |
| CAP-SOWN-OWNER | Standalone application; getSession/open | CTR-SOWN-OWNER, CTR-SOWN-OPEN | Register, authorize, lazily allocate; ACC-SOWN-OWNER |
| CAP-SOWN-DURABLE | Durable runtime; checkpoint/resume | CTR-SOWN-WORKSPACE | Quiesce, pin, commit, restore; ACC-SOWN-DURABLE |
| CAP-SOWN-ADMIN | Trusted operator; adapter.administration | CTR-SOWN-ADMIN | Inventory, revoke, retry purge; ACC-SOWN-ADMIN |
| CAP-SOWN-BOUNDS | Operator/adapter; constructor and sweep | CTR-SOWN-ADMIN, CTR-SOWN-WORKSPACE | Reserve, deny, collect unpinned data; ACC-SOWN-BOUNDS |
| CAP-SOWN-PURISTA | Framework application; setSandboxPolicy | CTR-SOWN-PURISTA | Map identity, borrow/dispose, replay; ACC-SOWN-PURISTA |
| CAP-SOWN-SAFETY | Every consumer; errors and telemetry | CTR-SOWN-ERRORS | Fail closed with content-free outcomes; ACC-SOWN-SAFETY |
| CAP-SOWN-DELIVERY | Package consumer; public imports | CTR-SOWN-POLICY, CTR-SOWN-OPEN | Clean cutover and independent packages; ACC-SOWN-DELIVERY |
