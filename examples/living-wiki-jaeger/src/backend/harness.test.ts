import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { createLivingWikiHarness, createScriptedLivingWikiProvider } from './harness.js'
import { reviewRequestSchema } from './schemas.js'

async function createFixture(): Promise<{ dataRoot: string; skillDirectory: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'living-wiki-harness-'))
  const dataRoot = join(root, 'data')
  const skillDirectory = join(root, 'skills/wiki-curator')
  await mkdir(join(dataRoot, 'raw/sources'), { recursive: true })
  await mkdir(join(dataRoot, 'wiki'), { recursive: true })
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), [
    '---',
    'name: wiki-curator',
    'description: Curate compact linked wiki pages.',
    '---',
    'Keep pages compact and preserve source references.'
  ].join('\n'))
  await writeFile(join(dataRoot, 'raw/sources/jaeger.md'), '# Jaeger Source\n\nJaeger stores traces.\n')
  await writeFile(join(dataRoot, 'wiki/index.md'), '# Index\n')
  await writeFile(join(dataRoot, 'wiki/log.md'), '# Log\n')
  await writeFile(join(dataRoot, 'wiki/jaeger.md'), '# Jaeger\n\nTrace storage.\n')

  return {
    dataRoot,
    skillDirectory,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

describe('living wiki harness workflows', () => {
  test('defaults review questions to required when model output omits the field', () => {
    const parsed = reviewRequestSchema.parse({
      id: 'review-default-required',
      runId: 'run-1',
      title: 'Review generated changes',
      reason: 'Model omitted required flags.',
      questions: [
        { id: 'approval', label: 'Approve changes?', kind: 'approval' },
        { id: 'guidance', label: 'Guidance', kind: 'free_text' }
      ],
      defaultDecision: 'approve'
    })

    expect(parsed.questions.map((question) => question.required)).toEqual([true, true])
  })

  test('runs all workflow contracts with a fake provider and no OpenAI calls', async () => {
    const fixture = await createFixture()
    const provider = createScriptedLivingWikiProvider()
    const { harness } = createLivingWikiHarness({
      dataRoot: fixture.dataRoot,
      skillDirectory: fixture.skillDirectory,
      provider,
      model: 'fake-wiki-model'
    })

    try {
      const session = await harness.getSession('test-session')

      await expect((session.workflows['ingest_source'] as any).run({ sourceSlug: 'jaeger' })).resolves.toMatchObject({
        updatedPages: expect.arrayContaining(['jaeger']),
        extractedConcepts: expect.arrayContaining(['jaeger'])
      })
      await expect((session.workflows['ask_wiki'] as any).run({ question: 'What stores traces?' })).resolves.toMatchObject({
        citedPages: expect.arrayContaining(['jaeger'])
      })
      await expect((session.workflows['lint_wiki'] as any).run({ scope: 'all' })).resolves.toMatchObject({
        panelSpec: expect.any(Object)
      })
      await expect((session.workflows['reconcile_contradiction'] as any).run({
        leftRef: 'jaeger',
        rightRef: 'index',
        conflict: 'Trace backend wording differs.'
      })).resolves.toMatchObject({
        changedPages: expect.any(Array)
      })
      await expect((session.workflows['generate_research_brief'] as any).run({
        pageSlugs: ['jaeger'],
        goal: 'Explain tracing.'
      })).resolves.toMatchObject({
        citedPages: ['jaeger'],
        panelSpec: expect.any(Object),
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: 'markdown', content: expect.stringContaining('Research Brief') }),
          expect.objectContaining({ kind: 'mermaid', content: expect.stringContaining('graph LR') }),
          expect.objectContaining({ kind: 'drawio_xml', content: expect.stringContaining('<mxGraphModel') }),
          expect.objectContaining({ kind: 'json_panel', panelSpec: expect.any(Object) })
        ])
      })

      const memo = await (session.workflows['decision_memo'] as any).run({
        proposal: 'adopt Jaeger tracing',
        question: 'Should we adopt Jaeger tracing?'
      })
      expect(memo).toMatchObject({
        markdown: expect.stringContaining('Decision Memo'),
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: 'markdown', content: expect.stringContaining('Decision Memo') }),
          expect.objectContaining({ kind: 'mermaid', content: expect.stringContaining('Decision') }),
          expect.objectContaining({ kind: 'drawio_xml', content: expect.stringContaining('<mxfile') }),
          expect.objectContaining({ kind: 'json_panel', panelSpec: expect.any(Object) })
        ])
      })

      const review = await (session.workflows['architecture_review'] as any).run({
        sourceSlug: 'jaeger',
        focus: 'trace observability'
      })
      expect(review).toMatchObject({
        markdown: expect.stringContaining('Architecture Review'),
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: 'markdown', content: expect.stringContaining('Architecture Review') }),
          expect.objectContaining({ kind: 'mermaid', content: expect.stringContaining('Architecture') }),
          expect.objectContaining({ kind: 'drawio_xml', content: expect.stringContaining('<mxGraphModel') }),
          expect.objectContaining({ kind: 'json_panel', panelSpec: expect.any(Object) })
        ])
      })

      expect(provider.requests.length).toBeGreaterThanOrEqual(5)
    } finally {
      await harness.shutdown()
      await fixture.cleanup()
    }
  })
})
