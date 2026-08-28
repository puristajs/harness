# Sandbox

## Contents
- Mental Model
- Built-In Sandboxes
- SandboxSession API
- Exec Options And Results
- Skills And Memory Mounts
- Built-In Tools And Risk
- Custom Sandbox Adapters
- Snapshot And Resume Capabilities
- Testing

## Mental Model
The sandbox is a logical session- or run-scoped filesystem and optional command-execution boundary. TypeScript tools receive a capability-inferred attachment; MCP stdio requires its `spawn` operation. Deployment topology is adapter-private: the same contract works for one local process, a Docker guest, or a remote provider.

Keep sandbox policy explicit. Do not treat host filesystem, process execution, network policy, or secrets as implicitly safe.

## Built-In Sandboxes
```ts
import { bashSandbox, inMemorySandbox } from '@purista/harness'

defineHarness().sandbox(inMemorySandbox())
defineHarness().sandbox(bashSandbox({
  executionLimits: { wallClockMs: 120_000, maxFileSystemBytes: 64 * 1024 * 1024 }
}))
defineHarness().sandbox() // auto-detect bashSandbox(), fallback to inMemorySandbox()
```

`inMemorySandbox()`:
- capabilities: `['sandbox.fs']`
- filesystem-only
- `executor: 'unavailable'`
- `bash` and stdio MCP cannot run

`bashSandbox()`:
- capabilities: `['sandbox.fs', 'sandbox.exec']`
- requires optional peer dependency `just-bash`
- creates an in-memory filesystem session with command execution delegated to `just-bash`
- shares one filesystem between file APIs, mounted skills, and commands
- network and Python are disabled by default; opt in with reviewed `network.allow` URL prefixes or `python: true` only when needed
- `maxFileSystemBytes` bounds retained emulator filesystem bytes, not host memory; `wallClockMs` caps command duration
- configuration is strict: unknown fields and invalid limits fail with `HarnessConfigError`; the optional `just-bash` peer must be installed

`localDirectorySandbox({ root, exec?, coordinator? })` (part of `localDurableExecution`):
- default capabilities: `['sandbox.fs', 'sandbox.persistent_fs']` (files-only); a compatible coordinator adds `sandbox.workspace_binding`, and configuring `exec` adds `sandbox.exec` and `sandbox.spawn` — persistence is independent of exec
- host-directory persistence with a realpath jail; symlink escapes (including dangling symlink write targets) and traversal-shaped `sessionId`/`runId` throw `SandboxError{reason:'invalid_path'}`
- maps `/workspace` to the active durable workspace when bound through the coordinator
- exec runs without a shell (tokenized argv); unquoted shell metacharacters are rejected when `allowCommands` is set; output capture caps at 10 MiB per stream; timeout falls back to the harness `toolTimeoutMs`; abort surfaces `OperationCancelledError{scope:'sandbox'}`
- durable local persistence, not a hardened isolation layer — enabling `exec` is a host trust decision

## Enterprise Selection Rule

Do not call every `Sandbox` a security sandbox. The Harness contract owns a
session filesystem, declared execution capabilities, cancellation and close;
the selected adapter and deployment platform own process identity, filesystem
mounts, network egress, resource limits, image/package provenance, tenancy,
and secure cleanup.

| Requirement | Minimum suitable choice | Not sufficient on its own |
| --- | --- | --- |
| Reviewed files plus TypeScript/HTTP tools | `inMemorySandbox()` | A session ID or schema is not authorization |
| Trusted local transformation | `bashSandbox()` with a narrow reviewed use case | `bashSandbox()` is not a container/VM and cannot host stdio MCP |
| Local durable trusted worker | `localDurableExecution({ exec: false })`, or explicitly reviewed host exec | The local path jail is not a tenant/process isolation boundary |
| Untrusted/model-directed command or stdio MCP | A custom container, microVM, or remote adapter that enforces its policy | A host process, `bashSandbox()`, or local directory sandbox |
| Trusted Agent Plugin stdio process | Spawn-capable **and** immutable-mount-capable isolating adapter | `inMemorySandbox()` and `localDirectorySandbox()` cannot enforce `mountReadOnly(...)` |

For an executor in a regulated production deployment, require platform tests
for default-deny egress, unprivileged process identity, CPU/memory/PID/disk and
wall-clock limits, scoped secret injection, per-run/tenant workspace mounts,
process cleanup, retention cleanup, and no raw content in telemetry. Never let
the model choose a command, package install source, credential, mount, or
network destination.

## SandboxSession API
Every sandbox session supports:

```ts
read(path): Promise<Uint8Array>
readText(path, 'utf-8'?): Promise<string>
write(path, Uint8Array | string): Promise<void>
remove(path, { recursive }?): Promise<void>
list(path, { recursive, glob }?): Promise<DirEntry[]>
stat(path): Promise<FileStat>
exists(path): Promise<boolean>
mount(files, atPath): Promise<void>
close(): Promise<void>
executor: 'available' | 'unavailable'
```

Paths must be absolute POSIX paths. Invalid paths throw `SandboxError` with `reason: 'invalid_path'`.

Register `.sandbox(adapter)` before `.tools(...)`. Its literal capability tuple
flows into `ctx.sandbox` and survives later builder calls and `.use(module)`.
Files-only adapters expose neither `exec` nor `spawn` in TypeScript. A widened
`Sandbox` or auto-detected adapter exposes the base filesystem session; use
`isExecCapableSession(session)` or `isSpawnCapableSession(session)` before
calling optional operations. Do not cast a files-only session to add an
executor. Registering a second sandbox fails during configuration.

## Exec Options And Results
Exec-capable sessions expose:

```ts
exec(command, {
  cwd,
  env,
  stdin,
  timeoutMs,
  signal
}): Promise<{
  stdout: string
  stderr: string
  exitCode: number
  durationSeconds: number
}>
```

Timeouts throw `OperationTimeoutError` with `scope: 'sandbox_run'`. Aborts throw `OperationCancelledError` with `scope: 'sandbox'`. Bash inherits Harness `toolTimeoutMs`, defaulting to 120 seconds when used directly; an explicit exec timeout cannot exceed the configured wall-clock limit.

## Skills And Memory Mounts
The harness uses the sandbox for two important runtime paths:
- mounted skills: `/skills/<name>/...`
- no sandbox-backed memory default: memory is process-local until an explicit `MemoryEngine` is configured

If an agent needs mounted skill instructions, leave read-only built-ins available:

```ts
builtinTools: ['read', 'list', 'grep']
```

If `builtinTools: false`, the model cannot inspect `/skills/<name>/SKILL.md` unless your own tool or prompt provides the content.

## Built-In Tools And Risk
Built-ins operate against the active sandbox:
- `read`, `list`, `glob`, `grep`: read-only
- `write`, `edit`: mutate sandbox files
- `bash`: executes commands when executor is available

Security defaults:
- use `inMemorySandbox()` for file-only agents
- disable all built-ins for tool-only agents with `builtinTools: false`
- enable only read-only built-ins for skill-reading agents
- add permission policies for `bash`, `write`, and `edit`
- use `bashSandbox()` only for workloads that genuinely need trusted in-process command execution; it cannot run `mcp_stdio`

## Custom Sandbox Adapters
Implement `Sandbox<C>`:

```ts
const remoteSandbox = {
  capabilities: ['sandbox.fs', 'sandbox.exec'] as const,
  configureHarnessContext(context) {
    this.logger = context.logger
    this.telemetry = context.telemetry
  },
  async registerOwner({ owner, mode, signal }) {
    // Create or attach only an application-authorized logical owner.
  },
  async open({ scope, mode, signal }) {
    // `create` allocates, `attach` must find existing state,
    // `restore` requires the adapter's explicit workspace-recovery support.
    return {
      session: remoteSession,
      disposition: mode === 'create' ? 'created' : 'attached',
      liveProcessState: 'not_preserved'
    }
  },
  async terminate({ scope, reason, signal }) {
    // Idempotently destroy only the resources addressed by the opaque scope mapping.
  }
}
```

Harness creates `SandboxScope` from an exact logical owner, an optional
tenant/principal identity, partition, and lifetime (`session` or `run`). Providers
keep generations, leases, fencing and raw resource identifiers private. `attach` and `restore` must raise `SandboxStateLostError`
when the prior logical backing cannot be found; neither may create an empty
replacement. `session.close()` detaches one client, while `terminate(...)`
disposes the shared logical sandbox.

Expose no second multi-instance interface. An adapter may manage one local
process, Docker, or a distributed control plane behind `Sandbox`. Authorize
`registerOwner` and `SandboxAdministration` in the application; exact
offboarding fences an actor without automatically deleting a tenant-owned
resource another actor may use.

Durable workspace checkpoint files are the only cross-restart recovery
guarantee. A retained container, VM, volume or process is an optional
optimization and must be reported truthfully through `liveProcessState`.

Adapter capabilities include:
- `sandbox.fs`
- `sandbox.exec`
- `sandbox.persistent_fs`
- `sandbox.snapshot`
- `sandbox.resume`
- `sandbox.hibernate`
- `sandbox.spawn`
- `sandbox.workspace_binding` (the adapter can bind a run sandbox to an active durable workspace)

Use `.requires([...])` to force startup failure when a required capability is absent.

## Long-Lived Processes (`sandbox.spawn`)
`exec` is one-shot. A sandbox that can host a long-lived process with streaming
stdio declares `sandbox.spawn` and exposes `spawn` on its session:

```ts
spawn(command, { args, cwd, env, signal }): Promise<{
  writeStdin(chunk: string): Promise<void>
  stdout: AsyncIterable<string>
  stderr: AsyncIterable<string>
  exit: Promise<{ exitCode: number; signal?: string }>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>
}>
```

`session.close()` must terminate every spawned process. The in-core
`inMemorySandbox()`/`bashSandbox()` do not advertise `sandbox.spawn`; isolation
backends (Docker/e2b/microvm) do. This capability is required for the MCP
stdio transport: a server is spawned once and multiplexed across calls. There
is no exec-only fallback. Use `isSpawnCapableSession(session)` to detect
support.

## Immutable Package Mounts
Trusted Agent Plugins stdio servers additionally need an immutable package
mount. An isolating adapter implements:

```ts
mountReadOnly(files, atPath, { executablePaths? }): Promise<void>
```

`files` are digest-reviewed package bytes; `executablePaths` retains only the
needed execute bits. The adapter must prevent the spawned process from changing
that mount. A plain host-directory jail, including `localDirectorySandbox()`,
does not provide this guarantee because the owning process can change file
permissions. Use an isolating Docker, microVM, or equivalent adapter for
trusted plugin stdio processes, and keep mutable state in the caller-owned
plugin data directory instead.

## Snapshot And Resume Capabilities
Snapshot-capable adapters may implement:

```ts
snapshot(session): Promise<{ snapshotId: string, metadata?: Record<string, JsonValue> }>
resume({ snapshotId, scope, signal }): Promise<SandboxSessionBase>
hibernate(session): Promise<{ snapshotId: string, metadata?: Record<string, JsonValue> }>
```

Declare matching capabilities so orchestrators and durable runtimes can make safe decisions.
Use the full target `SandboxScope` for snapshot resume. The returned attachment
belongs to that target: its close detaches and target termination invalidates
it. A retry with the same target/snapshot is idempotent; conflicting target state
fails without replacement. Snapshot resume remains separate from lifecycle
restore and is not a substitute for committed `DurableWorkspace` checkpoints.

## Testing
Use `sandboxContract` and `sandboxSnapshotContract` from `@purista/harness/testing` for adapter behavior. Cover filesystem semantics, executor unavailable behavior, timeouts, cancellation, mount behavior, one-client detach, concurrent idempotent create, terminal tombstones, exact tenant/principal scope, absent attach/restore state loss, and old-attachment invalidation. Add isolated provider tests for engine/context pinning, cleanup retry, resource limits, egress policy, and telemetry that excludes file/command content.
