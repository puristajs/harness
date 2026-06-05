# Harness Skills

## Contents
- Skill Directory Shape
- Frontmatter
- Register And Allowlist
- Runtime Behavior
- Tool Interaction
- Skill Authoring Quality

Use this reference when creating skill folders consumed by `@purista/harness` agents.

## Skill Directory Shape
A harness skill is a directory with `SKILL.md` at its root:

```text
incident-responder/
├── SKILL.md
├── references/
│   └── incident-template.md
└── scripts/
    └── summarize-log.js
```

The harness mounts the entire directory at `/skills/<name>/` inside the active sandbox session.

## Frontmatter
`SKILL.md` frontmatter is intentionally small:

```md
---
name: incident-responder
description: Use for drafting incident summaries with impact, owner, timeline, and next action.
compatibility: "@purista/harness >=0.0.0"
license: MIT
---

# Incident Responder

Read `references/incident-template.md` before drafting postmortem-ready summaries.
```

Rules from implementation:
- `name` must match lowercase ASCII letters, numbers, and hyphens with no leading, trailing, or consecutive hyphens
- `description` must be present and no longer than 1024 characters
- optional `compatibility`, `license`, `metadata`, and `allowed-tools` are preserved in resolved metadata
- harness config key must equal frontmatter `name`
- explicit bindings parse frontmatter strictly by default; discovery parses leniently and reports diagnostics

## Register And Allowlist
Register skills globally, then allowlist them per agent:

```ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

defineHarness()
  .models(...)
  .skills({
    'incident-responder': {
      directory: join(here, 'skills/incident-responder'),
      trust: 'trusted',
      source: 'application'
    }
  })
  .agents(({ agent }) => ({
    incident_writer: agent({
      model: 'assistant',
      input: z.object({ incident: z.string() }),
      output: z.object({ summary: z.string() }),
      skills: ['incident-responder'],
      builtinTools: ['read', 'list', 'grep'],
      instructions: 'Use the mounted incident-responder skill when drafting.'
    })
  }))
```

Use absolute directories or resolve them from `import.meta.url`. Avoid brittle process-relative paths.
For local agent-client projects, `discoverSkills(...)` can build the `.skills(...)`
map from trusted user roots and explicitly trusted project roots. Explicit
bindings have higher precedence than discovery.

## Runtime Behavior
At run start, for each declared skill:
1. The harness recursively reads the skill directory from host disk.
2. It mounts all files into the sandbox at `/skills/<name>/`.
3. Mounting happens once per session per skill id.
4. Instructions get a compact skill index appended:

```text
Available skills:
- incident-responder: Use for drafting incident summaries...
  Location: /skills/incident-responder/SKILL.md

Use the read tool to load /skills/<name>/SKILL.md when a skill is relevant.
```

The full `SKILL.md` body is not injected. The model must use filesystem tools such as `read`, `list`, or `grep` to inspect `/skills/<name>/`.

## Tool Interaction
If an agent uses skills, keep enough read-only built-ins enabled for discovery. `builtinTools: false` means the model cannot read mounted skill files unless the instructions and custom tool path compensate.

Recommended skill-aware defaults:

```ts
builtinTools: ['read', 'list', 'grep']
```

Add `bash`, `write`, or `edit` only when the task genuinely needs command execution or file mutation, and pair them with permissions.

## Skill Authoring Quality
Use progressive disclosure:
- keep `SKILL.md` compact and navigational
- move provider-specific examples, long schemas, or workflows into `references/`
- include scripts only when deterministic execution is useful
- avoid extra README/changelog files inside the skill folder

When editing a reusable skill, run a frontmatter validator and verify every linked reference exists.
