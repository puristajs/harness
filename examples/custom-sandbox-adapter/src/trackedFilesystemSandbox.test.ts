import { sandboxContract } from '@purista/harness/testing'

import { TrackedFilesystemSandbox } from './trackedFilesystemSandbox.js'

sandboxContract(
  () => new TrackedFilesystemSandbox(),
  { executor: 'unavailable' },
)
