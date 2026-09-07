# Agent Skills

**Status:** active v4 topic contract.

Harness implements Agent Skills as immutable guidance and resource packages.
[Spec 42 §4](./42-composable-definitions-and-catalogs.md) owns the exact
definition, loader, sandbox, inference, and runtime-requirement contract.

## Define a Skill

```ts
const transactionAnalysis = defineSkill('transaction-analysis', {
  directory: new URL('./transaction-analysis', import.meta.url),
  runtimes: ['python'],
})
```

`directory` is a `file:` URL for the directory containing `SKILL.md`.
`runtimes` is optional and uses the closed logical ids `node`, `python`,
and `shell`. It states what an executable Skill needs. It does not install a
runtime, select a command, grant execution, or describe script input/output.

A Skill is made available only through a direct reference from an agent:

```ts
const analyst = defineAgent('analyst', {
  instructions: 'Analyze the supplied transaction.',
  skills: [transactionAnalysis],
})
```

Catalogs may export Skills for reuse, but catalog membership does not grant an
agent access.

## Directory contract

```text
transaction-analysis/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

Only `SKILL.md` is required. Supporting directory names are conventions; the
loader snapshots all accepted regular files under the Skill root.

The accepted frontmatter follows the Agent Skills field set:

```yaml
---
name: transaction-analysis
description: Analyze transaction risk when a transaction needs manual review.
license: MIT
compatibility: Requires Python 3.12 for the optional analysis script.
metadata:
  owner: risk-team
allowed-tools: read_skill
---
```

- `name` is required, matches the Skill id and directory basename, and uses
  1–64 lowercase ASCII letters, digits, or single hyphens.
- `description` is required, nonempty, and at most 1,024 characters.
- `license`, `compatibility`, string-valued `metadata`, and the
  experimental `allowed-tools` string are optional.
- Unknown frontmatter fields fail.
- `allowed-tools` is descriptive Skill content. It never selects a Harness
  tool, grants permission, or bypasses policy.

Harness uses a real YAML parser. The loader accepts quoted strings, block
scalars, comments, and nested metadata without source rewriting.

## Immutable loading

`defineSkill` validates pure identity fields synchronously. During
`getInstance`, Harness:

1. requires a `file:` root URL;
2. rejects symlinks and non-regular entries;
3. enforces normalized relative POSIX paths and traversal protection;
4. enforces the file-count, path-size, individual-file, `SKILL.md`, and total
   snapshot limits in spec 42;
5. reads each accepted file into one immutable byte snapshot;
6. validates `SKILL.md` from that same snapshot;
7. uses that snapshot for both progressive reading and read-only mounting.

There is one strict behavior. Discovery, shadowing, lenient parsing, mutable
directory rereads, trust flags, review hashes, script manifests, and
per-script schema declarations are outside the core v4 Skill definition.
Application tooling may discover candidate directories before calling
`defineSkill`, but Harness receives only explicit definitions.

## Progressive disclosure

At the start of a selected agent run, Harness appends compact metadata for that
agent's Skills:

```text
Available skills:
- transaction-analysis: Analyze transaction risk when a transaction needs manual review.

Use read_skill to load a Skill's SKILL.md when its instructions are relevant.
```

Harness does not inject complete `SKILL.md` bodies or supporting files into
the prompt. It synthesizes a reserved `read_skill` tool only for agents that
declare Skills. The tool exposes an exact Skill-id union and a normalized
relative path, reads only the immutable selected snapshots, and defaults to
`allow`.

`read_skill` is private to the agent. It does not appear in a catalog, the
Harness closure, a public registry, or another agent's tool set.

## Guidance-only and executable Skills

A Skill with no runtimes is guidance-only. It uses `read_skill` and does not
require a sandbox.

A Skill with runtimes contributes:

- its exact logical runtime ids;
- `sandbox.fs`;
- `sandbox.readonly_mount`.

Before the first provider call, Harness mounts the immutable snapshot at
`/skills/<skill-id>`. The selected sandbox must explicitly advertise every
runtime and enforce read-only mounting against its APIs and child processes.
Runtime availability is never inferred from `PATH`, an image name, or the
Harness process.

The mount and runtime declaration do not grant `sandbox.exec`, filesystem
mutation, environment variables, network access, or a built-in tool. A model
can run a script only through a separately selected and authorized
execution-capable tool. Applications should keep that tool narrow and enforce
sandbox, egress, credential, permission, governance, and approval policy there.

## Activation and context retention

Harness records activation when `read_skill` reads a Skill's `SKILL.md`.
Transient context projection may remove an old result only when the next
prompt still contains the same compact Skill index and the model can reread
the unchanged snapshot. Mounting is idempotent for the session.

Durable resume validates the same definition graph, application revision, and
Skill snapshot identity required by spec 42. It never silently resumes against
changed Skill bytes.

## Agent Plugins

The optional Agent Plugins package inspects an application-approved local
package as untrusted data. An application explicitly projects selected
portable entries into ordinary `defineSkill` and `defineMcpServer`
definitions. Plugin code is never evaluated and an undeclared component never
enters the Harness graph. See [spec 29](./29-agent-plugins.md).

## Errors and privacy

Skill loading and mounting use `SkillManifestError` with the stable reasons
defined in [spec 42](./42-composable-definitions-and-catalogs.md) and
[spec 15](./15-error-catalog.md). Failure metadata may identify a Skill id and
bounded path but never contains file bytes or instruction text.

Skill bodies, supporting files, prompts, tool content, credentials, and
mounted data are excluded from content-free logs, metrics, spans, persisted
events, and inspection.

## Required verification

- exact definition identity and runtime inference;
- strict frontmatter and filesystem validation;
- immutable snapshot use and traversal/symlink rejection;
- progressive disclosure and exact `read_skill` scoping;
- guidance-only operation without a sandbox;
- executable runtime and read-only mount preflight;
- no implicit tool, execution, network, credential, or permission grant;
- replay identity and privacy behavior.

## References

- [05 — Sandbox](./05-sandbox.md)
- [07 — tools](./07-tools.md)
- [09 — agents](./09-agents.md)
- [26 — context projection](./26-context-projection-and-compaction.md)
- [29 — Agent Plugins](./29-agent-plugins.md)
- [42 — exact Skill contract](./42-composable-definitions-and-catalogs.md)
