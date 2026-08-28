# Glossary

- **Attachment:** one client's live connection to a logical sandbox generation.
- **Fence:** an adapter-private monotonic authority that prevents a stale
  attachment from mutating compute.
- **Generation:** one concrete provider-compute lifetime for a stable logical
  scope; handoff does not change it.
- **Logical scope:** Harness name, exact optional identity, session id,
  persisted opaque session instance id, lifetime, optional run, and role used
  by the adapter as the stable lookup key within its declared authority.
- **Provider reference:** opaque, non-secret, adapter-private locator for
  provider compute.
- **State loss:** missing lifecycle state or authoritative absence of known
  provider compute when Harness has not authorized replacement from a
  committed durable workspace.
- **Workspace recovery:** resuming committed `DurableWorkspace` files, binding
  the run sandbox, and only then authorizing the adapter's next generation.
