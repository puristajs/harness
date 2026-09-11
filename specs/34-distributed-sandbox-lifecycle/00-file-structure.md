# File structure

The implementation extends existing ownership instead of adding a second
lifecycle subsystem:

```text
packages/harness/src/
  sandbox/                 # one lifecycle-aware public Sandbox contract
  local/                   # rewrite both local-directory variants and bundle binding in place
  sessions/ and runtime/   # narrow scope/recovery integration
  errors/                  # SandboxStateLostError
  telemetry/               # catalog-backed operation telemetry
  testing/                 # base lifecycle and shared two-client contracts
packages/harness-sandbox-docker/    # optional local Docker/OrbStack adapter
  src/                            # factory, private transport/lifecycle and colocated tests
  test/                           # operator-built live-test image fixture
  README.md                       # standalone setup and local operations
examples/local-docker-sandbox/     # private standalone example, no PURISTA
scripts/check-sandbox-packages.mjs # opt-in packed consumer gate, no registry publication
scripts/fixtures/                 # isolated consumer runtime/type assertions
packages/harness-sandbox-<winner>/   # production only after provider decision
```

There is no new `sandbox-lifecycle/` core subsystem and no sandbox lifecycle
module under `storage/`. Local adapter implementations remain in their existing
files. Docker has its own addon; no engine provisioning or guest daemon package
is added. Provider spikes live in one non-published, opt-in location selected by
the implementation ticket; no production addon folder is created during the
contract or bake-off waves.
