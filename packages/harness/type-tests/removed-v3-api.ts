// This is the single intentional source reference to removed v3 public names.
// Each directive proves that the package root no longer exports that API.
// @ts-expect-error BuilderState was removed by the v4 clean break.
import type { BuilderState } from '../src/index.js'
// @ts-expect-error HarnessModule was removed by the v4 clean break.
import type { HarnessModule } from '../src/index.js'
// @ts-expect-error RunEvent was replaced by ExecutionEvent.
import type { RunEvent } from '../src/index.js'
// @ts-expect-error defineHarnessModule was removed by the v4 clean break.
import { defineHarnessModule } from '../src/index.js'

void (0 as unknown as BuilderState)
void (0 as unknown as HarnessModule)
void (0 as unknown as RunEvent)
void defineHarnessModule
