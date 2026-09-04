# Static Harness modules

**Status:** superseded by
[42-composable-definitions-and-catalogs](./42-composable-definitions-and-catalogs.md)
for the v4 clean break.

`HarnessModule`, `HarnessModuleBuilder`, `defineHarnessModule`, module callback
registration, module provenance, and public `BuilderState` authoring are removed.
Reusable composition uses immutable `defineCatalog(...)` values. Package-family
dependency rules and lifecycle ownership remain governed by
[01-architecture](./01-architecture.md) and the applicable adapter specs.

This file contains no implementation contract.
