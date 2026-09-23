import type { ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { reloadRuntimeCommandName } from './skill-invocation'

type ReloadApi = {
  readonly registerCommand: (name: string, options: {
    readonly description: string
    readonly handler: (args: string, ctx: Pick<ExtensionCommandContext, 'reload'>) => Promise<void>
  }) => void
  readonly getCommands: () => ReadonlyArray<{ readonly name: string; readonly source: string }>
  readonly sendUserMessage: (content: string, options: { readonly expandPromptTemplates: true }) => void
}

/** The explicit reload capability. Browser text is never accepted as command input. */
export class ReloadRuntime {
  private requested = false

  constructor(private readonly pi: ReloadApi) {
    pi.registerCommand(reloadRuntimeCommandName, {
      description: 'Reload Pi extensions, skills, prompts, themes, and context files',
      handler: async (_args, ctx) => {
        await ctx.reload()
        return
      },
    })
  }

  /** Report acceptance before dispatch can unload the relay. Success means requested, not completed. */
  request(
    ctx: Pick<ExtensionContext, 'isIdle' | 'hasPendingMessages'>,
    compacting: boolean,
    onAccepted: () => void,
  ): 'requested' | 'busy' | 'unavailable' {
    if (this.requested || !ctx.isIdle() || compacting || ctx.hasPendingMessages()) return 'busy'
    // A command collision can remove the unsuffixed invocation. Never let it fall through to the model.
    if (!this.pi.getCommands().some((command) =>
      command.source === 'extension' && command.name === reloadRuntimeCommandName,
    )) return 'unavailable'
    this.requested = true
    onAccepted()
    // Pi 0.85 defaults this flag to false, including for exact slash commands.
    this.pi.sendUserMessage(`/${reloadRuntimeCommandName}`, { expandPromptTemplates: true })
    return 'requested'
  }
}
