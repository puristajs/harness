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

## Optional durable sandbox capabilities

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

### Auto-detect

If the user calls `.sandbox()` with no argument or omits `.sandbox()` entirely, the harness auto-detects: tries `bashSandbox()` first, falls back to `inMemorySandbox()` on import failure. This auto-detect is locked in [02-harness-config](./02-harness-config.md) §`.sandbox(...)`.

## Adapters

Packages like `@purista/harness-sandbox-docker`, `@purista/harness-sandbox-e2b`, and `@purista/harness-sandbox-microvm` implement the same capability-declared `Sandbox` port.

## Cross-references

- [08-skills](./08-skills.md) — skill mount paths.
- [07-tools](./07-tools.md) — built-in tools layer over the Sandbox.
- [09-agents](./09-agents.md) — agent loop mounts skills at session start.
- [13-public-api](./13-public-api.md) — exported types.
