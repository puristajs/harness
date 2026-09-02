import { ServiceBuilder } from '@purista/core'
import { defineHarness, inMemorySandbox, type Sandbox } from '@purista/harness'

const sandbox: Sandbox = inMemorySandbox()
const harness = defineHarness({ name: 'packed-boundary' }).define()
void sandbox
void harness
void ServiceBuilder

console.log('Packed PURISTA Core and Harness public package boundaries passed.')
