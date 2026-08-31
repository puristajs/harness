# Agent Plugins integration

**Status:** approved implementation scope. This specification defines the
first-party `@purista/harness-agent-plugins` package and the narrowly-scoped
core MCP-runtime additions it requires. It implements the portable Agent
Plugins 1.0.0 format as a client; it is not a TypeScript module system.

## Purpose and boundaries

Agent Plugins are external package directories containing a required
`plugin.json` plus zero or more Agent Skills (`skills/*/SKILL.md`) and MCP
servers (`mcp.json`). The format is currently a working draft, but version
`1.0.0` and its canonical schema identifiers are the supported compatibility
target. The package supports local, already-installed plugin roots only. It
does not download, install, update, publish, sign, or discover marketplace
plugins.

`@purista/harness-agent-plugins` SHALL:

1. inspect, locally validate, and inventory a plugin without executing it;
2. import approved skill directories through the existing harness skill loader;
3. project explicitly selected MCP tools into ordinary typed harness tool
   definitions;
4. preserve existing sandbox, permission, governance, cancellation, timeout,
   lifecycle, and telemetry behavior; and
5. provide machine-readable, content-free diagnostics and provenance.

It SHALL NOT load plugin JavaScript/TypeScript, invoke hooks, construct agents
or workflows, read plugin-defined credentials, use plugin extensions, relax
tool allowlists, auto-expose every server tool, or treat a manifest as a trust
assertion. `HarnessModule` remains for trusted application imports only; it
MUST NOT be used as the plugin loader or as a way to evaluate plugin code.

The package is a maintained first-party addon, so users receive support by
installing it alongside the core package. It remains opt-in: applications that
do not use Agent Plugins do not parse plugin manifests, create plugin data, or
gain third-party executable behavior.

## Package and dependency contract

The workspace adds `packages/harness-agent-plugins/`, published as
`@purista/harness-agent-plugins`. It is ESM-only and depends only on the public
`@purista/harness` surface plus local JSON/YAML/schema utilities required for
format validation. It MUST NOT import harness internals or a provider/addon
package. The core package MUST NOT depend on this addon.

The Agent Plugins package owns format parsing, path containment, trust/lock
evaluation, component diagnostics, and projection. Core owns tool execution,
MCP protocol transport, sandbox lifecycle, governance, telemetry, and normal
tool/skill registries. A core addition is permitted only when it is
provider-neutral and independently useful to the existing MCP runtime; it MUST
not mention Agent Plugins in its public name or behavior.

The package uses the current supported `@modelcontextprotocol/client` v2 release and
the core MCP runtime supports MCP `2026-07-28` Streamable HTTP semantics:

- stateless request/response operation and header-based routing;
- current protocol-version negotiation and server capability discovery;
- cacheable list responses with their advertised TTL; and
- task-augmented `tools/call` when negotiated, mapped to the existing tool
  promise, timeout, abort, and shutdown contract (including `tasks/cancel`).

This is a clean breaking major MCP cut: the harness pins a Tier-1 SDK release
that implements MCP `2026-07-28`, supports neither the legacy stateful
protocol nor legacy HTTP+SSE, and ships no compatibility transport, fallback,
or migration shim. An Agent Plugins `sse` server is reported as unsupported and
skipped. Migration guidance belongs in release notes and the AI Harness skill,
not in runtime code. MCP Apps, sampling, roots, elicitation, and arbitrary
extensions are not enabled by this package. A server-to-client request that the
harness has not explicitly enabled fails that server call safely and does not
grant the server access to prompts, local roots, or user interaction.

## Public API

The addon exports only data-oriented inspection/loading APIs and a binding
factory. Names below are locked; optional fields use omission rather than
`undefined` in returned records.

```ts
type AgentPluginTrust = 'trusted' | 'untrusted'
type AgentPluginTransport = 'stdio' | 'streamable-http'

interface AgentPluginSource {
  root: string
  trust?: AgentPluginTrust
  dataDirectory?: string
  expectedDigest?: string
}

interface ApprovedAgentPluginSource extends AgentPluginSource {
  expectedDigest: string
}

interface AgentPluginLoadOptions {
  plugins: readonly ApprovedAgentPluginSource[]
  trustedRoots?: readonly string[]
  supportedTransports?: readonly AgentPluginTransport[]
  validationMode?: 'strict' | 'lenient'
}

interface AgentPluginToolBinding {
  server: string
  tool: string
  description: string
}

interface AgentPluginBindings {
  skills: SkillsConfig
  tools: ToolsConfig
  diagnostics: readonly AgentPluginDiagnostic[]
  provenance: readonly AgentPluginProvenance[]
}

interface LoadedAgentPlugin {
  inspection: AgentPluginInspection
  bindings(options: {
    skills?: Readonly<Record<string, string>>
    tools?: Readonly<Record<string, AgentPluginToolBinding>>
  }): AgentPluginBindings
}

function inspectAgentPlugin(source: AgentPluginSource): Promise<AgentPluginInspection>
function loadAgentPlugins(options: AgentPluginLoadOptions): Promise<readonly LoadedAgentPlugin[]>
```

`inspectAgentPlugin` is read-only and never starts an MCP server, opens a
network connection, writes a data directory, mounts files, or expands
placeholders. It reports manifest/component validity and `untrusted` inventory
when safe to do so. A malformed/unsupported manifest returns an inspection
with a fatal diagnostic rather than partially usable bindings. `loadAgentPlugins`
performs the same parsing and lock/trust checks and returns no loadable entry
for a rejected plugin. Neither function fetches `$schema` URLs.

`LoadedAgentPlugin.bindings()` is synchronous and pure after loading. It is the
deliberate typed boundary: local aliases are caller-owned literal keys, while
plugin names, server names, and runtime `tools/list` data are untyped external
data. An agent can therefore allowlist normal aliases such as `search_docs`,
not an open-ended plugin server. Unknown selected skill/server/tool names fail
before `defineHarness().build()`. A skill alias maps a caller-owned harness
skill key to a discovered Agent Skills frontmatter name. A tool alias maps one
caller-owned harness tool key to one `(server, upstream tool)` pair.

```ts
const [plugin] = await loadAgentPlugins({
  plugins: [{ root: './plugins/research', trust: 'trusted', expectedDigest: reviewedDigest }]
})
const bindings = plugin.bindings({
  skills: { research_playbook: 'research-playbook' },
  tools: { search_docs: { server: 'knowledge', tool: 'search', description: 'Search approved knowledge.' } }
})

const harness = defineHarness()
  .models(models)
  .skills(bindings.skills)
  .tools(bindings.tools)
  .agent('researcher', {
    model: 'assistant',
    instructions: 'Research only the approved knowledge sources.',
    tools: ['search_docs'],
    skills: ['research_playbook'],
  })
  .build()
```

The addon exports its declared interfaces, diagnostics, provenance records, and
`AgentPluginError` subclasses. It does not re-export all core types; consumers
import `SkillsConfig`, `ToolsConfig`, and `defineHarness` from
`@purista/harness`.

## Portable format and validation

The loader SHALL implement the following Agent Plugins 1.0.0 contract:

- `plugin.json` is a regular file in the resolved plugin root. It contains a
  locally recognized canonical `$schema` and a valid `name`. Invalid required
  fields reject the full plugin. Unknown top-level manifest fields are reported
  and ignored; a non-object `extensions` field is reported and ignored.
- Manifest names permit periods, but harness aliases retain the existing
  `/^[a-z][a-z0-9_]*$/` rule. The package never derives a public harness key
  from a manifest, skill, server, or upstream tool name.
- Component discovery is fixed: immediate `skills/*/SKILL.md` children and
  root `mcp.json`. Missing component locations are valid. A malformed skill
  skips only that skill. An invalid `mcp.json` disables only MCP for that
  plugin. An invalid/unsupported server skips only that server.
- Agent Skills validation and file-limit enforcement reuse the core loader;
  the package adds plugin-root containment before passing a directory to it.
  Skills are mounted and progressively disclosed by core exactly like direct
  `.skills(...)` bindings. Their body, resources, and absolute source path are
  never injected into prompts, logs, events, inspection, or telemetry.
- `mcp.json` is validated against the locally vendored Agent Plugins 1.0.0
  schema and individual server definitions against its local server schema.
  It supports `stdio` and `streamable-http`; legacy `sse` entries are reported
  as unsupported and skipped. An MCP config schema version must equal the
  manifest version.
- The package ships the exact supported JSON schemas as versioned assets and
  validates locally. It never performs a schema network fetch or trusts a
  package-supplied schema file.

Returned inspection/provenance may contain plugin name, declared version,
component names, transport, diagnostic code, and stable SHA-256 digests. It
MUST NOT reveal absolute paths, headers, env values, command arguments, file
content, skill content, tool schemas, credentials, or plugin data paths.

## Filesystem and data semantics

All package file access starts by resolving the plugin root using the host
filesystem. Every manifest, fixed component location, immediate skill child,
plugin-relative command, and plugin-relative working directory is resolved
with real filesystem semantics and must remain under that resolved root.
Symlinks on POSIX, NTFS junctions/reparse points, drive-letter case differences,
and UNC paths on Windows are therefore checked after resolution, not through
string-prefix comparison. Component-specific failures follow the narrow failure
boundaries above. Traversal, a symlink/junction escape, a non-regular manifest,
or a special device is rejected; the loader never follows an escape merely to
produce a diagnostic.

Path configuration accepted by Agent Plugins is portable `/`-separated text;
the loader converts it using the host path implementation only after validating
the required `./` or placeholder prefix. It does not interpret command
arguments or environment values as paths except for the standard `cwd` forms.
It preserves `command` as one token and passes `args` separately. On Windows,
`.cmd`/`.bat` launch is allowed only through the sandbox/runtime's
platform-specific executable mechanism; no shell string concatenation or
`shell: true` is permitted.

Every approved stdio plugin receives an existing application-managed data
directory unique to the installed plugin identity. Its resolved path must not
overlap the resolved plugin root; access is serialized from staging through
synchronization, so two server aliases cannot race a shared durable store. It
is writable only in the plugin runtime boundary, persists across replacements
of the plugin root, and may be deleted only by an explicit application
uninstall operation. The package verifies the data directory itself and its
resolved parents against the configured data root; a plugin cannot choose
another plugin's data path.

Core gains a generic, MCP-only prepared-launch contract so an addon can stage a
read-only package root and writable data directory for the current sandbox
session without reimplementing the MCP runner. The contract returns sandbox
paths and an env overlay only; it cannot replace command validation, alter
agent permissions, access host processes directly, or register shutdown hooks.
Core closes prepared launches with the owning MCP runner/session. The default
in-memory sandbox reports that it cannot execute stdio plugins. A compatible
exec sandbox stages files with the appropriate host-independent path mapping;
host-directory/production sandboxes implement the same contract explicitly.
The built-in local host-directory sandbox deliberately does **not** implement
that contract: POSIX file modes are mutable by the plugin process owner and
therefore are not an immutable package boundary.

For `stdio`, the addon supplies `PLUGIN_ROOT` and `PLUGIN_DATA` itself after
single, non-recursive expansion in `args`, env **values**, and `cwd`. It rejects
plugin env keys equivalent to either reserved name according to platform
environment-name rules (case-insensitive on Windows), then overwrites any
ambient values. `command`, env keys, URLs, headers, and fixed paths never use
placeholder expansion. Omitted `cwd` means the staged plugin root.

## Trust, locking, and network policy

Plugin data is untrusted by default. Explicit `trust: 'trusted'` or an entry
whose resolved root is within a configured `trustedRoots` is necessary before
the addon returns bindings. Trust is an application policy decision; neither
plugin metadata, a digest, a manifest `author`, nor a package location grants
trust. Inspection remains available for review.

Before loading, a trusted plugin's canonical package digest is compared with a
required `expectedDigest`. The digest covers normalized relative file names and
bytes from the plugin root, excludes the client-managed data directory, and
has deterministic cross-platform ordering. A missing, malformed, or mismatched
digest rejects the plugin. Applications own storage/review of a lockfile; this
package exports the digest/provenance needed to implement one and documents a
reference lockfile format. Silent auto-updates are forbidden.

For each stdio server, command/cwd containment, placeholder expansion, launch
capabilities, and package digest are checked before start. The subprocess is
created only through the current sandbox, with the existing timeout,
cancellation, process-death, reconnect, and shutdown protections.

For each HTTP server:

- URL must be absolute HTTP(S), contain no userinfo/fragment, and use HTTPS
  except exact loopback hosts; redirects never forward plugin headers to a new
  origin without an explicit application authorization decision.
- Package headers are static public configuration, not credentials. Duplicate
  case-insensitive names are invalid; credential-bearing, hop-by-hop, and MCP
  protocol headers are rejected case-insensitively. Application-owned
  authorization and MCP protocol headers take precedence, and credentials are
  supplied only through core's existing host-owned MCP auth configuration.
- No portable OAuth, secret-reference, ambient-environment, or header
  interpolation mechanism is implemented. Authorization failure is a server
  connection failure, not a manifest failure.

All selected tools continue through existing per-agent exposure, permissions,
governance/approval, input/output schema validation, tool timeout, run abort,
and session isolation. Plugin identity is available to policy/audit as
content-free provenance but does not bypass any existing decision.

## MCP execution and current protocol behavior

The addon converts a selected portable server to the existing `mcp_stdio` or
`mcp_http` tool definition through the generic prepared-launch bridge. It does
not duplicate MCP JSON-schema validation, dynamic import, runner caching,
output normalization, or shutdown behavior. Upstream `tools/list` discovery
continues to validate the tool selected by the caller before model exposure.

The core MCP runner uses the `2026-07-28` stateless transport only. For
Streamable HTTP it sends required routing/protocol headers and invalidates a
cached catalog on a protocol invalidation/error. MCP Tasks are not exposed by
this release: the runner does not claim task polling, cancellation, or task
result projection semantics. Supporting Tasks requires explicit polling,
abort/shutdown cancellation, and fixtures before it can be claimed. Unsupported
server-to-client requests are returned as safely normalized
`McpProtocolError`/`ToolError` results, never as an automatic user prompt or a
hidden credential flow.

## Diagnostics, errors, inspection, and OpenTelemetry

Diagnostics are stable records with `level`, `code`, plugin name/version when
known, component kind/name when known, and a human-readable message. They use
component-scoped failures such as `manifest_invalid`, `schema_unsupported`,
`path_escape`, `untrusted`, `digest_mismatch`, `skill_invalid`,
`mcp_config_invalid`, `server_invalid`, `transport_unsupported`,
`connection_failed`, and `tool_not_selected`. They do not include sensitive
values. Fatal package errors use `AgentPluginManifestError`,
`AgentPluginTrustError`, or `AgentPluginLoadError`, all extending
`AgentPluginError`; execution errors continue to use the existing core error
catalog.

`AgentPluginProvenance` is attached to every projected skill/tool and includes
only plugin name, declared version when present, package digest, component kind,
component name, and transport when relevant. `harness.inspect()` gains no
runtime plugin scanning; it may report the data-only provenance of already
bound tools/skills through the existing inspection shape.

The addon and core emit the existing skill/tool/MCP spans and metrics, never a
second tracing pipeline. Tool spans add only these content-free attributes when
plugin-derived:

| Attribute | Type | Value |
| --- | --- | --- |
| `harness.plugin.name` | string | manifest name |
| `harness.plugin.version` | string | declared version when present |
| `harness.plugin.digest` | string | package SHA-256 |
| `harness.plugin.component` | string | `skill` or `mcp` |

The addon intentionally creates no inspection/loading spans because inspection
is a standalone data-only package API with no harness telemetry context. Core
tool spans carry the plugin provenance attributes above; no paths, commands,
arguments, environment values, URLs, headers, schemas, prompts, files, tool
inputs/results, or credentials are emitted.

## Testing, examples, release, and documentation

The addon has hermetic fixtures and contract tests covering:

1. exact valid/invalid Agent Plugins 1.0.0 manifest and MCP schema fixtures;
   unknown-field and extension failure boundaries; no schema network fetch;
2. POSIX symlink and Windows junction/drive/UNC containment behavior through
   a filesystem abstraction or platform-gated native fixture;
3. malformed/missing components and per-skill/per-server isolation;
4. trust defaults, trusted roots, digest mismatch, deterministic digest, and
   lockfile review flow;
5. mounted plugin skills and unchanged progressive disclosure/privacy;
6. caller-owned aliases, type-level allowlists, duplicate/collision rejection,
   and no automatic tool exposure;
7. stdio placeholder/reserved-env/cwd rules, persistent data across update,
   sandbox-only launch, close/cancellation/process-death behavior; and
8. HTTP URL/header/redirect/auth policy plus stdio and Streamable HTTP
   `2026-07-28` stateless fixtures. Tasks remain explicitly unsupported.

Core MCP contract tests must run against the pinned current MCP SDK without an
external server. They reject legacy protocol/transport configuration and verify
the current protocol features above. Existing non-plugin MCP, skills, static modules, telemetry,
governance, durable workspace, session shutdown, and no-content tests remain
unchanged and must stay green.

Add a private `examples/agent-plugins/` workspace using fake/local fixture
plugins: a skills-only plugin, a streamable-HTTP plugin, and a reviewed stdio
plugin. It demonstrates inspection, a trust/digest decision, explicit alias
binding, per-agent allowlists, graceful component diagnostics, and shutdown.
It must not require network access, real credentials, or a host shell outside
the configured sandbox.

The package README, root README, handbook, public API reference, AI Harness
skill, release workflow, package-content verification, Dependabot workspace
coverage, and versioning/release notes SHALL be updated in the implementation
wave. Documentation must distinguish Agent Plugins from static modules, explain
the trust review and explicit tool selection, list supported transports/MCP
version behavior, and state that UI-specific MCP Apps and plugin extensions are
not enabled by the library.

## Acceptance

The feature is ready only when the package contents publish cleanly with the
core release workflow, documented APIs/types match generated declarations, the
new example is hermetic in CI, all stated contract suites pass on Linux and
Windows, and the Agent Plugins client conformance checklist is recorded against
the exact supported component/transport set. The project may claim
“Agent Plugins compatible” only for the tested Agent Plugins 1.0.0 scope and
must disclose unsupported optional transports/features.

## Cross-references

- [Agent Plugins Specification 1.0.0](https://agent-plugins.org/specification)
  — portable package and client conformance requirements.
- [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
  — required current protocol baseline.
- [01-architecture](./01-architecture.md) — addon boundary and dependency direction.
- [05-sandbox](./05-sandbox.md) — sandbox execution/staging contract.
- [07-tools](./07-tools.md) — MCP execution, validation, cancellation, and shutdown.
- [08-skills](./08-skills.md) — Agent Skills loading and progressive disclosure.
- [13-public-api](./13-public-api.md) — published addon surface.
- [14-otel-conventions](./14-otel-conventions.md) — canonical telemetry names.
- [15-error-catalog](./15-error-catalog.md) — core execution errors.
- [16-testing](./16-testing.md) — fixtures and CI gates.
- [25-static-harness-modules](./25-static-harness-modules.md) — trusted module boundary.
