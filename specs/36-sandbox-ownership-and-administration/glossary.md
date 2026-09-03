# Glossary

- Owner: immutable resource ownership identity, namespace and incarnation.
- Acting identity: caller identity authorized to use an owner's files; not a key suffix.
- Partition: shared, definition-private or named-group filesystem in one lifetime.
- Borrower: session/child using someone else's owner/partition; detach is not deletion.
- Incarnation: immutable opaque instance separating intentional owner/session recreation.
- Pin: durable relationship protecting a committed checkpoint needed for recovery.
- Revocation barrier: adapter-private persisted denial that fences current and future work.
- Sweep: bounded application-triggered scan of eligible resources, not a core daemon.
- State loss: known logical resource has no safe live or committed-file recovery state.
