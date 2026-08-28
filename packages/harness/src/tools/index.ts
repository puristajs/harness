import { z } from 'zod'
import { SandboxNoExecutorError, ToolNotFoundError, ValidationError, serializeError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import type { BuiltinToolName } from '../harness/defineHarness.js'
import type { ModelToolSpec } from '../ports/model-provider.js'
import { isExecCapableSession, type SandboxSessionBase } from '../sandbox/index.js'
import { ulid } from '../ulid/index.js'

/** Canonical built-in tool names. Custom tool ids and skill ids must not collide with these. */
export const BUILTIN_TOOL_NAMES: readonly BuiltinToolName[] = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'list']

/** Resolves an agent's enabled built-ins without expanding any custom tools. */
export function resolveEnabledBuiltinTools(
  builtinTools: readonly BuiltinToolName[] | false | undefined
): readonly BuiltinToolName[] {
  return builtinTools === false ? [] : builtinTools ?? BUILTIN_TOOL_NAMES
}

/** Per-file and total byte caps for the built-in `grep` read-and-match fallback. */
const GREP_MAX_FILE_BYTES = 2_000_000
const GREP_MAX_TOTAL_BYTES = 50_000_000

/** Maximum accepted length for a model-supplied `grep` pattern. */
const GREP_MAX_PATTERN_LENGTH = 1_000

/**
 * Matches a quantified group whose (paren-free) body contains an unbounded
 * quantifier — the classic catastrophic-backtracking shapes such as `(x+)+`,
 * `(x*)*`, or `(a+b){2,}`. The check is intentionally syntactic and
 * conservative. Residual risk: ambiguous alternations like `(a|a)+` and
 * quantifiers nested deeper than one group level still pass; the byte caps
 * above bound the scanned input but cannot prevent a stalled event loop for
 * adversarial patterns beyond this check.
 */
const GREP_NESTED_UNBOUNDED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[*+]|\{\d+,\})(?:[^()\\]|\\.)*\)(?:[*+]|\{\d+,\})/

export const BUILTIN_ALIAS_TO_CANONICAL: Record<string, BuiltinToolName> = {
  bash: 'bash', Bash: 'bash',
  read: 'read', Read: 'read',
  write: 'write', Write: 'write',
  edit: 'edit', Edit: 'edit',
  glob: 'glob', Glob: 'glob',
  grep: 'grep', Grep: 'grep',
  list: 'list', List: 'list', LS: 'list'
}

const schemas = {
  bash: { input: z.object({ command: z.string().min(1), cwd: z.string().optional(), timeoutMs: z.number().int().positive().optional() }), output: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int() }), description: 'Run a shell command in the sandbox. Returns stdout, stderr, exitCode.' },
  read: { input: z.object({ path: z.string().min(1), encoding: z.literal('utf-8').default('utf-8') }), output: z.object({ content: z.string() }), description: 'Read a text file from the sandbox.' },
  write: { input: z.object({ path: z.string().min(1), content: z.string() }), output: z.object({ bytesWritten: z.number().int().nonnegative() }), description: 'Write or overwrite a text file in the sandbox.' },
  edit: { input: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() }), output: z.object({ replaced: z.literal(1) }), description: 'Replace exactly one occurrence of old_string with new_string in the given file.' },
  glob: { input: z.object({ pattern: z.string().min(1), root: z.string().default('/') }), output: z.object({ paths: z.array(z.string()) }), description: 'List files matching a glob pattern under root (recursive).' },
  grep: { input: z.object({ pattern: z.string().min(1), path: z.string().default('/'), maxResults: z.number().int().positive().default(100) }), output: z.object({ matches: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })) }), description: 'Search file contents for a regex pattern. Returns matching lines with paths and line numbers.' },
  list: { input: z.object({ path: z.string().min(1) }), output: z.object({ entries: z.array(z.object({ name: z.string(), kind: z.enum(['file', 'directory']), size: z.number().int().optional() })) }), description: 'List directory entries (non-recursive).' }
} as const

export function getBuiltinToolSpecs(enabled: readonly BuiltinToolName[], session: SandboxSessionBase): ModelToolSpec[] {
  return enabled.filter((name) => !(name === 'bash' && !isExecCapableSession(session))).map((name) => ({
    name,
    description: schemas[name].description,
    parameters: z.toJSONSchema(schemas[name].input) as JsonValue
  }))
}

/** Internal prepared binding; the input schema is evaluated before authorization. */
export type PreparedBuiltinTool = {
  [K in BuiltinToolName]: { name: K; input: z.output<(typeof schemas)[K]['input']> } & (K extends 'grep' ? { pattern: RegExp } : {})
}[BuiltinToolName]

/** Parses one built-in proposal without executing sandbox operations. */
export function prepareBuiltinTool(nameOrAlias: string, input: unknown): PreparedBuiltinTool {
  const canonical = BUILTIN_ALIAS_TO_CANONICAL[nameOrAlias]
  if (!canonical) throw new ToolNotFoundError('Built-in tool was not found.', { tool_id: nameOrAlias, where: 'model_response' })
  try {
    switch (canonical) {
      case 'bash': return { name: canonical, input: schemas.bash.input.parse(input) }
      case 'read': return { name: canonical, input: schemas.read.input.parse(input) }
      case 'write': return { name: canonical, input: schemas.write.input.parse(input) }
      case 'edit': return { name: canonical, input: schemas.edit.input.parse(input) }
      case 'glob': return { name: canonical, input: schemas.glob.input.parse(input) }
      case 'list': return { name: canonical, input: schemas.list.input.parse(input) }
      case 'grep': {
        const parsed = schemas.grep.input.parse(input)
        return { name: canonical, input: parsed, pattern: parseGrepPattern(parsed.pattern) }
      }
    }
  } catch (error) {
    throwBuiltinError(error)
  }
}

export async function invokeBuiltinTool(nameOrAlias: string, input: unknown, session: SandboxSessionBase, signal?: AbortSignal): Promise<JsonValue> {
  return invokePreparedBuiltinTool(prepareBuiltinTool(nameOrAlias, input), session, signal)
}

/** Executes the already parsed binding without repeating input normalization. */
export async function invokePreparedBuiltinTool(prepared: PreparedBuiltinTool, session: SandboxSessionBase, signal?: AbortSignal): Promise<JsonValue> {
  try {
    switch (prepared.name) {
      case 'bash': {
        if (!isExecCapableSession(session)) throw new SandboxNoExecutorError('Sandbox executor unavailable.', { session_id: 'unknown' })
        const parsed = prepared.input
        const res = await session.exec(parsed.command, {
          ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
          ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
          ...(signal ? { signal } : {})
        })
        return schemas.bash.output.parse({ stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode })
      }
      case 'read': {
        const parsed = prepared.input
        return schemas.read.output.parse({ content: await session.readText(parsed.path, parsed.encoding) })
      }
      case 'write': {
        const parsed = prepared.input
        await session.write(parsed.path, parsed.content)
        return schemas.write.output.parse({ bytesWritten: new TextEncoder().encode(parsed.content).byteLength })
      }
      case 'edit': {
        const parsed = prepared.input
        const content = await session.readText(parsed.path)
        const count = content.split(parsed.old_string).length - 1
        if (count !== 1) throw new ValidationError('edit requires exactly one match', { where: 'tool_input', issues: { path: parsed.path, matches: count } })
        // Replacer function so `$&`, `$$`, `` $` `` etc. in new_string are written literally.
        await session.write(parsed.path, content.replace(parsed.old_string, () => parsed.new_string))
        return { replaced: 1 }
      }
      case 'glob': {
        const parsed = prepared.input
        const files = await session.list(parsed.root, { recursive: true, glob: parsed.pattern })
        return schemas.glob.output.parse({ paths: files.map((f) => f.path) })
      }
      case 'grep': {
        const parsed = prepared.input
        const rx = prepared.pattern
        const entries = await session.list(parsed.path, { recursive: true })
        const matches: Array<{ path: string; line: number; text: string }> = []
        let scannedBytes = 0
        for (const entry of entries) {
          if (entry.kind !== 'file') continue
          // Bound memory and regex work: skip individual files over the cap and
          // stop once the total scanned size cap is reached.
          if (entry.size !== undefined && entry.size > GREP_MAX_FILE_BYTES) continue
          if (scannedBytes >= GREP_MAX_TOTAL_BYTES) break
          const content = await session.readText(entry.path)
          scannedBytes += content.length
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i += 1) {
            const currentLine = lines[i]
            if (currentLine !== undefined && rx.test(currentLine)) matches.push({ path: entry.path, line: i + 1, text: currentLine })
            if (matches.length >= parsed.maxResults) return schemas.grep.output.parse({ matches }) as JsonValue
          }
        }
        return schemas.grep.output.parse({ matches }) as JsonValue
      }
      case 'list': {
        const parsed = prepared.input
        const entries = await session.list(parsed.path)
        return schemas.list.output.parse({
          entries: entries.map((entry) => ({ name: entry.name, kind: entry.kind, ...(entry.size !== undefined ? { size: entry.size } : {}) }))
        }) as JsonValue
      }
    }
  } catch (error) {
    throwBuiltinError(error)
  }
}

function parseGrepPattern(pattern: string): RegExp {
  if (pattern.length > GREP_MAX_PATTERN_LENGTH) {
    throw new ValidationError('grep pattern exceeds the maximum supported length', {
      where: 'tool_input', issues: [{ path: 'pattern', message: `Pattern must be at most ${GREP_MAX_PATTERN_LENGTH} characters.` }]
    })
  }
  if (GREP_NESTED_UNBOUNDED_QUANTIFIER.test(pattern)) {
    throw new ValidationError('grep pattern contains a nested unbounded quantifier', {
      where: 'tool_input', issues: [{ path: 'pattern', message: 'Patterns like (x+)+ can cause catastrophic backtracking and are rejected.' }]
    })
  }
  try { return new RegExp(pattern) } catch {
    throw new ValidationError('grep pattern must be a valid regular expression', {
      where: 'tool_input', issues: [{ path: 'pattern', message: 'Invalid regular expression' }]
    })
  }
}

function throwBuiltinError(error: unknown): never {
  if (error instanceof z.ZodError) throw new ValidationError('Tool input validation failed', { where: 'tool_input', issues: JSON.parse(JSON.stringify(error.issues)) as JsonValue })
  throw error
}

export function toToolErrorMessage(toolCallId: string, error: unknown): Message {
  return {
    id: `msg_${ulid()}`,
    sessionId: '',
    role: 'tool',
    content: '',
    toolResults: [{ toolCallId, error: serializeError(error) }],
    timestamp: new Date().toISOString()
  }
}
