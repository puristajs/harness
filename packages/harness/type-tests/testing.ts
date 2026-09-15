import { z } from 'zod'

import { defineTool } from '../src/definitions/index.js'
import { createToolTestContext, FakeModelProvider, objectReply, textReply } from '../src/testing/index.js'

const plain = defineTool('plain', {
	description: 'Return text.', input: z.string(), output: z.string(),
	async handler(context, input) {
		context.logger.info('called')
		// @ts-expect-error undeclared memory is absent from the handler context
		context.memory
		return input
	},
})
const plainContext = createToolTestContext(plain)
const plainToolId: 'plain' = plainContext.toolId

const memoryTool = defineTool('memoryTool', {
	description: 'Read memory.', input: z.string(), output: z.string(),
	requires: { memory: ['memory.kv'] as const },
	async handler(context, input) {
		await context.memory.session.read(input)
		// @ts-expect-error undeclared sandbox is absent from the handler context
		context.sandbox
		return input
	},
})
// @ts-expect-error required memory facade must be provided for a memory Tool test
createToolTestContext(memoryTool)
createToolTestContext(memoryTool, { memory: undefined as never })

const text = textReply('done')
const object = objectReply({ status: 'ready' as const })
const exactText: string = text.content
const exactStatus: 'ready' = object.object.status
const provider = new FakeModelProvider({ strict: true })
provider.enqueueObject(object)
// @ts-expect-error the ambiguous legacy enqueue alias is intentionally absent
provider.enqueue(object)
void exactText
void exactStatus
void plainToolId
