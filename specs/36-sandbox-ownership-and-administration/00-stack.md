# Stack and dated dependency evidence

No dependency additions or upgrades are selected. Reuse the repository lockfile:
Node >=24.15.0, TypeScript compiler alias @typescript/typescript6, Zod 4,
Vitest, built-in SQLite, existing local filesystem and Docker CLI integration.
The public contract has no network protocol or third-party API addition.

Primary documentation reviewed 2026-08-26:

- [Node filesystem](https://nodejs.org/api/fs.html): filesystem promises are not
  synchronized transactions; checkpoint copy needs an explicit write barrier.
- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html): use existing
  transaction boundaries for session binding and committed-reference updates.
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/): volumes have a
  lifecycle independent of a container; explicit owned-volume deletion is required.
- [Zod API](https://zod.dev/api): strict objects and inferred types are the current
  source-derived boundary pattern. Use the installed supported version.

These sources inform constraints, not a recommendation to upgrade to their newest
release. Exact installed versions are recorded by implementation preflight.
No new SDK/provider bake-off or package acquisition is required. Hard Docker volume
quota portability is deliberately not claimed. Offline verification uses already
installed dependencies and caller-prepared local engines/images only.
