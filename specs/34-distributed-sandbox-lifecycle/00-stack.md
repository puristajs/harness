# Stack and dependency policy

- Runtime, language, package manager, compiler, and supported operating systems
  remain those approved for `@purista/harness`; the contract adds no core
  runtime dependency.
- `HarnessStorage` adds immutable session incarnation and conditional
  create/update/delete semantics, not sandbox lifecycle records or methods.
  Sandbox coordination storage or a control plane remains adapter-private.
- Provider packages use only the public `@purista/harness` surface plus the
  official provider SDK and, when necessary, their own control-plane client.
- PURISTA Core uses the public Harness package. Harness packages never import
  PURISTA packages.
- E2B and Daytona SDK/API versions are recorded by the dated bake-off rather
  than pinned by this pre-selection specification.
- Provider credentials, control-plane deployment, schedulers, retention values,
  OpenTelemetry SDK/exporters, and secret managers remain adapter/application
  composition concerns.
- Provider spikes are non-published, opt-in, and credential-gated. No provider
  SDK enters the `packages/harness` dependency graph.
- The local Docker addon uses the installed official Docker CLI through Node
  process APIs, without a host shell or new SDK dependency. Docker/OrbStack
  support is bounded by opt-in release evidence; current primary references,
  configuration, and limits are in `05-integration/local-docker.md`.
