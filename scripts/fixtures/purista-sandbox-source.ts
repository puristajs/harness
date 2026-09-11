import { inMemorySandbox, type Sandbox } from '@purista/harness'

/** Compiled inside staged Core to prove public Harness resolution without an alias. */
export const sourceSandbox: Sandbox = inMemorySandbox()
