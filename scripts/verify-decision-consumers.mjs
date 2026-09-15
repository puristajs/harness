import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const ignoredDirectories = new Set(['node_modules', '.git', '.artifacts', 'dist', 'dist-test', 'coverage', '.astro', 'build']);
const removedIdentifiers = new Set([
  'onPermission', 'OnPermission', 'PermissionContext', 'PermissionDecision', 'GovernanceRiskLevel',
  'GovernanceAuditContext', 'AgentInterceptorError', 'PolicyEvaluationError', 'GuardrailBlockedError',
  'GuardrailEvaluationError', 'ProviderItems', 'providerItems', 'consumeApproved',
]);

/** Enumerate a declared file/directory, excluding installed and generated trees. */
export async function filesUnder(directory) {
  if ((await stat(directory)).isFile()) return [directory];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => !ignoredDirectories.has(entry.name)).map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  }));
  return files.flat().sort();
}

/** Resolve every exact package alias and reject a registry or sibling-workspace substitute. */
export function assertLocalResolution(ts, options, consumer, aliases) {
  return Object.fromEntries(Object.entries(aliases).map(([name, expected]) => {
    const actual = ts.resolveModuleName(name, consumer, options, ts.sys).resolvedModule?.resolvedFileName;
    if (!actual || !existsSync(expected) || realpathSync(actual) !== realpathSync(expected)) {
      throw new Error(`Local resolution failed for ${name}: expected ${expected}; resolved ${actual ?? '<missing>'}`);
    }
    return [name, realpathSync(actual)];
  }));
}

/** Extend the existing project without retaining inherited emit/build-info destinations. */
export function createCompilerConfig(ts, original, artifacts, label, aliases, include, { declarations = false } = {}) {
  const loaded = ts.readConfigFile(original, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(original));
  const existingPaths = Object.fromEntries(Object.entries(parsed.options.paths ?? {}).map(([name, paths]) => [
    name, paths.map(path => resolve(parsed.options.baseUrl ?? parsed.options.pathsBasePath ?? dirname(original), path)),
  ]));
  return {
    extends: original,
    compilerOptions: {
      incremental: false,
      composite: false,
      noEmit: true,
      tsBuildInfoFile: join(artifacts, `${label}.tsbuildinfo`),
      outDir: join(artifacts, `${label}-output`),
      rootDir: resolve(artifacts, '../../..'),
      paths: { ...existingPaths, ...Object.fromEntries(Object.entries(aliases).map(([name, path]) => [name, [path]])) },
      ...(declarations ? { skipLibCheck: false } : {}),
    },
    include,
    exclude: ['**/node_modules/**', '**/dist/**'],
    references: [],
  };
}

/** Capture child diagnostics and preserve the failing process status. No shell or package download is used. */
export async function runCommand(executable, args, { cwd, log }) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveResult({ code: code ?? 1, signal, output }));
  });
  await writeFile(log, result.output);
  if (result.code !== 0) {
    const error = new Error(`${executable} ${args.join(' ')} failed (${result.signal ?? result.code})\n${result.output}`);
    error.exitCode = result.code;
    throw error;
  }
  return result.output;
}

/**
 * Shared removed-API scan. Consumer defaults scan code only; cleanup can select
 * active documentation and explicitly marked statements in named test files.
 */
export async function scanRemovedSymbols(ts, workspaceRoot, {
  roots = ['starter', 'create-purista'],
  documentation = false,
  negativeFixtureFiles = [],
} = {}) {
  const findings = [];
  const seen = new Set();
  const negativeFiles = new Set(negativeFixtureFiles.map(path => {
    if (!/(?:^|\/)(?:test|type-tests)\/|\.test\.[cm]?[jt]sx?$/.test(path)) throw new Error(`Negative fixture allowance requires an exact test file: ${path}`);
    return resolve(workspaceRoot, path);
  }));
  const add = (path, line, symbol) => {
    const key = `${path}:${line}:${symbol}`;
    if (!seen.has(key)) { seen.add(key); findings.push({ path, line, symbol }); }
  };
  const permissionTypes = new Set(['AgentPermissions', 'PermissionPolicy', 'PermissionMode']);
  const permissionType = type => {
    if (!type) return false;
    if (ts.isIdentifier(type) && permissionTypes.has(type.text)) return true;
    return ts.forEachChild(type, permissionType) === true;
  };
  const permissionPath = expression => {
    if (ts.isIdentifier(expression)) return expression.text === 'permissions';
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text === 'permissions' || permissionPath(expression.expression);
    if (ts.isElementAccessExpression(expression)) return (ts.isStringLiteral(expression.argumentExpression) && expression.argumentExpression.text === 'permissions') || permissionPath(expression.expression);
    return false;
  };
  const isPermissionUse = node => {
    for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
      const name = parent.name;
      if (permissionType(parent.type) || (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
        (name.text === 'permissions' || ((ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent)) && permissionTypes.has(name.text))))) return true;
      if (ts.isBinaryExpression(parent) && permissionPath(parent.left)) return true;
    }
    return false;
  };
  const scanCode = (path, content, firstLine = 0) => {
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    const excluded = [];
    if (negativeFiles.has(path)) {
      const testDefinition = node => {
        if (!ts.isExpressionStatement(node)) return false;
        let callee = node.expression;
        while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) callee = callee.expression;
        return ts.isIdentifier(callee) && ['test', 'it', 'describe'].includes(callee.text);
      };
      const mark = node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isVariableStatement(node) || ts.isExpressionStatement(node)) && !testDefinition(node)) {
          const comments = ts.getLeadingCommentRanges(content, node.pos) ?? [];
          if (comments.some(comment => /(?:@ts-expect-error\s+decision-boundaries: removed API|decision-boundaries: negative fixture)\b/.test(content.slice(comment.pos, comment.end)))) {
            excluded.push([node.getStart(source), node.end]);
          }
        }
        ts.forEachChild(node, mark);
      };
      mark(source);
    }
    const visit = node => {
      if (excluded.some(([start, end]) => node.getStart(source) >= start && node.end <= end)) return;
      const propertyKey = ts.isStringLiteral(node) && (node.parent.name === node || node.parent.propertyName === node ||
        (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node));
      const line = firstLine + source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if ((ts.isIdentifier(node) || propertyKey) && removedIdentifiers.has(node.text)) add(path, line, node.text);
      if (ts.isStringLiteral(node) && node.text === 'ask' && isPermissionUse(node)) add(path, line, 'permissions.ask');
      if (documentation && (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) && node.parent.name?.getText(source) === 'body') {
        scanMarkdown(path, node.text, line - 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  const scanMarkdown = (path, content, firstLine = 0) => {
    for (const match of content.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      if (removedIdentifiers.has(match[0])) add(path, firstLine + content.slice(0, match.index).split('\n').length, match[0]);
    }
    for (const match of content.matchAll(/```(?:ts|typescript|tsx|js|javascript)[^\n]*\n([\s\S]*?)```/g)) {
      scanCode(path, match[1], firstLine + content.slice(0, match.index + match[0].indexOf('\n') + 1).split('\n').length - 1);
    }
  };
  for (const relative of roots) {
    const directory = join(workspaceRoot, relative);
    if (!existsSync(directory)) throw new Error(`Missing required consumer source directory: ${directory}`);
    for (const path of await filesUnder(directory)) {
      if (['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'].includes(extname(path))) scanCode(path, await readFile(path, 'utf8'));
      else if (documentation && ['.md', '.mdx'].includes(extname(path))) scanMarkdown(path, await readFile(path, 'utf8'));
    }
  }
  return findings;
}

function localTool(repo, packageName, entry, label) {
  const path = join(repo, 'node_modules', packageName, entry);
  if (!existsSync(path)) throw new Error(`Missing installed local ${label}: ${path}`);
  return path;
}

function mappings(root, mode) {
  const harness = join(root, 'ai-harness/packages');
  return {
    '@purista/harness': join(harness, `harness/${mode}/index.${mode === 'src' ? 'ts' : 'd.ts'}`),
    '@purista/harness/testing': join(harness, `harness/${mode}/testing/index.${mode === 'src' ? 'ts' : 'd.ts'}`),
    '@purista/harness-openai': join(harness, `harness-openai/${mode}/index.${mode === 'src' ? 'ts' : 'd.ts'}`),
    '@purista/harness-guardrails': join(harness, `harness-guardrails/${mode}/index.${mode === 'src' ? 'ts' : 'd.ts'}`),
    '@purista/core': join(root, 'purista/packages/core/src/index.ts'),
  };
}

async function assertFreshBuild(root) {
  for (const name of ['harness', 'harness-guardrails', 'harness-openai']) {
    const pkg = join(root, 'ai-harness/packages', name);
    const built = join(pkg, 'dist/index.d.ts');
    if (!existsSync(built)) throw new Error(`Missing local build: ${built}. Run the Harness workspace build first.`);
    const sources = (await filesUnder(join(pkg, 'src'))).filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts'));
    const newestSource = Math.max(...await Promise.all(sources.map(async path => (await stat(path)).mtimeMs)));
    if ((await stat(built)).mtimeMs < newestSource) {
      throw new Error(`Stale local build: ${built}. Rebuild Harness before consumer verification.`);
    }
  }
}

const declarationConsumer = `import {
  createDecisionEvidence, DecisionBlockedError, DecisionEvaluationError, defineHarness,
  type AgentPermissions, type GovernanceAuditRecord, type ToolApprovalInterrupt,
  type ToolApprovalResume, type ExternalWaitOutcome, type ProviderContinuation,
} from '@purista/harness';
import { FakeModelProvider } from '@purista/harness/testing';
import { defineGuardrails, type GuardrailOutcome, type GuardrailsConfig } from '@purista/harness-guardrails';
import { openai } from '@purista/harness-openai';
// @ts-expect-error Removed permission callback has no compatibility export.
import type { OnPermission } from '@purista/harness';
// @ts-expect-error Approval callbacks were replaced by durable interrupt/resume.
import type { GovernanceApprovalProvider } from '@purista/harness';
// @ts-expect-error ProviderItems was replaced by the canonical continuation contract.
import type { ProviderItems } from '@purista/harness';
// @ts-expect-error Evaluation errors share the core decision error contract.
import { GuardrailEvaluationError } from '@purista/harness-guardrails';
// @ts-expect-error Guardrail configuration is inline only; there is no file loader.
import { loadGuardrailsConfig } from '@purista/harness-guardrails';
// @ts-expect-error Guardrail configuration is inline only; there is no parser.
import { parseGuardrailsConfig } from '@purista/harness-guardrails';
declare const interrupt: ToolApprovalInterrupt;
const resume: ToolApprovalResume = {
  type: 'tool-approval', runId: 'run-1', interruptId: 'interrupt-1', revision: 'revision-1',
  eventId: 'decision-1', decisions: [{ approvalId: 'approval-1', approved: true }]
};
const continuation: ProviderContinuation = { providerId: 'openai', items: [{ kind: 'assistant_content' }] };
const outcome: ExternalWaitOutcome = 'approved';
const decision: GuardrailOutcome = { decision: 'allow' };
const config: GuardrailsConfig = { rails: {} };
// @ts-expect-error Static permissions use require_approval, not ask callbacks.
const permissions: AgentPermissions = { write: 'ask' };
declare const audit: GovernanceAuditRecord;
// @ts-expect-error Source identifiers live in safe evidence, not repeated event fields.
audit.policyId;
// @ts-expect-error Audit evidence does not carry inspected input.
audit.input;
void [createDecisionEvidence, DecisionBlockedError, DecisionEvaluationError, defineHarness,
  FakeModelProvider, defineGuardrails, openai, interrupt, resume, continuation, outcome, decision, config];
`;

/** Run all offline source, runtime, declaration and removed-API gates; retain artifacts only on failure. */
export async function verifyConsumers(workspaceRoot = defaultRoot) {
  const root = resolve(workspaceRoot);
  const harness = join(root, 'ai-harness');
  const artifacts = join(harness, '.artifacts/decision-consumers');
  await mkdir(artifacts, { recursive: true });
  const diagnostics = { workspaceRoot: root, resolutions: {}, checks: [] };
  const failures = [];
  const check = async (name, operation) => {
    try {
      await operation();
      diagnostics.checks.push({ name, status: 'passed' });
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(error);
      diagnostics.checks.push({ name, status: 'failed', message: error.message, exitCode: error.exitCode ?? 1 });
      console.error(`FAIL ${name}: ${error.message.split('\n')[0]}`);
    }
  };
  try {
    const tsPath = localTool(harness, 'typescript', 'lib/typescript.js', 'TypeScript');
    const ts = createRequire(import.meta.url)(tsPath);
    const aliases = mappings(root, 'src');
    const configs = [
      ['core', join(root, 'purista'), join(root, 'purista/packages/core/tsconfig.json'), [join(root, 'purista/packages/core/src/HarnessMount/**/*.ts')]],
    ];
    for (const [label, repo, original, include] of configs) {
      await check(`${label} source`, async () => {
        const config = createCompilerConfig(ts, original, artifacts, label, aliases, include);
        const configPath = join(artifacts, `${label}.json`);
        await writeFile(configPath, JSON.stringify(config, null, 2));
        const parsed = ts.parseJsonConfigFileContent(config, ts.sys, artifacts);
        diagnostics.resolutions[label] = assertLocalResolution(ts, parsed.options, join(artifacts, `${label}.ts`), aliases);
        await runCommand(process.execPath, [localTool(repo, 'typescript', 'lib/tsc.js', 'TypeScript'), '-p', configPath], {
          cwd: repo, log: join(artifacts, `${label}.log`),
        });
      });
    }
    await check('Core runtime tests', async () => {
      const purista = join(root, 'purista');
      const baseline = pathToFileURL(join(purista, 'vitest.config.unit.ts')).href;
      const configPath = join(artifacts, 'vitest.config.mts');
      await writeFile(configPath, `import baseline from ${JSON.stringify(baseline)};
const aliases = ${JSON.stringify(aliases)};
const inherited = baseline.resolve?.alias ?? [];
const existing = Array.isArray(inherited) ? inherited : Object.entries(inherited).map(([find, replacement]) => ({ find, replacement }));
export default {
  ...baseline,
  root: ${JSON.stringify(purista)},
  cacheDir: ${JSON.stringify(join(artifacts, 'vite'))},
  resolve: { ...baseline.resolve, alias: [
    ...Object.entries(aliases).map(([find, replacement]) => ({ find: new RegExp('^' + find + '$'), replacement })),
    ...existing,
  ] },
  test: { ...baseline.test, include: ['packages/core/src/HarnessMount/harnessMount.test.ts', 'packages/core/src/HarnessMount/invocation.test.ts', 'packages/core/src/HarnessMount/queue.test.ts', 'packages/core/src/HarnessMount/hostToolBuilder.test.ts'] },
};
`);
      await runCommand(process.execPath, [localTool(purista, 'vitest', 'vitest.mjs', 'Vitest'), 'run', '--configLoader', 'runner', '--config', configPath], {
        cwd: purista, log: join(artifacts, 'core-tests.log'),
      });
    });
    await check('built package declarations', async () => {
      await assertFreshBuild(root);
      const smoke = join(artifacts, 'declarations.ts');
      await writeFile(smoke, declarationConsumer);
      const distAliases = mappings(root, 'dist');
      const config = createCompilerConfig(ts, join(harness, 'packages/harness/tsconfig.json'), artifacts, 'declarations', distAliases, [smoke], { declarations: true });
      const configPath = join(artifacts, 'declarations.json');
      await writeFile(configPath, JSON.stringify(config, null, 2));
      const parsed = ts.parseJsonConfigFileContent(config, ts.sys, artifacts);
      diagnostics.resolutions.declarations = assertLocalResolution(ts, parsed.options, smoke, distAliases);
      await runCommand(process.execPath, [localTool(harness, 'typescript', 'lib/tsc.js', 'TypeScript'), '-p', configPath], {
        cwd: harness, log: join(artifacts, 'declarations.log'),
      });
    });
    await check('built package runtime imports', async () => {
      await assertFreshBuild(root);
      const aliases = Object.fromEntries(Object.entries(mappings(root, 'dist')).filter(([name]) => name !== '@purista/core')
        .map(([name, path]) => [name, pathToFileURL(path.replace(/\.d\.ts$/, '.js')).href]));
      const smoke = join(artifacts, 'runtime-smoke.mjs');
      await writeFile(smoke, `import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const aliases = ${JSON.stringify(aliases)};
const resolved = new Set();
registerHooks({ resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(aliases, specifier)) { resolved.add(specifier); return { url: aliases[specifier], shortCircuit: true }; }
  return nextResolve(specifier, context);
} });
const core = await import('@purista/harness');
const testing = await import('@purista/harness/testing');
const rails = await import('@purista/harness-guardrails');
const provider = await import('@purista/harness-openai');
for (const value of [core.createDecisionEvidence, core.DecisionBlockedError, core.DecisionEvaluationError, testing.FakeModelProvider, rails.defineGuardrails, provider.openai]) assert.equal(typeof value, 'function');
for (const name of ['AgentInterceptorError', 'PolicyEvaluationError']) assert.equal(name in core, false);
for (const name of ['GuardrailBlockedError', 'GuardrailEvaluationError', 'loadGuardrailsConfig', 'parseGuardrailsConfig']) assert.equal(name in rails, false);
assert.deepEqual([...resolved].sort(), Object.keys(aliases).sort());
console.log('Local built exports loaded:', [...resolved].sort().join(', '));
`);
      await runCommand(process.execPath, [smoke], { cwd: harness, log: join(artifacts, 'runtime-smoke.log') });
    });
    await check('Starter/create-purista removed APIs', async () => {
      const findings = await scanRemovedSymbols(ts, root);
      if (findings.length) throw new Error(findings.map(item => `${item.path}:${item.line} ${item.symbol}`).join('\n'));
    });
  } catch (error) {
    failures.push(error);
    diagnostics.checks.push({ name: 'setup', status: 'failed', message: error.message });
  }
  if (failures.length) {
    await writeFile(join(artifacts, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
    const error = new Error(`Consumer verification failed; diagnostics retained in ${artifacts}\n${failures.map(error => error.message.split('\n')[0]).join('\n')}`);
    error.exitCode = failures[0].exitCode ?? 1;
    throw error;
  }
  await rm(artifacts, { recursive: true, force: true });
  return diagnostics;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  const unknown = arguments_.filter(argument => argument.startsWith('-') && argument !== '--check');
  const roots = arguments_.filter(argument => argument !== '--check');
  if (unknown.length || roots.length > 1) {
    console.error('Usage: node verify-decision-consumers.mjs [workspace-root] [--check]');
    process.exitCode = 1;
  } else {
    try { await verifyConsumers(roots[0]); }
    catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
  }
}
