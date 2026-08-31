import { dirname } from 'node:path'

/** Metadata required to invoke one Pi skill without exposing its source to the browser. */
export type SkillCommandInfo = {
  readonly name: string
  readonly source: 'extension' | 'prompt' | 'skill'
  readonly sourceInfo: {
    readonly baseDir?: string
    readonly path: string
  }
}

const skillCommandNamePattern = /^skill:[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The extension command that reloads the current Pi runtime. */
export const reloadRuntimeCommandName = 'reload-runtime'

/** Return whether a Pi command is safe to expose in the web composer. */
export function isSupportedWebCommand(command: SkillCommandInfo): boolean {
  return isSupportedSkillCommand(command) || (
    command.source === 'extension'
    && command.name === reloadRuntimeCommandName
  )
}

/** Return whether a Pi command is a safe, standards-compliant skill command. */
export function isSupportedSkillCommand(command: SkillCommandInfo): boolean {
  return command.source === 'skill' &&
    command.name.length <= 'skill:'.length + 64 &&
    skillCommandNamePattern.test(command.name)
}

/**
 * Expand an exact listed skill invocation for Pi's extension message API.
 *
 * Pi's `sendUserMessage()` deliberately skips native skill expansion. This
 * function reproduces the native skill block for only a command that Pi lists
 * with the `skill` source. The outer marker lets browser normalization restore
 * the short invocation without parsing or exposing the skill body.
 *
 * @param content - The bounded browser message.
 * @param commands - Commands reported by the connected Pi session.
 * @param readSkill - The trusted host-side skill file reader.
 * @param stripSkillFrontmatter - Pi's public frontmatter removal helper.
 * @returns Expanded content, or `undefined` when the text is not a listed skill invocation.
 */
export async function expandSkillInvocation(
  content: string,
  commands: ReadonlyArray<SkillCommandInfo>,
  readSkill: (path: string) => Promise<string>,
  stripSkillFrontmatter: (content: string) => string,
): Promise<string | undefined> {
  const match = /^\/(skill:[^\s]+)(?:\s+([\s\S]*))?$/.exec(content)
  const name = match?.[1]
  if (name === undefined) {
    return undefined
  }
  const skill = commands.find(
    (candidate) => isSupportedSkillCommand(candidate) && candidate.name === name,
  )
  if (skill === undefined) {
    return undefined
  }

  const body = stripSkillFrontmatter(await readSkill(skill.sourceInfo.path)).trim()
  const skillName = skill.name.slice('skill:'.length)
  const baseDir = skill.sourceInfo.baseDir ?? dirname(skill.sourceInfo.path)
  const argumentsText = match?.[2]?.trim() ?? ''
  const skillBlock = `<skill name="${skillName}" location="${skill.sourceInfo.path}">\n<!-- web-herdr-skill:${skill.name} -->\nReferences are relative to ${baseDir}.\n\n${body}\n<!-- /web-herdr-skill -->\n</skill>`
  return `${skillBlock}${argumentsText.length === 0 ? '' : `\n\n${argumentsText}`}`
}
