# Sandbox

The Sandbox port abstracts an isolated filesystem and shell execution backend. v1 ships an in-memory file system and a `just-bash`-backed bash emulator (https://github.com/vercel-labs/just-bash). Future adapters will provide Docker, microVM, and cloud-sandbox isolation behind the same port.

## Port interface

```ts
interface Sandbox<C extends readonly AdapterCapability[] = readonly AdapterCapability[]> {
  readonly capabilities?: C
  configureHarnessContext?(context: HarnessAdapterContext): void
  open(opts: { sessionId: string; runId: string; signal?: AbortSignal }): Promise<SandboxSessionFor<C>>
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
  close(): Promise<void>
}

interface ExecCapableSandboxSession extends SandboxSessionBase {
  readonly executor: 'available'
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
}

type SandboxSessionFor<C extends readonly AdapterCapability[]> =
  'sandbox.exec' extends C[number]
    ? ExecCapableSandboxSession
    : SandboxSessionBase & { readonly executor: 'unavailable' }

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
   - `network?: { allow?: string[]; deny?: string[] }` — default deny all. Maps to just-bash network config.
   - `executionLimits?: { wallClockMs?: number; memoryMb?: number }` — passed through to just-bash.
   - `python?: false` (default) | `true` — enable just-bash python3 builtin if peer dep allows.

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
  sessionId: string
  runId: string
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
support. Production durable replay requires a `DurableWorkspaceStore` and the
`workspace.*` capabilities defined in [21-durable-workspaces](./21-durable-workspaces.md).

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
  `sandbox.spawn` fall back to the one-shot `exec` stdio model.
- The in-core `inMemorySandbox()` and `bashSandbox()` do **not** advertise
  `sandbox.spawn`; isolation adapters (`@purista/harness-sandbox-docker`,
  `-e2b`, `-microvm`) implement it. `@purista/harness/testing` ships a
  spawn-capable reference session for contract tests.

### Auto-detect

If the user calls `.sandbox()` with no argument or omits `.sandbox()` entirely, the harness auto-detects: tries `bashSandbox()` first, falls back to `inMemorySandbox()` on import failure. This auto-detect is locked in [02-harness-config](./02-harness-config.md) §`.sandbox(...)`.

## Adapters

Packages like `@purista/harness-sandbox-docker`, `@purista/harness-sandbox-e2b`, and `@purista/harness-sandbox-microvm` implement the same capability-declared `Sandbox` port.

## Cross-references

- [08-skills](./08-skills.md) — skill mount paths.
- [07-tools](./07-tools.md) — built-in tools layer over the Sandbox.
- [09-agents](./09-agents.md) — agent loop mounts skills at session start.
- [13-public-api](./13-public-api.md) — exported types.
- [21-durable-workspaces](./21-durable-workspaces.md) — production durable workspace replay.
