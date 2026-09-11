import {
  inMemorySandbox,
  type Sandbox,
  type SandboxOpenOptions,
  type SandboxOpenResult,
  type SandboxOwnerRegistrationOptions,
  type SandboxTerminateOptions,
} from '@purista/harness'

export class TrackedFilesystemSandbox implements Sandbox<readonly ['sandbox.fs']> {
  private readonly delegate = inMemorySandbox()

  public readonly capabilities = ['sandbox.fs'] as const
  public readonly telemetryAdapterId = 'tracked_filesystem'
  public readonly administration = this.delegate.administration
  public readonly operations = { registered: 0, opened: 0, terminated: 0 }

  public async registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void> {
    this.operations.registered += 1
    await this.delegate.registerOwner(options)
  }

  public async open(
    options: SandboxOpenOptions,
  ): Promise<SandboxOpenResult<readonly ['sandbox.fs']>> {
    this.operations.opened += 1
    return await this.delegate.open(options)
  }

  public async terminate(options: SandboxTerminateOptions): Promise<void> {
    this.operations.terminated += 1
    await this.delegate.terminate(options)
  }
}
