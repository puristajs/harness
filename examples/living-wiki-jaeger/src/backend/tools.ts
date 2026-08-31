import { z } from 'zod'
import type { ToolHandlerContext } from '../../../../packages/harness/src/index.js'
import { createFileWikiStore, type FileWikiStore, slugSchema } from './data.js'

const pageRefSchema = z.object({ slug: slugSchema, title: z.string(), summary: z.string().optional() })
const panelSpecSchema = z.json()
const appendLogInputSchema = z.object({
  workflow: z.string().min(1),
  message: z.string().min(1),
  pages: z.array(slugSchema).optional(),
  sources: z.array(slugSchema).optional(),
})

export type PanelSpec = z.infer<typeof panelSpecSchema>

export function createLivingWikiTools(store: FileWikiStore = createFileWikiStore()) {
  return {
    read_source: {
      description: 'Read one source markdown file by URL-safe slug.',
      input: z.object({ slug: slugSchema }),
      output: z.object({ slug: slugSchema, title: z.string(), content: z.string() }),
      handler: async (ctx: ToolHandlerContext, input: { slug: string }) => {
        ctx.logger.info('Reading living wiki source.', { tool_id: ctx.toolId, slug: input.slug })
        const source = await store.readSource(input.slug)
        return { slug: source.slug, title: source.title, content: source.content }
      },
    },
    search_wiki: {
      description: 'Search wiki page titles and content.',
      input: z.object({ query: z.string().min(0) }),
      output: z.object({
        results: z.array(z.object({ slug: slugSchema, title: z.string(), snippet: z.string(), score: z.number() })),
      }),
      handler: async (ctx: ToolHandlerContext, input: { query: string }) => {
        ctx.logger.info('Searching living wiki.', { tool_id: ctx.toolId })
        return store.searchWiki(input.query)
      },
    },
    read_wiki_page: {
      description: 'Read one wiki page by URL-safe slug.',
      input: z.object({ slug: slugSchema }),
      output: z.object({ slug: slugSchema, title: z.string(), content: z.string() }),
      handler: async (ctx: ToolHandlerContext, input: { slug: string }) => {
        ctx.logger.info('Reading living wiki page.', { tool_id: ctx.toolId, slug: input.slug })
        const page = await store.readWikiPage(input.slug)
        return { slug: page.slug, title: page.title, content: page.content }
      },
    },
    write_wiki_page: {
      description: 'Create or replace one wiki page by URL-safe slug.',
      input: z.object({ slug: slugSchema, content: z.string().min(1) }),
      output: z.object({ slug: slugSchema, bytesWritten: z.number().int().nonnegative(), content: z.string() }),
      handler: async (ctx: ToolHandlerContext, input: { slug: string; content: string }) => {
        ctx.logger.info('Writing living wiki page.', { tool_id: ctx.toolId, slug: input.slug })
        return { ...(await store.writeWikiPage(input.slug, input.content)), content: input.content }
      },
    },
    append_log: {
      description: 'Append a timestamped operational entry to the wiki log.',
      input: appendLogInputSchema,
      output: z.object({ slug: z.literal('log'), bytesWritten: z.number().int().nonnegative() }),
      handler: async (
        ctx: ToolHandlerContext,
        input: z.output<typeof appendLogInputSchema>,
      ) => {
        ctx.logger.info('Appending living wiki log.', { tool_id: ctx.toolId, workflow: input.workflow })
        return store.appendLog({
          workflow: input.workflow,
          message: input.message,
          ...(input.pages ? { pages: input.pages } : {}),
          ...(input.sources ? { sources: input.sources } : {}),
        })
      },
    },
    list_backlinks: {
      description: 'List pages containing an exact [[slug]] wiki link.',
      input: z.object({ slug: slugSchema }),
      output: z.object({ pages: z.array(pageRefSchema), backlinks: z.array(pageRefSchema).optional() }),
      handler: async (ctx: ToolHandlerContext, input: { slug: string }) => {
        ctx.logger.info('Listing living wiki backlinks.', { tool_id: ctx.toolId, slug: input.slug })
        const { pages } = await store.listBacklinks(input.slug)
        return { pages, backlinks: pages }
      },
    },
    render_panel_spec: {
      description: 'Validate and return a JSON-renderer-compatible panel specification.',
      input: z.object({ panelSpec: panelSpecSchema }),
      output: z.object({ panelSpec: panelSpecSchema }),
      handler: async (_ctx: ToolHandlerContext, input: { panelSpec: PanelSpec }) => input,
    },
  }
}

export function makePanelSpec(title: string, sections: Array<{ heading: string; items: string[] }>): PanelSpec {
  return panelSpecSchema.parse({ version: '1.0', title, sections })
}
