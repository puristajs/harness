# Agent Plugins integration

> **V4 composition:** an Agent Plugin is inspected as untrusted package data and
> explicitly projected into the immutable Skill and MCP definition contracts in
> [42-composable-definitions-and-catalogs](./42-composable-definitions-and-catalogs.md).

**Status:** approved implementation scope. This specification defines the
first-party `@purista/harness-agent-plugins` package as a client for the
portable Agent Plugins 1.0.0 format. It is a clean v4 API; a plugin is not a
TypeScript module and cannot contribute executable application code.

## 1. Scope and ownership

Agent Plugins are already-installed local directories containing a required
`plugin.json`, zero or more immediate `skills/*/SKILL.md` packages, and an
optional root `mcp.json`.

`@purista/harness-agent-plugins` SHALL:

1. inspect, validate, digest, and inventory a local plugin without executing it;
2. load only application-trusted, digest-pinned plugin roots;
3. project explicitly selected Skills through `defineSkill`;
4. project explicitly selected Streamable HTTP MCP servers and tools through
   `defineMcpServer` plus exact HTTP `McpBinding` records; and
5. return content-free diagnostics and separate provenance records.

It SHALL NOT download, install, update, publish, discover, or sign plugins;
load plugin JavaScript or TypeScript; invoke hooks; construct agents,
workflows, Harnesses, or runtime instances; discover credentials; interpret
`extensions`; or grant capabilities from manifest contents. Applications that
do not call this addon perform no plugin work and gain no plugin-provided
behavior.

The addon depends only on the public `@purista/harness` API and local
JSON/YAML/schema utilities. It MUST NOT import Harness internals or provider
packages, and core MUST NOT depend on this addon. The addon owns portable-format
parsing, path containment, trust/digest checks, selection validation, and the
mapping to public v4 factories. Core owns definition identity, graph
compilation, Skill loading and mounting, MCP clients and transports, runtime
discovery, schema comparison, policy and approval, cancellation, telemetry,
and shutdown. The MCP client dependency belongs to core; this addon does not
instantiate or depend on an MCP client.

This addon's implementation ticket changes source, tests, examples, and public
exports while package versions, Harness dependency ranges, and the workspace
lockfile remain on the aligned 3.0.0 release. Spec 42 H4-020 performs the one
atomic 4.0.0 version/range/lockfile flip for Core and every first-party addon.
This package is not published as an independent v4 artifact before that gate.

## 2. Public API

The package exports the constants for the supported manifest and MCP schema
identifiers, the types below, `inspectAgentPluginSync`,
`inspectAgentPlugin`, `loadAgentPlugins`, and the three error subclasses in
section 8. Optional fields are omitted, rather than returned with `undefined`.

```ts
import type {
  McpBinding,
  McpToolOptions,
  ModelSchema,
  Schema,
  SkillRuntimeId,
} from '@purista/harness'
import { defineMcpServer, defineSkill } from '@purista/harness'

export const AGENT_PLUGIN_MANIFEST_SCHEMA:
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
export const AGENT_PLUGIN_MCP_SCHEMA:
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
export const AGENT_PLUGIN_DEFAULT_MAX_FILE_BYTES: 2_097_152
export const AGENT_PLUGIN_DEFAULT_MAX_PACKAGE_BYTES: 104_857_600
export const AGENT_PLUGIN_MAX_FILE_BYTES: 16_777_216
export const AGENT_PLUGIN_MAX_PACKAGE_BYTES: 536_870_912
export const AGENT_PLUGIN_MAX_ENTRIES: 20_000
export const AGENT_PLUGIN_MAX_DEPTH: 64
export const AGENT_PLUGIN_MAX_PATH_BYTES: 1_024

export type AgentPluginTrust = 'trusted' | 'untrusted'
export type AgentPluginTransport = 'stdio' | 'streamable-http'

export interface AgentPluginSource {
  readonly root: string
  readonly trust?: AgentPluginTrust
  readonly expectedDigest?: string
}

export interface ApprovedAgentPluginSource extends AgentPluginSource {
  readonly expectedDigest: string
}

export interface InspectAgentPluginOptions {
  readonly maxFileBytes?: number       // default 2 MiB
  readonly maxPackageBytes?: number    // default 100 MiB
}

export interface AgentPluginLoadOptions extends InspectAgentPluginOptions {
  readonly plugins: readonly [
    ApprovedAgentPluginSource,
    ...ApprovedAgentPluginSource[],
  ]
  readonly trustedRoots?: readonly string[]
}

export interface AgentPluginAuthor {
  readonly name?: string
  readonly email?: string
  readonly url?: string
}

export interface AgentPluginManifestSummary {
  readonly $schema: typeof AGENT_PLUGIN_MANIFEST_SCHEMA
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly author?: AgentPluginAuthor
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords?: readonly string[]
}

export interface AgentPluginSkill {
  readonly name: string
  readonly description: string
}

export type AgentPluginMcpServerSummary =
  | Readonly<{
      name: string
      transport: 'streamable-http'
      supported: true
    }>
  | Readonly<{
      name: string
      transport: 'stdio'
      supported: false
    }>

export type AgentPluginDiagnosticCode =
  | 'plugin_root_invalid'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'manifest_unknown_field'
  | 'manifest_extensions_ignored'
  | 'schema_unsupported'
  | 'path_escape'
  | 'untrusted'
  | 'digest_invalid'
  | 'digest_mismatch'
  | 'package_too_large'
  | 'component_invalid'
  | 'skill_invalid'
  | 'skill_duplicate'
  | 'mcp_config_invalid'
  | 'transport_unsupported'
  | 'server_invalid'

export interface AgentPluginDiagnostic {
  readonly level: 'warn' | 'error'
  readonly code: AgentPluginDiagnosticCode
  readonly message: string
  readonly pluginName?: string
  readonly component?: 'skills' | 'mcp'
  readonly item?: string
}

export interface AgentPluginInspection {
  readonly valid: boolean
  readonly manifest?: AgentPluginManifestSummary
  readonly trust: AgentPluginTrust
  readonly digest?: string
  readonly skills: readonly AgentPluginSkill[]
  readonly mcpServers: readonly AgentPluginMcpServerSummary[]
  readonly diagnostics: readonly AgentPluginDiagnostic[]
}

export interface AgentPluginSkillSelection<
  Runtimes extends readonly SkillRuntimeId[] = readonly SkillRuntimeId[],
> {
  readonly runtimes: Runtimes
}

export type AgentPluginSkillSelections = Readonly<
  Record<string, AgentPluginSkillSelection>
>

export interface AgentPluginHttpMcpServerSelection<
  Tools extends Readonly<
    Record<string, McpToolOptions<ModelSchema, Schema>>
  > = Readonly<Record<string, McpToolOptions<ModelSchema, Schema>>>,
> {
  /** Exact server name from the portable mcp.json inventory. */
  readonly server: string
  /** Caller-owned local tool ids, descriptions, remote names, and schemas. */
  readonly tools: Tools
  /** Caller-owned runtime headers, including credentials and explicit overrides. */
  readonly headers?: Readonly<Record<string, string>>
}

export type AgentPluginHttpMcpServerSelections = Readonly<
  Record<string, AgentPluginHttpMcpServerSelection>
>

export type ProjectedAgentPluginSkills<
  Skills extends AgentPluginSkillSelections,
> = Readonly<{
  [Id in keyof Skills & string]: ReturnType<
    typeof defineSkill<Id, Skills[Id]['runtimes']>
  >
}>

export type ProjectedAgentPluginMcpServers<
  Servers extends AgentPluginHttpMcpServerSelections,
> = Readonly<{
  [Id in keyof Servers & string]: ReturnType<
    typeof defineMcpServer<Id, Servers[Id]['tools']>
  >
}>

export type AgentPluginHttpMcpBinding = Extract<McpBinding, { transport: 'http' }>

export type ProjectedAgentPluginMcpBindings<
  Servers extends AgentPluginHttpMcpServerSelections,
> = Readonly<{
  [Id in keyof Servers & string]: AgentPluginHttpMcpBinding
}>

export interface AgentPluginComponentProvenance {
  readonly pluginName: string
  readonly version?: string
  readonly digest: string
}

export type AgentPluginBindingProvenance<
  Skills extends AgentPluginSkillSelections,
  Servers extends AgentPluginHttpMcpServerSelections,
> = Readonly<{
  skills: Readonly<{
    [Id in keyof Skills & string]: AgentPluginComponentProvenance & Readonly<{
      component: 'skill'
      skillId: Id
    }>
  }>
  mcpServers: Readonly<{
    [Id in keyof Servers & string]: AgentPluginComponentProvenance & Readonly<{
      component: 'mcp-server'
      localServerId: Id
      pluginServerName: Servers[Id]['server']
      tools: Readonly<{
        [ToolId in keyof Servers[Id]['tools'] & string]:
          AgentPluginComponentProvenance & Readonly<{
            component: 'mcp-tool'
            localToolId: ToolId
            remoteName: Servers[Id]['tools'][ToolId]['remoteName']
          }>
      }>
    }>
  }>
}>

export interface AgentPluginBindings<
  Skills extends AgentPluginSkillSelections,
  Servers extends AgentPluginHttpMcpServerSelections,
> {
  readonly skills: ProjectedAgentPluginSkills<Skills>
  readonly mcpServers: ProjectedAgentPluginMcpServers<Servers>
  readonly mcp: ProjectedAgentPluginMcpBindings<Servers>
  readonly provenance: AgentPluginBindingProvenance<Skills, Servers>
}

export interface LoadedAgentPlugin {
  readonly inspection: AgentPluginInspection
  bindings<
    const Skills extends AgentPluginSkillSelections,
    const Servers extends AgentPluginHttpMcpServerSelections,
  >(options: Readonly<{
    skills: Skills
    mcpServers: Servers
  }>): AgentPluginBindings<Skills, Servers>
}

export declare function inspectAgentPluginSync(
  source: AgentPluginSource,
  options?: InspectAgentPluginOptions,
): AgentPluginInspection

export declare function inspectAgentPlugin(
  source: AgentPluginSource,
  options?: InspectAgentPluginOptions,
): Promise<AgentPluginInspection>

export declare function loadAgentPlugins(
  options: AgentPluginLoadOptions,
): Promise<readonly [LoadedAgentPlugin, ...LoadedAgentPlugin[]]>

export type AgentPluginLoadErrorReason =
  | 'skill_not_found'
  | 'mcp_server_not_found'
  | 'transport_unsupported'
  | 'duplicate_selection'
  | 'invalid_selection'
  | 'invalid_http_headers'

export type AgentPluginManifestErrorReason =
  | 'plugin_root_invalid'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'schema_unsupported'
  | 'package_too_large'

export type AgentPluginTrustErrorReason =
  | 'untrusted'
  | 'digest_invalid'
  | 'digest_mismatch'

export declare class AgentPluginError extends Error {}
export declare class AgentPluginManifestError extends AgentPluginError {
  constructor(reason: AgentPluginManifestErrorReason)
  readonly reason: AgentPluginManifestErrorReason
}
export declare class AgentPluginTrustError extends AgentPluginError {
  constructor(reason: AgentPluginTrustErrorReason)
  readonly reason: AgentPluginTrustErrorReason
}
export declare class AgentPluginLoadError extends AgentPluginError {
  constructor(reason: AgentPluginLoadErrorReason)
  readonly reason: AgentPluginLoadErrorReason
}
```

The mapped return types above are normative. The implementation MUST call the
public `defineSkill` and `defineMcpServer` factories and return their actual
frozen, identity-bearing values. It MUST NOT reproduce their visible shapes,
cast unbranded objects into their types, or attach addon fields to core
definitions or runtime bindings.

Both selection maps are required, including when empty. Their literal keys are
preserved exactly in the corresponding return maps. The addon does not merge
bindings from multiple loaded plugins; the application composes each result
into its own definition graph and resolves cross-plugin id collisions there.

## 3. Inspection and portable-format validation

Inspection is read-only. It starts no process, opens no network connection,
writes no file, expands no placeholder, and creates no core definition or
runtime binding. For the same bytes and options, the synchronous and
asynchronous functions return deeply equal frozen values; object identity is
not promised. The asynchronous form is a convenience for callers with async
setup.

The following format rules are required:

- `plugin.json` must be a regular file at the resolved plugin root and use the
  locally recognized Agent Plugins 1.0.0 schema identifier. Invalid required
  fields invalidate the plugin. Unknown top-level fields are diagnosed and
  ignored; an invalid `extensions` member is diagnosed and ignored.
- Discovery is limited to immediate `skills/*/SKILL.md` children and root
  `mcp.json`. Missing component locations are valid. A malformed Skill removes
  only that Skill from the usable inventory. An invalid `mcp.json` removes all
  MCP servers; an invalid server removes only that server.
- Skill validation applies the exact core Agent Skills rules in spec 42. A
  usable Skill name equals its frontmatter `name` and directory basename.
  Inspection exposes its name and description, never its body or path.
- `mcp.json` and each server use the bundled Agent Plugins 1.0.0 schemas.
  `streamable-http` and `stdio` are inventoried. Legacy `sse` receives
  `transport_unsupported` and is not included in the usable inventory. Schema
  URLs are identifiers only and are never fetched.
- An MCP server summary contains its declared name, transport, and
  `supported: true` only for `streamable-http`. A valid `stdio` entry is
  retained with `supported: false` and a `transport_unsupported` diagnostic.

`AgentPluginInspection` is a frozen record containing `valid`, the recognized
manifest fields when available, resolved trust state, package digest when
calculable, Skill summaries, MCP server summaries, and diagnostics. Recognized
manifest metadata is untrusted package input returned only to the caller; the
addon never logs it or records it in telemetry. The ignored `extensions` value
is not returned.
`valid` means that the root and manifest are loadable and the package digest was
calculated within the configured limits. A rejected optional Skill or MCP
component remains visible as a diagnostic but does not make the whole plugin
invalid. Trust and expected-digest comparison are separate load decisions and
also do not change this format-validity flag.
Returned component summaries never contain a resolved path, MCP endpoint URL,
command, argument, environment value, header, file body, schema, or credential.

Every public array is deterministic. `skills` sorts by normalized Skill id;
`mcpServers` sorts by portable server name and then transport. Both use unsigned
UTF-8 byte order. Diagnostics sort by the tuple error-before-warning, `code`,
`component` (absent first), `item` (absent first), `pluginName` (absent first),
then `message`, with string members compared by unsigned UTF-8 bytes. Duplicate
equal diagnostics collapse to one entry.

## 4. Trust, digest, and filesystem safety

Plugin data is untrusted by default. Loading requires both:

1. `trust: 'trusted'` on the source or containment of the resolved source root
   within one of the application-owned `trustedRoots`; and
2. a lowercase SHA-256 `expectedDigest` equal to the digest calculated from the
   package being loaded.

At public function entry the implementation captures `process.cwd()` once.
Every relative `source.root` and `trustedRoots` member is resolved against that
same absolute base; absolute inputs remain absolute. Empty/NUL-containing paths
are invalid. The scanner then resolves the existing real path and performs all
containment checks against real absolute paths. A trusted root must itself be an
existing real directory; equality or descendant containment grants location
trust, while lexical prefixes do not. Later process working-directory changes
cannot affect the call.

Manifest metadata, author fields, a package location, and a matching digest do
not grant trust. A digest records reviewed bytes; the application owns any
lockfile or approval store. `loadAgentPlugins` validates sources in input order
and is atomic: the first manifest, trust, or digest failure throws its typed,
content-free error and returns no loaded plugins. A successful call returns one
loaded plugin for every input source in the same order. Callers use inspection
before loading when they need the complete diagnostic inventory.

The canonical digest is a lowercase 64-character SHA-256 hexadecimal string.
It covers every regular file below the resolved plugin root, including
`plugin.json`, `mcp.json`, Skills, ignored extensions, documentation, and
license files; there is no exclusion list. Empty directories do not contribute.
The scanner reads POSIX directory names as raw bytes and decodes strict UTF-8;
on Windows it rejects lone UTF-16 surrogates. It converts platform separators
to `/`, normalizes every Unicode scalar sequence to NFC, then encodes UTF-8.
It rejects an empty, `.`, `..`, backslash, absolute, or control-character
segment and rejects two entries that collapse to the same normalized byte path.
Files are sorted by unsigned raw UTF-8 path bytes. The hash transcript is
exactly:

1. UTF-8 bytes `PURISTA_AGENT_PLUGIN_DIGEST_V1\0`;
2. for each sorted file, the normalized-path byte length as an unsigned
   64-bit big-endian integer, then the path bytes; and
3. the file-content byte length in the same encoding, then the exact file
   bytes.

The scan permits at most `AGENT_PLUGIN_MAX_ENTRIES` filesystem entries,
`AGENT_PLUGIN_MAX_DEPTH` path segments, and
`AGENT_PLUGIN_MAX_PATH_BYTES` UTF-8 bytes per normalized relative path.
`maxFileBytes` defaults to `AGENT_PLUGIN_DEFAULT_MAX_FILE_BYTES` and cannot
exceed `AGENT_PLUGIN_MAX_FILE_BYTES`; `maxPackageBytes` defaults to
`AGENT_PLUGIN_DEFAULT_MAX_PACKAGE_BYTES` and cannot exceed
`AGENT_PLUGIN_MAX_PACKAGE_BYTES`. Both options must be positive safe integers,
and `maxFileBytes` cannot exceed `maxPackageBytes`. The aggregate counts the
content bytes of all regular files. An invalid option is a
`manifest_invalid` inspection diagnostic and a
`AgentPluginManifestError('manifest_invalid')` during load; exceeding any scan,
path, file, or package bound is `package_too_large`.

One scan produces one private immutable snapshot containing normalized names and
exact file bytes. Manifest/component parsing, inventory, diagnostics, and the
digest are all derived from that snapshot; a file is never parsed from a second
read. The scanner records identity, type, size, and modification metadata before
and after each read and rechecks the directory inventory. A change retries the
complete scan once; another change is `manifest_invalid`. Thus returned digest,
summaries, and later provenance always describe the same snapshot.

All reads use real filesystem containment. Traversal, symlinks,
junctions/reparse points, case-normalized Windows drive escapes, UNC escapes,
non-regular manifests, and special devices are rejected before their targets
are read. Component errors use the narrow failure boundary from section 3.

The digest is checked during loading and again by `bindings()`. Core later reads
each selected Skill into its own immutable byte snapshot during Harness instance
creation. The application owns the interval between binding and that snapshot:
it must keep the reviewed plugin root immutable, for example through a
read-only deployment image or an application-owned installation directory. The
addon makes no claim that a caller-writable or externally shared directory is a
trusted package store. HTTP URL and header data are copied during loading and
do not depend on later filesystem reads.

## 5. Binding contract

`LoadedAgentPlugin.bindings()` is synchronous and has no runtime side effects.
It first creates another complete immutable snapshot, compares its digest with
the loaded snapshot, and validates the entire request against the new snapshot
before creating the result. A changed package throws
`AgentPluginTrustError{reason:'digest_mismatch'}`. If any selected entry is
invalid, it throws one content-free `AgentPluginLoadError` and returns no
partial definitions, bindings, provenance, or diagnostics.

### 5.1 Skills

Each key in `skills` MUST be the exact discovered Skill id. Skill aliases are
not supported because core requires the definition id, directory basename,
and `SKILL.md` name to match. The caller supplies an explicit frozen-compatible
`runtimes` list, including `[]` for a guidance-only Skill. Values are validated
against `SkillRuntimeId`; duplicates are rejected. The addon calls
`defineSkill(skillId, { directory, runtimes })` with the contained discovered
directory and returns the resulting definition under the same key.

Selecting an unknown or invalid Skill fails the whole call. Object-keyed Skill
selection cannot represent the same Skill twice. The
plugin cannot declare runtimes for the application. Runtime requirements do
not grant tools, process execution, filesystem mutation, or network access;
core compiles and validates them under spec 42.

### 5.2 MCP servers and tools

Each `mcpServers` key is a caller-owned local server id accepted by
`defineMcpServer`. `server` is the exact portable server name. Each nested
`tools` key is a caller-owned local tool id. For every tool, the caller owns
the exact `remoteName`, `description`, input model schema, and output Standard
Schema required by `McpToolOptions`. Plugin data supplies none of those type or
validation contracts.

The addon rejects an unknown server, a server not using
`streamable-http`, an empty selected tool map, a duplicate selected plugin
server, or duplicate `remoteName` values within one selected server. It also
rejects any local id, description, remote name, or schema that the corresponding
core factory rejects. After validation it calls
`defineMcpServer(localServerId, { tools })` and returns the exact resulting
server definition.

For each selected server the matching `mcp` entry is exactly:

```ts
{
  transport: 'http',
  url: portableServer.url,
  ...(mergedHeaders === undefined ? {} : { headers: mergedHeaders }),
}
```

The portable URL must be an absolute `https:` URL, except that the exact hosts
`localhost`, `127.0.0.1`, and `[::1]` may use `http:`. A port is allowed;
subdomains, alternative IPv4 spellings, and other addresses are not treated as
loopback. The serialized URL contains at most 8,192 UTF-8 bytes and has no user
information, query, or fragment. The
portable and caller header records are independently copied, validated, and
merged case-insensitively into one frozen record. Portable headers may contain
untrusted server configuration, but are never treated as proof that a value is
non-secret: `authorization`, `cookie`, and `x-api-key` are rejected in portable
input to prevent the common embedded-credential cases. The application must
still review every portable name and value before trusting the package digest.
Each source may contain at most 64 headers. A name contains at most 256 UTF-8
bytes and a value at most 8,192 UTF-8 bytes; each source and the merged record
may contain at most 32,768 UTF-8 bytes in total. The aggregate is the sum, for
every entry, of the UTF-8 byte length of its normalized lowercase name plus the
UTF-8 byte length of its value; separators and object syntax contribute no
bytes. Both sources reject `accept`, `content-type`,
`content-length`, `host`, `connection`, `keep-alive`, `proxy-authenticate`,
`proxy-authorization`, `set-cookie`, `te`, `trailer`, `transfer-encoding`,
`upgrade`, `mcp-protocol-version`, `mcp-session-id`, and `last-event-id` because
the HTTP stack or Core owns them. Caller headers may carry `authorization`,
`cookie`, or `x-api-key`. Invalid HTTP token names, non-string values, control
characters, or case-insensitive duplicates within either source fail. Names are
normalized to lowercase and bytewise sorted. A caller header replaces a
portable header with the same normalized name; otherwise the portable header is
preserved. The binding omits `headers` only when the merged record is empty.
Neither source is logged or recorded in telemetry, and redirects cannot forward
the merged record to another origin.

The returned HTTP binding contains no provenance or addon-only field. Core
connects and performs `tools/list` only when the server enters the compiled
Harness graph, verifies every declared remote tool and input schema, ignores
undeclared upstream tools, and applies the ordinary tool validation, policy,
approval, timeout, cancellation, telemetry, and shutdown pipeline.

### 5.3 Selected-only behavior

Loading alone creates no Skill definition, MCP definition, runtime binding, or
agent capability. Binding materializes only the keys named in the two required
selection maps; empty maps return empty frozen maps. A projected definition
still grants no capability until an agent references that exact Skill or MCP
tool definition. An unselected Skill, server, remote tool, or newly discovered
upstream tool never enters the graph or callable registry.

## 6. Portable stdio behavior

This release inventories but does not project portable `stdio` servers. A
valid stdio entry appears in inspection as `supported: false` with
`transport_unsupported`. Selecting it in `bindings()` fails the entire call
with `AgentPluginLoadError` reason `transport_unsupported`.

The addon does not create a process binding, stage a package, manage a writable
plugin data directory, expand `PLUGIN_ROOT` or `PLUGIN_DATA`, synchronize
state, choose a working directory, or acquire lifecycle locks. The current
public stdio `McpBinding` requires a caller-owned `SpawnCapableSandbox` and has
no portable immutable-package/data-lifecycle contract. Portable stdio support
therefore requires a separate approved core contract and implementation before
this addon may return such a binding.

## 7. Provenance and privacy

Provenance is returned only through `AgentPluginBindings.provenance`. Its maps
have the same literal keys as the selected definition maps and contain plugin
name, optional declared version, reviewed digest, component kind, portable
source name, and caller-owned local id where applicable. It is deeply frozen.
It is not attached to a core definition or `McpBinding`, and this addon makes no
claim that core inspection, events, logs, metrics, or spans contain plugin
provenance.

Diagnostics may contain a stable code, plugin name when known, component
kind/name when known, and a safe explanatory message. Errors expose only their
stable reason and fixed message. Neither diagnostics nor errors may contain
absolute paths, URLs, commands, arguments, environment values,
headers, schemas, file content, prompts, tool inputs/results, or credentials.
Normal core Skill and MCP execution retains the telemetry and no-content rules
defined by core.

## 8. Diagnostics and errors

`AgentPluginDiagnostic` has `level: 'warn' | 'error'`, a stable `code`, and the
content-free metadata described in section 7. The stable inspection codes are:

`plugin_root_invalid`, `manifest_missing`, `manifest_invalid`,
`manifest_unknown_field`, `manifest_extensions_ignored`, `schema_unsupported`,
`path_escape`, `untrusted`, `digest_invalid`, `digest_mismatch`,
`package_too_large`, `component_invalid`,
`skill_invalid`, `skill_duplicate`, `mcp_config_invalid`,
`transport_unsupported`, and `server_invalid`.

The diagnostic mapping is exact. Its message is always
`Agent Plugin diagnostic: <code>.`, where `<code>` is the public code verbatim;
no package value is interpolated. Equal code/metadata tuples therefore have the
same message.

| Code | Level | Condition |
| --- | --- | --- |
| `plugin_root_invalid` | error | root is missing, not a directory, unreadable, or fails real-path containment safety |
| `manifest_missing` | error | regular root `plugin.json` is absent |
| `manifest_invalid` | error | manifest, inspection options, normalized paths, or stable snapshot is invalid |
| `manifest_unknown_field` | warn | unknown manifest field is ignored |
| `manifest_extensions_ignored` | warn | present `extensions` content is not interpreted |
| `schema_unsupported` | error | manifest schema identifier is unsupported |
| `path_escape` | error | traversal, link, reparse point, drive, UNC, or normalized collision violates containment |
| `untrusted` | error | source has no explicit or trusted-root grant |
| `digest_invalid` | error | supplied expected digest syntax is invalid |
| `digest_mismatch` | error | supplied expected digest differs from the snapshot digest |
| `package_too_large` | error | an entry, path, file, or aggregate scan bound is exceeded |
| `component_invalid` | error | a component container cannot be safely inventoried |
| `skill_invalid` | error | one Skill fails the Core Agent Skill rules |
| `skill_duplicate` | error | two discovered Skills declare the same id |
| `mcp_config_invalid` | error | root MCP configuration fails its bundled schema |
| `transport_unsupported` | warn | a recognized stdio server is inventory-only or a legacy transport is skipped |
| `server_invalid` | error | one MCP server entry fails its bundled schema or uniqueness rules |

The binding failure reasons on `AgentPluginLoadError` are:

`skill_not_found`, `mcp_server_not_found`, `transport_unsupported`,
`duplicate_selection`, `invalid_selection`, and `invalid_http_headers`.

`AgentPluginError` is the base class. `AgentPluginManifestError` represents an
invalid source encountered during an atomic load;
`AgentPluginTrustError` represents an untrusted, malformed-digest, or
digest-mismatched source during that load; and
`AgentPluginLoadError` represents an invalid explicit binding request. Core
initialization and execution failures continue to use the core error catalog.
Each error message is a fixed safe description selected by its subclass. These
errors retain no underlying cause, path, expected or actual digest, manifest
field value, URL, header, schema, or plugin content.
The exact messages are `Agent Plugin package is invalid.`, `Agent Plugin trust
verification failed.`, and `Agent Plugin binding selection is invalid.` for
the manifest, trust, and load subclasses respectively; a reason does not insert
package content into the message.

The terminal mapping is exhaustive:

| Operation and condition | Error class and reason |
| --- | --- |
| load: invalid root or containment escape | `AgentPluginManifestError('plugin_root_invalid')` |
| load: missing root manifest | `AgentPluginManifestError('manifest_missing')` |
| load: malformed manifest, invalid load options, or invalid manifest fields | `AgentPluginManifestError('manifest_invalid')` |
| load: unsupported manifest schema identifier | `AgentPluginManifestError('schema_unsupported')` |
| load or binding recheck: scan, depth, path, file, or package bound exceeded | `AgentPluginManifestError('package_too_large')` |
| binding recheck: root/containment/type safety fails or package becomes unreadable | `AgentPluginManifestError('plugin_root_invalid')` |
| binding recheck: normalized-path collision or repeated scan instability | `AgentPluginManifestError('manifest_invalid')` |
| load: source is not explicitly trusted or contained by a trusted root | `AgentPluginTrustError('untrusted')` |
| load: expected digest is not lowercase 64-character SHA-256 hex | `AgentPluginTrustError('digest_invalid')` |
| load or binding recheck: expected digest differs from canonical digest | `AgentPluginTrustError('digest_mismatch')` |
| binding: selected Skill is absent/unusable | `AgentPluginLoadError('skill_not_found')` |
| binding: selected portable server is absent/unusable | `AgentPluginLoadError('mcp_server_not_found')` |
| binding: selected server transport is unsupported | `AgentPluginLoadError('transport_unsupported')` |
| binding: one portable server is selected more than once or remote names repeat within a server | `AgentPluginLoadError('duplicate_selection')` |
| binding: closed selection shape, local id, description, remote name, schema, runtime list, URL, or other non-header field is invalid | `AgentPluginLoadError('invalid_selection')` |
| binding: portable or caller header record is invalid | `AgentPluginLoadError('invalid_http_headers')` |

Inspection never throws one of these domain errors for ordinary invalid package
input. It returns the corresponding diagnostics. Only ambient programmer or
platform failures outside the specified domain, such as memory exhaustion, may
escape unchanged.

When several conditions fail, inspection reports every safely discoverable
diagnostic and returns them in the order above. Atomic load examines plugin
sources in caller order and, within one source, uses this precedence:
closed load options/trusted roots; root and containment; scan limits and
stability; manifest presence/shape/schema; trust; expected-digest syntax; digest
equality. `bindings()` first performs the complete snapshot/recheck precedence,
then validates the closed top-level shape and required maps, Skill keys in
unsigned UTF-8 order, and MCP local-server keys in unsigned UTF-8 order. Within
one MCP selection the precedence is local shape/id, portable server existence,
transport support, duplicate portable-server selection, nonempty tool map,
tool ids and definitions in unsigned UTF-8 order, duplicate remote names, URL,
portable headers, then caller headers. The first failure throws the mapped
reason in the table; no lower-precedence check creates definitions or returns a
partial result.

## 9. Example

```ts
import { defineAgent, defineHarness } from '@purista/harness'
import {
  inspectAgentPluginSync,
  loadAgentPlugins,
} from '@purista/harness-agent-plugins'
import { z } from 'zod'

const source = { root: './plugins/research', trust: 'trusted' as const }
const inspection = inspectAgentPluginSync(source)
if (!inspection.valid || inspection.digest === undefined) {
  throw new Error('The plugin is not ready for review.')
}

const [plugin] = await loadAgentPlugins({
  plugins: [{ ...source, expectedDigest: inspection.digest }],
})

const knowledgeToken = process.env.KNOWLEDGE_TOKEN
if (knowledgeToken === undefined) {
  throw new Error('KNOWLEDGE_TOKEN is required.')
}

const selected = plugin.bindings({
  skills: {
    'research-playbook': { runtimes: [] },
  },
  mcpServers: {
    knowledge: {
      server: 'remoteKnowledge',
      headers: { Authorization: `Bearer ${knowledgeToken}` },
      tools: {
        searchDocs: {
          remoteName: 'search',
          description: 'Search approved knowledge.',
          input: z.object({ query: z.string() }),
          output: z.object({ matches: z.array(z.string()) }),
        },
      },
    },
  },
})

const researcher = defineAgent('researcher', {
  model: 'chat',
  instructions: 'Research only approved knowledge sources.',
  skills: [selected.skills['research-playbook']],
  tools: [selected.mcpServers.knowledge.tools.searchDocs],
})

const definition = defineHarness({ name: 'researchHarness' })
  .addAgent(researcher)

const instance = await definition.getInstance({
  models: { chat: { provider, model: 'gpt-5' } },
  mcp: selected.mcp,
})
```

The application supplies the reviewed digest through its own lock/review
process and closes the instance through the lifecycle in spec 42.

## 10. Verification and acceptance

Hermetic tests SHALL cover:

1. valid and invalid Agent Plugins 1.0.0 manifests and bundled schemas, unknown
   fields, ignored extensions, size limits, and proof that no schema is fetched;
2. POSIX symlink and Windows junction, drive, case, and UNC containment through
   native or platform-gated fixtures;
3. missing/malformed components and the package, Skill, MCP file, and individual
   server failure boundaries;
4. trust defaults, trusted roots, malformed and mismatched digests, deterministic
   digest calculation, input-order preservation, and redacted output;
5. exact Skill ids and directories, caller-owned runtime tuples, actual branded
   `defineSkill` results, and empty/unknown selection behavior;
6. exact local server/tool literal types, caller-owned schemas/descriptions and
   remote names, actual branded `defineMcpServer` results, duplicate portable
   server and remote-name rejection, and no automatic exposure;
7. exact HTTP binding maps, URL and both header-source validation, safe portable
   header preservation, caller override precedence, credential/protocol-header
   rejection, and core runtime discovery/schema validation with a
   credential-free fake HTTP server;
8. stdio inventory with `supported: false`, deterministic selection failure,
   and proof that inspection/loading starts no process and creates no data; and
9. all-or-nothing binding failure, deep freezing, separate exact provenance,
   and no sensitive content in inspection, diagnostics, errors, or provenance.

Type tests MUST prove that literal selection keys and schemas flow to exact
Skill, MCP server, and MCP tool definitions, that returned values are accepted
by `defineAgent`, and that unknown output keys or structurally forged branded
definitions are rejected. Existing core Skill, MCP, governance, cancellation,
telemetry, and shutdown suites remain green.

The package README, root documentation, public API reference, AI Harness skill,
release workflow, package-content checks, workspace dependency automation, and
a hermetic local example SHALL be updated in the implementation wave. The
documentation must state the trust/digest review, explicit selected-only model,
caller-owned schemas and credential headers, safe portable-header merge,
Streamable HTTP support, and portable stdio non-support.

The feature is accepted only when declarations match this API, package contents
publish through the normal release workflow, all tests pass on Linux and
Windows, and conformance is recorded for exactly the Agent Plugins 1.0.0
components claimed here. No broader Agent Plugins conformance may be claimed.

## 11. Cross-references

- [Agent Plugins Specification 1.0.0](https://agent-plugins.org/specification)
  — portable package and client conformance requirements, reviewed 2026-09-05.
- Bundled reviewed schema artifacts:
  `schemas/1.0.0/plugin.schema.json` SHA-256
  `fd74dfcbccea4a5b8768d9bc87b9da27449213ca5d464ace724ca48ec4bc074b`
  and `schemas/1.0.0/mcp.schema.json` SHA-256
  `9b9863a18c18c2a4c53772e6099b13ae3c2e7eab1bd5330e9b98dca59af71e5f`.
  Tests load these package-owned bytes and never fetch schemas at runtime.
- [42-composable-definitions-and-catalogs](./42-composable-definitions-and-catalogs.md)
  sections 3.3, 4, 8, 9, 13, and 14 — v4 MCP/Skill definitions, graph
  compilation, instance bindings, lifecycle, and inspection.
- [01-architecture](./01-architecture.md) — addon boundary and dependency direction.
- [05-sandbox](./05-sandbox.md) — sandbox ownership and capability contracts.
- [07-tools](./07-tools.md) — common tool execution and MCP behavior.
- [08-skills](./08-skills.md) — Agent Skills format and progressive disclosure.
- [13-public-api](./13-public-api.md) — published package surface.
- [15-error-catalog](./15-error-catalog.md) — core execution errors.
- [16-testing](./16-testing.md) — hermetic fixtures and CI gates.
