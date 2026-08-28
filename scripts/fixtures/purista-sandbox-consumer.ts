import { AgentQueueBuilder } from '@purista/core'
import { inMemorySandbox, type Sandbox } from '@purista/harness'

const sandbox: Sandbox = inMemorySandbox()
void sandbox
void AgentQueueBuilder

console.log('Packed PURISTA Core and Harness public package boundaries passed.')
