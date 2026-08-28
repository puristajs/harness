# Sandbox

Approved follow-up: [spec 36](./36-sandbox-ownership-and-administration/00-vision.md)
replaces the scope, owner registration, sharing and administration parts of the
interface below. Its [precedence map](./36-sandbox-ownership-and-administration/04-delivery.md#precedence)
is authoritative for the new implementation plan. The existing implementation
and spec-34 provider gate remain as documented until that plan is executed; no
legacy/compatibility interface is planned.

The Sandbox port abstracts a logical filesystem and optional command execution. v3 ships an in-memory filesystem, a `just-bash`-backed emulator (https://github.com/vercel-labs/just-bash), and the optional `@purista/harness-sandbox-docker` package. Remote or microVM adapters use the same port; deployment isolation guarantees belong to each adapter.

## Port interface

```ts
interface Sandbox<C extends readonly AdapterCapability[] = readonly AdapterCapability[]> {
  readonly capabilities?: C
  configureHarnessContext?(context: HarnessAdapterContext): void
  open(options: SandboxOpenOptions): Promise<SandboxOpenResult<C>>
  terminate(options: SandboxTerminateOptions): Promise<void>
}

interface SandboxSessionBase {
  read(path: string): Promise<Uint8Array>
  readText(path: string, encoding?: 'utf-8'): Promise<string>
  write(path: string, data: Uint8Array | string): Promise<void>
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>
  list(path: string, opts?: { recursive?: boolean; glob?: string }): Promise<DirEntry[]>
  stat(path: string): Promise<FileStat>
  exists(path: string): Promise<boolean>
  mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void>
  readonly executor: 'available' | 'unavailable'
  /** Detaches this client/session without terminating the logical sandbox. */
  close(): Promise<void>
}

interface ExecCapableSandboxSession extends SandboxSessionBase {
  readonly executor: 'available'
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
}

// SandboxSessionFor<C> exposes exec and spawn only when a precise capability
// tuple guarantees the corresponding operation. Widened arrays expose the
// base filesystem session and require a runtime capability guard.

interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
  signal?: AbortSignal
}
interface ExecResult { stdout: string; stderr: string; exitCode: number; durationSeconds: number }
interface DirEntry { name: string; path: string; kind: 'file' | 'directory'; size?: number }
interface FileStat { kind: 'file' | 'directory'; size: number; modifiedAt: string }
```

Sandbox adapters may implement `configureHarnessContext(...)` to inherit the
harness logger, telemetry shim, and defaults. Users configure these once on the
harness, not separately on every sandbox adapter.

## Locked behaviors

- **Capabilities are policy.** Each sandbox declares the behavior the harness and user code may rely on. `inMemorySandbox()` exposes no `exec` method on its precise session type because it declares only `sandbox.fs`. `bashSandbox()` declares `sandbox.exec` and opens sessions with `exec`.
- **Cascaded inference.** Register `.sandbox(adapter)` before `.tools(...)`; tool-handler `ctx.sandbox` inherits its precise capability tuple, including `spawn` when declared. Subsequent builder calls and `.use(module)` preserve the tuple. Auto-detection and widened capability arrays expose only guaranteed base operations; narrow with `isExecCapableSession` or `isSpawnCapableSession` before executing. A union entry such as `'sandbox.exec' | 'sandbox.spawn'` guarantees neither operation. Duplicate sandbox registration fails during configuration.
- **Path semantics.** All paths are POSIX style, absolute (must start with `/`). Implementations validate and normalize. Relative paths throw `SandboxError{reason:'invalid_path'}`.
- **Reserved paths inside the sandbox** (locked, conventions enforced by the harness, not the backend):
  - `/skills/<id>/...` — skill mounts; read-only by convention.
  - `/memory/session/<key>.json` and `/memory/runs/<runId>/<key>.json` — default `sandboxMemory()` adapter files.
  - `/workspace/` — free model scratch; default `cwd` for `exec`.
- **Timeouts.** `exec` honors `opts.timeoutMs` (default `defaults.toolTimeoutMs`); on timeout throws `OperationTimeoutError{scope:'sandbox_run'}`.
- **`executor === 'unavailable'`.** Indicates this sandbox session has no shell executor. Precise files-only session types do not expose `exec`; dynamically widened sessions that still call `exec` fail with `SandboxNoExecutorError`. The built-in tool registry checks this and disables `bash` automatically; see [07-tools](./07-tools.md) §"Built-in tools".

## Default sandbox

The harness ships **two** default sandbox factories in core. Both are exported from `@purista/harness`.

1. `inMemorySandbox()` — files-only, declares `['sandbox.fs']`, opens `executor: 'unavailable'` sessions. Pure TS, no peer deps. `read`/`write`/`list`/`stat`/`mount` work.
2. `bashSandbox(opts?)` — wraps the `just-bash` peer dep, declares `['sandbox.fs','sandbox.exec']`. Full bash emulator + in-memory POSIX FS. `executor: 'available'`. Optional `opts`:
   - `network?: { allow?: readonly string[] }` — default deny all; explicit values are reviewed URL prefixes permitted by the emulator.
   - `executionLimits?: { wallClockMs?: number; maxFileSystemBytes?: number }` — positive integer execution-duration and in-memory filesystem byte limits. `maxFileSystemBytes` is not a host-memory quota.
   - `python?: false` (default) | `true` — enable just-bash python3 builtin if peer dep allows.

`BashSandboxOptions` is exported. Configuration rejects unknown fields and
invalid limits instead of silently ignoring them. File APIs, skill mounts, and
commands share the same emulator filesystem. Exec uses the Harness
`toolTimeoutMs` default (120 seconds when used directly); an explicit
`timeoutMs` overrides that default without exceeding configured `wallClockMs`.
Timeouts and cancellations use the canonical Harness errors.

If `just-bash` is not installed and the user calls `bashSandbox()`, throw `HarnessConfigError{reason:'just_bash_not_installed'}` synchronously at construction time.

## Optional sandbox snapshot capabilities

Sandbox adapters may add snapshot/resume methods behind declared capabilities:

```ts
interface SnapshotResult {
  snapshotId: string
  metadata?: Record<string, JsonValue>
}

interface SandboxResumeOptions {
  snapshotId: string
  scope: SandboxScope
  signal?: AbortSignal
}

interface SnapshotCapableSandbox {
  snapshot(session: SandboxSessionBase): Promise<SnapshotResult>
}
interface ResumeCapableSandbox {
  resume(opts: SandboxResumeOptions): Promise<SandboxSessionBase>
}
interface HibernateCapableSandbox {
  hibernate(session: SandboxSessionBase): Promise<SnapshotResult>
}
```

`sandbox.snapshot`, `sandbox.resume`, `sandbox.hibernate`, and `sandbox.persistent_fs` are opt-in adapter capabilities. Harness construction fails early when `.requires(...)` names a capability the configured adapters do not provide.

These capabilities describe low-level sandbox session behavior only. They do
not imply production durable replay, retention, encryption, cleanup, or quota
support. Production durable replay requires a `DurableWorkspace` and the
`workspace.*` capabilities defined in [21-durable-workspaces](./21-durable-workspaces.md).

Optional snapshot resume names the complete target `SandboxScope`, never a
session/run pair lacking identity and incarnation. The resumed attachment
belongs to that target's normal lifecycle: attach retains its files, close
detaches, and target termination invalidates it. Resuming the same snapshot
into the same allocated target is idempotent; a conflicting existing target
fails without replacement. A clone into another target does not inherit the
origin's termination authority. Snapshot resume is not lifecycle `restore`
and never grants committed `DurableWorkspace` recovery guarantees.

## Default logical lifecycle

Every `Sandbox` implements the same logical lifecycle. Distributed-safe
adapters are the production norm; built-in process-local adapters implement the
same interface as an explicit development/test edge case.

```ts
type SandboxScope = {
  readonly harnessName: string
  readonly sessionId: string
  readonly sessionInstanceId: string
  readonly identity?: HarnessIdentity
} & (
  | { readonly lifetime: 'session'; readonly runId?: never; readonly role: 'primary' }
  | { readonly lifetime: 'run'; readonly runId: string; readonly role: 'primary' | 'child_task' }
)

type SandboxOpenMode =
  | 'create'
  | 'attach'
  | 'restore'

interface SandboxOpenOptions {
  readonly scope: SandboxScope
  readonly mode: SandboxOpenMode
  readonly signal?: AbortSignal
}

interface SandboxOpenResult<C extends readonly AdapterCapability[]> {
  readonly session: SandboxSessionFor<C>
  readonly disposition: 'created' | 'attached' | 'resumed' | 'restored'
  readonly liveProcessState:
    | 'preserved'
    | 'restarted'
    | 'not_preserved'
    | 'unknown'
}

interface SandboxTerminateOptions {
  readonly scope: SandboxScope
  readonly reason:
    | 'session_closed'
    | 'run_disposed'
    | 'manual'
  readonly signal?: AbortSignal
}
```

Harness constructs the scope from the persisted, already-validated session/run
context. `sessionInstanceId` is copied from the opaque `SessionRecord.instanceId`, so a new
session record is distinct even when its caller-facing id is reused. Session
lifetime forbids `runId`; run lifetime requires it. Optional identity is exact:
presence and values both participate in the scope, and Harness never invents
tenant or principal values.

The adapter owns its logical directory, generations, opaque provider
references, retention, and cleanup. Distributed adapters also own shared
leases/fencing or an equivalent control-plane guarantee. Those values are not
public contract fields and are not stored in `HarnessStorage`.

Sandbox topology is adapter-private. Harness and PURISTA use the same lifecycle
without detecting or branching on local, single-host, remote, or distributed
operation. A production adapter coordinates independently constructed clients
and rejects stale mutations at its provider/control-plane boundary. Built-in
local adapters keep the same semantics within their documented process or host
authority. Adapter selection for a deployment belongs to the composition root,
not to agent, workflow, service, or Harness business logic.

`create` is allowed only for a newly allocated session/run scope and is
idempotent when concurrent clients create that same scope. `attach` is used for
an existing persisted scope and never creates when adapter state or provider
compute is missing. Harness may use `restore` only for a run after the latest
committed `DurableWorkspace` checkpoint has been resumed and the run sandbox is
bound to it. A missing sandbox otherwise throws `SandboxStateLostError`; it is
never replaced with empty state. This keeps a volatile local adapter paired
with durable Harness storage fail-closed after process loss. See
[34-distributed-sandbox-lifecycle](./34-distributed-sandbox-lifecycle/00-vision.md).

`SandboxSession.close()` and `Session.release()` detach without terminating
logical compute.
`Session.close()` asks the adapter to accept termination before deleting the
session record. Harness shutdown detaches and closes clients; it does not
terminate retained logical sandboxes. Adapter configuration owns lifecycle
timeouts, hibernation, retention, cleanup retry, and orphan reclamation.

`sandbox.live_process_preservation` separately declares that provider-managed
background processes may survive detach or supported hibernation.
Attachment-owned `SandboxProcess` objects and stream handles never survive
attachment loss. Existing `sandbox.snapshot`, `sandbox.resume`, and
`sandbox.hibernate` retain their current semantics.

## Optional long-lived process capability

`exec` is a one-shot request/response: it sends optional `stdin`, waits for the
command to exit, and returns the captured `stdout`/`stderr`/`exitCode`. It cannot
keep a process alive or stream incrementally. A sandbox that can host a
**long-lived process with streaming stdin/stdout** declares the `sandbox.spawn`
capability and exposes a `spawn` method on its session:

```ts
interface SpawnOptions {
  args?: readonly string[]
  cwd?: string
  env?: Record<string, string>
  signal?: AbortSignal
}

interface SandboxProcess {
  /** Writes a chunk to the process stdin. */
  writeStdin(chunk: string): Promise<void>
  /** Async iterator over decoded stdout chunks. Completes when the process exits. */
  readonly stdout: AsyncIterable<string>
  /** Async iterator over decoded stderr chunks. Completes when the process exits. */
  readonly stderr: AsyncIterable<string>
  /** Resolves with the exit code when the process terminates. Never rejects. */
  readonly exit: Promise<{ exitCode: number; signal?: string }>
  /** Terminates the process. Idempotent. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>
}

interface SpawnCapableSandboxSession extends SandboxSessionBase {
  readonly executor: 'available'
  spawn(command: string, opts?: SpawnOptions): Promise<SandboxProcess>
}
```

Locked behavior:

- `sandbox.spawn` is an opt-in adapter capability gated by `.requires(...)` like
  the snapshot capabilities. A session that advertises `sandbox.spawn` exposes
  `spawn`; sessions without it expose only `exec` (or no executor).
- A spawned process is owned by the sandbox session. `session.close()` MUST
  terminate every process the session spawned. The host process is never the
  spawn parent for an isolation backend — `spawn` runs inside the same isolation
  boundary as `exec`.
- `signal` abort terminates the process and completes the `stdout`/`stderr`
  iterators.
- This capability is the basis for the **persistent MCP stdio transport** in
  [07-tools](./07-tools.md): a stateful stdio MCP server is spawned once and
  multiplexed across calls instead of re-spawned per call. Sandboxes without
  `sandbox.spawn` cannot host MCP stdio; there is no exec-only fallback.
- The in-core `inMemorySandbox()` and `bashSandbox()` do **not** advertise
  `sandbox.spawn`; isolation adapters (`@purista/harness-sandbox-docker`,
  `-e2b`, `-microvm`) implement it. `@purista/harness/testing` ships a
  spawn-capable reference session for contract tests.

## Prepared MCP launch capability

An addon may need to stage reviewed, immutable executable assets plus a
dedicated writable data directory before an existing MCP stdio runner starts.
Core exposes a provider-neutral prepared-launch contract for this purpose. It
is owned by the MCP runner/session, does not expose host process spawning, and
does not identify any package format. The returned command, args, cwd, and env
are still started exclusively by `exec`/`spawn` inside the current sandbox.

The contract validates no application policy itself: callers must provide an
already-validated source and core continues to enforce tool timeout,
cancellation, process cleanup, and session close. A files-only sandbox rejects
preparation for executable use. A compatible sandbox preserves the prepared
read-only root and writable data mapping for the owning session only. See
[29-agent-plugins](./29-agent-plugins.md) for the first consumer and its
Windows/Linux containment requirements.

### Auto-detect

If the user calls `.sandbox()` with no argument or omits `.sandbox()` entirely, the harness auto-detects: tries `bashSandbox()` first and falls back to `inMemorySandbox()` only when the optional peer is absent. Configuration or initialization failures surface normally. Auto-detection does not promise an executor to TypeScript. This auto-detect is locked in [02-harness-config](./02-harness-config.md) §`.sandbox(...)`.

## Local durable sandbox

`localDirectorySandbox(...)` is a first-party host-directory sandbox used by
`localDurableExecution(...)`; see
[22-local-durable-execution](./22-local-durable-execution.md). It maps virtual
`/workspace` to the active durable workspace directory selected for the current
run. It is a persistence adapter, not a Docker/microVM security boundary.

Rules:

- Filesystem access is jailed by path normalization plus realpath checks.
- Symlink escapes, relative paths, and host paths outside the configured root
  throw `SandboxError{meta.reason:'invalid_path'}`.
- It advertises `sandbox.fs`, `sandbox.persistent_fs`, and
  `sandbox.workspace_binding` because it can bind a run scope to the active
  local durable workspace.
- It advertises `sandbox.exec` and `sandbox.spawn` only when host exec is explicitly enabled.
- Host exec is disabled by default and must be documented as a trust decision.

## Adapters

Optional adapter packages implement the same capability-declared `Sandbox`
port. `@purista/harness-sandbox-docker` is the opt-in local Docker/OrbStack
addon; it is never auto-selected by core. Its configuration, local persistence limits, and
release requirements are defined in
[local Docker](./34-distributed-sandbox-lifecycle/05-integration/local-docker.md).
Production E2B/Daytona adapter selection remains behind the spec-34 bake-off.

## Cross-references

- [08-skills](./08-skills.md) — skill mount paths.
- [07-tools](./07-tools.md) — built-in tools layer over the Sandbox.
- [09-agents](./09-agents.md) — agent loop mounts skills at session start.
- [13-public-api](./13-public-api.md) — exported types.
- [21-durable-workspaces](./21-durable-workspaces.md) — production durable workspace replay.
