# SQLite memory example

Install and run this example from its directory:

```sh
npm install
npm start
```

It persists a scoped JSON fact through the local SQLite memory engine. The example binds a tenant and
principal at `getSession(...)`; reopening the same session with a different or
missing bound dimension is rejected before a sandbox or memory engine opens.

Use this shape for a local durable deployment. For multi-instance production
memory, configure a tested PostgreSQL, Redis, or NATS engine at the same
composition point.
