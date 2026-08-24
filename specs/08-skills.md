# Skills

`@purista/harness` implements Agent Skills as a generic runtime capability. A
skill is a directory containing `SKILL.md` plus optional supporting files. The
harness discloses only compact metadata to the model at run start; the model
loads full instructions and resources on demand through sandbox file tools.

This file is the source of truth for harness-level skill behavior. PURISTA
framework integration is specified separately in
`../specs/20-agents/80-agent-skills-runtime-integration.md` at the workspace
root.

## 1. File Layout

```text
my-skill/
├── SKILL.md
├── scripts/
├── references/
├── assets/
└── ...
```

Only `SKILL.md` is required. `scripts/`, `references/`, and `assets/` are
conventions, not hardcoded directory names. The harness must mount all regular
files in the skill directory tree unless scan limits or sandbox policy reject
them.

## 2. `SKILL.md` Format

`SKILL.md` contains YAML frontmatter followed by Markdown instructions.

Supported frontmatter fields:

```ts
type SkillFrontmatter = {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  'allowed-tools'?: string
}
```

Locked validation:

- `name`: 1-64 chars, lowercase ASCII letters, numbers, hyphens, no leading
  hyphen, no trailing hyphen, no consecutive hyphens.
- `description`: 1-1024 chars and must describe both purpose and activation
  conditions.
- `compatibility`: 1-500 chars when present.
- `metadata`: string keys and string values only.
- `allowed-tools`: parsed and preserved as a string. Enforcement is not part of
  v3; permission systems may consume it later.
- Parent directory name should match `name`. Strict mode treats mismatch as an
  error. Lenient mode records a diagnostic and loads the skill under the
  frontmatter name unless that name collides.

The harness must use a YAML parser or equivalent behavior that handles quoted
strings, block scalars, nested `metadata`, comments, and colons in quoted or
block values. Hand-rolled `line.indexOf(':')` parsing is forbidden.

## 3. Strict And Lenient Modes

The loader exposes strict and lenient behavior:

```ts
type SkillValidationMode = 'strict' | 'lenient'
```

Strict mode:

- invalid YAML: skip and throw `SkillManifestError`;
- missing/empty description: skip and throw `SkillManifestError`;
- invalid name: skip and throw `SkillManifestError`;
- parent-directory mismatch: skip and throw `SkillManifestError`.

Lenient mode:

- invalid YAML after one compatibility retry: skip and return a diagnostic;
- missing/empty description: skip and return a diagnostic;
- invalid name: skip and return a diagnostic;
- parent-directory mismatch: load and return a warning diagnostic when the
  frontmatter name is otherwise valid.

Compatibility retry wraps common unquoted scalar values containing colons into a
YAML-safe representation before retrying. The retry must not alter file content
on disk.

## 4. Public Skill Types

```ts
type SkillDefinition = {
  directory: string
  validationMode?: SkillValidationMode
  trust?: 'trusted' | 'project' | 'user'
  source?: string
}

type SkillsConfig = Record<string, SkillDefinition>

type ResolvedSkill = {
  name: string
  description: string
  directory: string
  skillPath: string
  location: string
  mountPath: `/skills/${string}`
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string
  trust: 'trusted' | 'project' | 'user'
  source?: string
  diagnostics: readonly SkillDiagnostic[]
}

type SkillDiagnostic = {
  level: 'warn' | 'error'
  code:
    | 'missing_skill_md'
    | 'invalid_frontmatter'
    | 'missing_description'
    | 'invalid_name'
    | 'name_mismatch'
    | 'directory_missing'
    | 'collision_shadowed'
    | 'untrusted_project_skill'
    | 'scan_limit_reached'
  message: string
  skillName?: string
  directory?: string
  source?: string
}
```

`location` is the absolute `SKILL.md` path. `skillPath` is retained as an alias
for developer clarity. `mountPath` is always `/skills/<name>`.

## 5. Discovery

Direct users may pass explicit `.skills({...})` bindings or use discovery
helpers before calling `.skills(...)`.

`@purista/harness-agent-plugins` may construct explicit bindings from approved
portable Agent Plugins. It reuses this loader and mount path after performing
plugin-root containment and trust checks; it does not change direct discovery
roots, trust defaults, or collision semantics. See
[29-agent-plugins](./29-agent-plugins.md).

```ts
type DiscoverSkillsOptions = {
  projectRoot?: string
  clientName?: string
  includeProjectAgentsDir?: boolean
  includeProjectClientDir?: boolean
  includeUserAgentsDir?: boolean
  includeUserClientDir?: boolean
  includeClaudeCompatDir?: boolean
  includeAncestorProjectDirs?: boolean
  trustedProjectRoots?: readonly string[]
  validationMode?: SkillValidationMode
  maxDepth?: number
  maxDirectories?: number
}

type DiscoveredSkills = {
  skills: SkillsConfig
  diagnostics: readonly SkillDiagnostic[]
}

function discoverSkills(options?: DiscoverSkillsOptions): Promise<DiscoveredSkills>
```

Discovery paths:

- project `.agents/skills/`;
- project `.<clientName>/skills/` when `clientName` is provided;
- user `~/.agents/skills/`;
- user `~/.<clientName>/skills/` when `clientName` is provided;
- `.claude/skills/` only when `includeClaudeCompatDir` is true.

Default scan limits are `maxDepth: 6` and `maxDirectories: 2000`. The scanner
skips `.git`, `node_modules`, `dist`, `build`, `.next`, `.astro`, and hidden
directories except `.agents`, `.claude`, and `.<clientName>`.

Precedence:

1. explicit `.skills({...})` bindings win over discovered bindings;
2. project-level skills override user-level skills;
3. client-native paths and `.agents/skills` at the same scope use
   deterministic last-wins order documented in diagnostics;
4. collisions log one warning diagnostic and never merge skill directories.

Trust:

- Project-level skills are untrusted unless `projectRoot` is in
  `trustedProjectRoots`.
- Untrusted project skills are skipped and produce
  `untrusted_project_skill`.
- Explicit bindings marked `trust: 'trusted'` are loaded.

## 6. Builder Integration

`.skills(skills)` resolves explicit definitions synchronously when all
directories are local and readable. If implementations need async discovery,
they call `discoverSkills(...)` before `defineHarness().skills(...)`.

Every `agent.skills[]` entry must match a resolved `.skills(...)` key. This is
checked in `.agents(...)` and fails before `.build()`.

Tool ids and skill ids share a namespace for model exposure. A custom tool id
must not collide with a skill id or a built-in tool name.

## 7. Progressive Disclosure

At the start of each agent run, if the agent has declared skills, the harness
appends this catalog to the agent's system instructions:

```text
Available skills:
- <name>: <description>
  Location: /skills/<name>/SKILL.md
  Compatibility: <compatibility when present>

Use the read tool to load /skills/<name>/SKILL.md when a skill is relevant.
Relative paths in a skill are relative to /skills/<name>/.
```

Rules:

- Omit the catalog entirely when no skills are available.
- Include only metadata, never full `SKILL.md` bodies.
- Include `Location` so models can activate skills by normal file-read tools.
- Include `Compatibility` only when present.
- Do not include `license`, `metadata`, or `allowed-tools` in the prompt unless
  a later spec requires it.

## 8. Mounting And Resources

When an agent run starts:

1. Resolve declared skill ids against the registry.
2. Recursively read each skill directory under scan limits.
3. Mount files into the sandbox at `/skills/<name>/`.
4. Cache mounted skill names per session.

Mounting is idempotent per session. File changes after the first mount are not
observed until a new session is opened.

The harness exposes resource listing metadata for dedicated activation or
debugging APIs, but it must not eagerly read resource file contents into the
model prompt.

## 9. Activation And Context Preservation

Primary activation mode is model-driven file-read activation. The model reads
`/skills/<name>/SKILL.md` using the `read` built-in tool when the catalog makes
a skill relevant.

The harness tracks activated skill names per run/session when the `read` tool
reads `/skills/<name>/SKILL.md`.

History compaction and transient context projection must satisfy one of these locked outcomes:

- keep activated skill tool results protected from pruning; or
- prune them only when the next prompt still contains the catalog and the model
  can reread the same `SKILL.md` path.

Duplicate reads of the same `SKILL.md` in one run should not re-mount files or
duplicate protected activation metadata.

## 10. Sandbox And Built-In Tools

Skills require sandbox file mounting. A sandbox without `mount` support cannot
run agents with declared skills.

For default-loop agents with declared skills:

- `read` must be enabled, otherwise `.agents(...)` or `.build()` fails with a
  skill/tool configuration error.
- `list` and `grep` are recommended but not required.
- `bash`, `write`, and `edit` are never required by the skill system itself.

For handler-based agents, the harness mounts declared skills and exposes the
catalog to handler context, but handlers decide whether to call models or file
tools.

## 11. Logging, Telemetry, Privacy

The harness logs diagnostics without skill bodies or supporting file contents.

Allowed log/span fields:

- skill name;
- source scope;
- trust level;
- diagnostic code;
- collision/shadowed name;
- sanitized directory or source when local path disclosure is allowed.

Forbidden fields in logs, metrics, spans, persisted events, and errors:

- full skill body;
- supporting file content;
- prompt text;
- completion text;
- tool arguments/results containing file content;
- credentials, tokens, headers, secrets, or raw attachments.

Harness GenAI/model/tool metrics remain under the telemetry conventions in
`14-otel-conventions.md`.

## 12. Errors

See `15-error-catalog.md`.

Locked skill error reasons:

- `missing_skill_md`
- `invalid_frontmatter`
- `missing_description`
- `invalid_name`
- `name_mismatch`
- `directory_missing`
- `reserved_name`
- `skill_not_declared`
- `skill_read_tool_missing`
- `skill_sandbox_unsupported`
- `untrusted_project_skill`

Lenient diagnostics do not throw unless all candidate skills required by a
declared agent were skipped.

## 13. Tests

The test catalog in `16-testing.md` must cover:

- strict/lenient parser behavior;
- optional frontmatter preservation;
- discovery paths, bounds, collisions, and trust gating;
- generated skill catalog text;
- absence of catalog when no skills exist;
- read-tool activation of `SKILL.md`;
- resource files mounted under `/skills/<name>/`;
- once-per-session mounting;
- failure when `read` is disabled for a default-loop skill agent;
- no sensitive skill content in logs, spans, metrics, persisted events, or
  sanitized errors.

## 14. Cross-References

- `02-harness-config.md` for builder shape.
- `05-sandbox.md` for mount semantics.
- `07-tools.md` for built-in read/list/grep behavior.
- `09-agents.md` for default-loop behavior.
- `11-sessions.md` for history windows and compaction.
- `26-context-projection-and-compaction.md` for the transient model-request pruner.
- `13-public-api.md` for exported types/helpers.
- `15-error-catalog.md` for error classes and metadata.
- `16-testing.md` for verification.
