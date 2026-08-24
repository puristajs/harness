# Durable human review reference

This executable reference is the application layer around Harness external
waits. It demonstrates stable business keys, compare-and-set decisions,
idempotent terminal delivery, canonical action-digest binding, reauthorization
point before a domain side effect, and idempotent execution keys.

It intentionally does not provide a generic reviewer UI, identity provider, or
database. Replace `ReviewTaskStore` with a transactional PURISTA service/store;
authenticate and authorize the reviewer before `decide`, publish the decision
through an outbox, signal the wait adapter, then redeliver the same workflow
run id.

Run `npm test --workspace @purista/durable-human-review-example` from the
repository root.
