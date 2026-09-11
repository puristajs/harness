import { SkillManifestError, type SkillManifestErrorReason } from '../src/errors/index.js'
import type { SkillRuntimeId } from '../src/definitions/types.js'
import { defineSkill } from '../src/definitions/skill.js'
import { loadSkillSnapshots } from '../src/skills/runtime.js'

new SkillManifestError('invalid', { reason: 'invalid_skill_path', skill_id: 'demo', path: 'notes.txt' })
new SkillManifestError('invalid', { reason: 'readonly_mount_unsupported', directory: 'file:///skills/demo' })

// @ts-expect-error v3 discovery/trust reasons are removed from the public error contract
new SkillManifestError('invalid', { reason: 'collision_shadowed' })
// @ts-expect-error the reader precondition was removed in favor of Harness-owned read_skill
new SkillManifestError('invalid', { reason: 'skill_read_tool_missing' })
// @ts-expect-error runtime ids remain a closed logical vocabulary
const invalidRuntime: SkillRuntimeId = 'ruby'
void invalidRuntime
const validReason: SkillManifestErrorReason = 'unsafe_skill_entry'
void validReason
// @ts-expect-error removed discovery reasons are not part of the stable v4 reason union
const removedReason: SkillManifestErrorReason = 'untrusted_project_skill'
void removedReason

const alpha = defineSkill('alpha-skill', { directory: new URL('file:///skills/alpha-skill') })
async function exactSnapshotKeys() {
	const snapshots = await loadSkillSnapshots([alpha] as const)
	void snapshots['alpha-skill']
	// @ts-expect-error undeclared Skill ids are absent
	void snapshots['beta-skill']
}
void exactSnapshotKeys
