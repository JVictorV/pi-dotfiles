import { createHash } from 'node:crypto'

/** Maximum text retained from one Pi field before relay serialization. */
export const MAXIMUM_RELAY_TEXT_LENGTH = 16_000

/** Maximum UTF-8 size of one normalized active-branch snapshot. */
export const MAXIMUM_RELAY_SNAPSHOT_BYTES = 1_500_000
/** Maximum available model references sent with one model catalogue event. */
export const MAXIMUM_RELAY_MODEL_OPTIONS = 1_024
const MAXIMUM_RELAY_IMAGE_BYTES = 5 * 1024 * 1024
const MAXIMUM_RELAY_IMAGE_BASE64_LENGTH = Math.ceil(MAXIMUM_RELAY_IMAGE_BYTES / 3) * 4

type RelayImageMetadata = {
  readonly contentHash?: string
  readonly mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
}

// Weak keys prevent cached hashes from extending the lifetime of Pi image blocks.
const imageContentHashes = new WeakMap<object, string | null>()

/** One browser-safe model reference available to the current Pi session. */
export type RelayModelOption = {
  readonly id: string
  readonly provider: string
}

/** A browser-safe transcript message. */
export type RelayMessage = {
  readonly compaction?: { readonly tokensBefore: number }
  readonly id: string
  readonly images?: ReadonlyArray<RelayImageMetadata>
  readonly isError?: boolean
  readonly role: 'user' | 'assistant' | 'tool' | 'system'
  readonly text: string
  readonly thinking?: string
  readonly timestamp: number
  readonly toolCallId?: string
}

/** A bounded applied diff from one completed Edit execution. */
export type RelayEditDiff = {
  readonly text: string
  readonly truncated: boolean
}

/** Pi-side truncation metadata for one bounded text tool result. */
export type RelayToolTruncation = {
  readonly firstLineExceedsLimit: boolean
  readonly maxBytes: number
  readonly maxLines: number
  readonly outputBytes: number
  readonly outputLines: number
  readonly totalBytes: number
  readonly totalLines: number
  readonly truncatedBy: 'bytes' | 'lines'
}

/** Browser-safe metadata for one completed Read result. */
export type RelayReadResult =
  | {
    readonly _tag: 'Image'
    readonly mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
    readonly relayTextTruncated: boolean
  }
  | {
    readonly _tag: 'Text'
    readonly relayTextTruncated: boolean
    readonly truncation?: RelayToolTruncation
  }

/** Browser-safe metadata for one completed Find or Grep result. */
export type RelaySearchResult =
  | {
    readonly _tag: 'Find'
    readonly relayTextTruncated: boolean
    readonly resultLimitReached?: number
    readonly truncation?: RelayToolTruncation
  }
  | {
    readonly _tag: 'Grep'
    readonly linesTruncated: boolean
    readonly matchLimitReached?: number
    readonly relayTextTruncated: boolean
    readonly truncation?: RelayToolTruncation
  }

/** Browser-safe metadata for one Write tool target. */
export type RelayWriteResult = {
  readonly path: string
  readonly size: number
  readonly state: 'pending' | 'available' | 'unavailable'
}

/** A browser-safe tool execution. */
export type RelayTool = {
  readonly detail?: string
  readonly detailTruncated?: boolean
  readonly editDiff?: RelayEditDiff
  readonly id: string
  readonly input?: string
  readonly isError?: boolean
  readonly name: string
  readonly readResult?: RelayReadResult
  readonly searchResult?: RelaySearchResult
  readonly status: 'running' | 'complete'
  readonly timestamp: number
  readonly writeResult?: RelayWriteResult
}

/** A normalized active Pi branch. */
export type RelaySnapshot = {
  readonly messages: ReadonlyArray<RelayMessage>
  readonly tools: ReadonlyArray<RelayTool>
}

/** Normalize, deduplicate, sort, and bound model references for browser autocomplete. */
export function normalizeModelOptions(
  models: ReadonlyArray<{ readonly id: string; readonly provider: string }>,
): ReadonlyArray<RelayModelOption> {
  const options = new Map<string, RelayModelOption>()
  for (const model of models) {
    const id = boundedText(model.id, 256).trim()
    const provider = boundedText(model.provider, 128).trim()
    if (id.length === 0 || provider.length === 0) continue
    const key = `${provider}\u0000${id}`
    if (!options.has(key)) options.set(key, { id, provider })
  }
  return [...options.values()]
    .sort((left, right) => left.provider.localeCompare(right.provider, 'en-US') || left.id.localeCompare(right.id, 'en-US'))
    .slice(0, MAXIMUM_RELAY_MODEL_OPTIONS)
}

function boundText(
  value: string,
  maximum: number,
  sessionPaths: ReadonlyArray<string>,
): { readonly text: string; readonly truncated: boolean } {
  const withoutControls = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
  const withoutSessionPaths = sessionPaths.reduce(
    (text, path) => path.length === 0
      ? text
      : text.replaceAll(path, '[redacted session path]'),
    withoutControls,
  )
  const withoutUploadPaths = withoutSessionPaths.replace(
    /(^|[^A-Za-z0-9./\\-])((?:[A-Za-z]:)?(?:[/\\][^/\\\r\n"'`]+)*[/\\]web-herdr-uploads-[A-Za-z0-9_-]+[/\\](?:command-[A-Za-z0-9_-]+[/\\])?(?:(?:write-)?[0-9a-f-]{36}(?:-|\.[A-Za-z0-9]{1,16})?)?)/gm,
    '$1[redacted uploaded file path]/',
  )
  const normalized = withoutUploadPaths.replace(
    /full output saved to:\s*[^\s)\]}>,]+/giu,
    'full output saved to: [redacted output path]',
  )
  const codePoints = Array.from(normalized)
  return {
    text: codePoints.slice(0, maximum).join(''),
    truncated: codePoints.length > maximum,
  }
}

/** Limit text without splitting surrogate pairs or retaining control sequences. */
export function boundedText(
  value: string,
  maximum = MAXIMUM_RELAY_TEXT_LENGTH,
  sessionPaths: ReadonlyArray<string> = [],
): string {
  return boundText(value, maximum, sessionPaths).text
}

/** Extract a bounded applied diff only from Edit tool result details. */
export function extractEditDiff(
  toolName: string,
  details: unknown,
  sessionPaths: ReadonlyArray<string> = [],
): RelayEditDiff | undefined {
  if (toolName.toLocaleLowerCase('en-US') !== 'edit') return undefined
  const diff = asRecord(details)?.diff
  if (typeof diff !== 'string') return undefined
  return boundText(diff, MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths)
}

function extractTextBlocks(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  return value
    .flatMap((block) => {
      const record = asRecord(block)
      return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : []
    })
    .join('')
}

/** Extract bounded tool detail text and report whether the relay shortened it. */
export function extractToolDetail(
  value: unknown,
  sessionPaths: ReadonlyArray<string> = [],
): { readonly text: string; readonly truncated: boolean } {
  return boundText(extractTextBlocks(value), MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths)
}

/** Extract safe text blocks and ignore image bytes, signatures, and unknown metadata. */
export function extractText(
  value: unknown,
  sessionPaths: ReadonlyArray<string> = [],
): string {
  return extractToolDetail(value, sessionPaths).text
}

/** Extract browser-safe metadata only from Read tool results. */
export function extractReadResult(
  toolName: string,
  content: unknown,
  details: unknown,
  sessionPaths: ReadonlyArray<string> = [],
): RelayReadResult | undefined {
  if (toolName.toLocaleLowerCase('en-US') !== 'read') return undefined
  const bounded = boundText(extractTextBlocks(content), MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths)
  const imageMimeType = firstImageMimeType(content)
  if (imageMimeType !== undefined) {
    return { _tag: 'Image', mimeType: imageMimeType, relayTextTruncated: bounded.truncated }
  }
  const truncation = extractTruncation(details)
  return {
    _tag: 'Text',
    relayTextTruncated: bounded.truncated,
    ...(truncation === undefined ? {} : { truncation }),
  }
}

/** Extract browser-safe result metadata only from Find and Grep tools. */
export function extractSearchResult(
  toolName: string,
  content: unknown,
  details: unknown,
  sessionPaths: ReadonlyArray<string> = [],
): RelaySearchResult | undefined {
  const normalizedName = toolName.toLocaleLowerCase('en-US')
  if (normalizedName !== 'find' && normalizedName !== 'grep') return undefined
  const record = asRecord(details)
  const bounded = boundText(extractTextBlocks(content), MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths)
  const truncation = extractTruncation(details)
  if (normalizedName === 'find') {
    const resultLimitReached = nonnegativeSafeInteger(record?.resultLimitReached)
    return {
      _tag: 'Find',
      relayTextTruncated: bounded.truncated,
      ...(resultLimitReached === undefined ? {} : { resultLimitReached }),
      ...(truncation === undefined ? {} : { truncation }),
    }
  }
  const matchLimitReached = nonnegativeSafeInteger(record?.matchLimitReached)
  return {
    _tag: 'Grep',
    linesTruncated: record?.linesTruncated === true,
    ...(matchLimitReached === undefined ? {} : { matchLimitReached }),
    relayTextTruncated: bounded.truncated,
    ...(truncation === undefined ? {} : { truncation }),
  }
}

function extractTruncation(details: unknown): RelayToolTruncation | undefined {
  const truncationRecord = asRecord(asRecord(details)?.truncation)
  const truncatedBy = truncationRecord?.truncatedBy
  const firstLineExceedsLimit = truncationRecord?.firstLineExceedsLimit
  const maxBytes = nonnegativeSafeInteger(truncationRecord?.maxBytes)
  const maxLines = nonnegativeSafeInteger(truncationRecord?.maxLines)
  const outputBytes = nonnegativeSafeInteger(truncationRecord?.outputBytes)
  const outputLines = nonnegativeSafeInteger(truncationRecord?.outputLines)
  const totalBytes = nonnegativeSafeInteger(truncationRecord?.totalBytes)
  const totalLines = nonnegativeSafeInteger(truncationRecord?.totalLines)
  return truncationRecord?.truncated === true &&
    (truncatedBy === 'bytes' || truncatedBy === 'lines') &&
    typeof firstLineExceedsLimit === 'boolean' &&
    maxBytes !== undefined &&
    maxLines !== undefined &&
    outputBytes !== undefined &&
    outputLines !== undefined &&
    totalBytes !== undefined &&
    totalLines !== undefined
      ? { firstLineExceedsLimit, maxBytes, maxLines, outputBytes, outputLines, totalBytes, totalLines, truncatedBy }
      : undefined
}

function extractImageMetadata(
  value: unknown,
): ReadonlyArray<RelayImageMetadata> {
  if (!Array.isArray(value)) {
    return []
  }
  const images: RelayImageMetadata[] = []
  for (const block of value) {
    if (images.length >= 4) {
      break
    }
    if (typeof block !== 'object' || block === null) {
      continue
    }
    const record = asRecord(block)
    if (record?.type !== 'image' || !isImageMimeType(record.mimeType)) {
      continue
    }
    const contentHash = imageContentHash(block, record.data)
    images.push({
      ...(contentHash === undefined ? {} : { contentHash }),
      mimeType: record.mimeType,
    })
  }
  return images
}

function firstImageMimeType(
  value: unknown,
): RelayImageMetadata['mimeType'] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  for (const block of value) {
    const record = asRecord(block)
    if (record?.type === 'image' && isImageMimeType(record.mimeType)) {
      return record.mimeType
    }
  }
  return undefined
}

function imageContentHash(key: object, data: unknown): string | undefined {
  const cached = imageContentHashes.get(key)
  if (cached !== undefined) {
    return cached === null ? undefined : cached
  }
  if (
    typeof data !== 'string' ||
    data.length < 4 ||
    data.length > MAXIMUM_RELAY_IMAGE_BASE64_LENGTH ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    imageContentHashes.set(key, null)
    return undefined
  }
  const contentHash = createHash('sha256').update(data, 'base64').digest('hex')
  imageContentHashes.set(key, contentHash)
  return contentHash
}

/** Extract safe assistant thinking blocks without provider payloads or signatures. */
export function extractThinking(
  value: unknown,
  sessionPaths: ReadonlyArray<string> = [],
): string | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const thinking = boundedText(
    value
      .flatMap((block) => {
        const record = asRecord(block)
        return record?.type === 'thinking' && typeof record.thinking === 'string'
          ? [record.thinking]
          : []
      })
      .join(''),
    MAXIMUM_RELAY_TEXT_LENGTH,
    sessionPaths,
  )
  return thinking.length === 0 ? undefined : thinking
}

function collapseExpandedSkill(text: string): string {
  const marked = /^<skill[\s\S]*\n<!-- web-herdr-skill:(skill:[a-z0-9]+(?:-[a-z0-9]+)*) -->\n[\s\S]*\n<!-- \/web-herdr-skill -->\n<\/skill>(?:\n\n([\s\S]*))?$/.exec(text)
  if (marked !== null && marked[1] !== undefined) {
    const argumentsText = marked[2]?.trim() ?? ''
    return `/${marked[1]}${argumentsText.length === 0 ? '' : ` ${argumentsText}`}`
  }

  const native = /^<skill name="([a-z0-9]+(?:-[a-z0-9]+)*)"[\s\S]*\n<\/skill>(?:\n\n([\s\S]*))?$/.exec(text)
  if (native !== null && native[1] !== undefined) {
    const argumentsText = native[2]?.trim() ?? ''
    return `/skill:${native[1]}${argumentsText.length === 0 ? '' : ` ${argumentsText}`}`
  }
  return text.startsWith('<skill ') ? '/skill:[redacted malformed expansion]' : text
}

function collapseUploadedFiles(text: string): string {
  const matched = /^<web-herdr-files>\nThe following user-uploaded files are available locally:\n([\s\S]*?)\n<\/web-herdr-files>(?:\n\n([\s\S]*))?$/.exec(text)
  if (matched === null || matched[1] === undefined) {
    return text.startsWith('<web-herdr-files>')
      ? 'Attached files: [redacted malformed attachment metadata]'
      : collapseExpandedSkill(text)
  }
  const names = matched[1]
    .split('\n')
    .flatMap((line) => {
      const separator = line.indexOf('\t')
      const name = separator < 1 ? undefined : line.slice(0, separator).trim()
      return name === undefined || name.length === 0 ? [] : [name]
    })
  if (names.length === 0) {
    return 'Attached files: [redacted malformed attachment metadata]'
  }
  const summary = `Attached files:\n${names.map((name) => `- ${name}`).join('\n')}`
  const content = collapseExpandedSkill(matched[2]?.trim() ?? '')
  return content.length === 0 ? summary : `${summary}\n\n${content}`
}

/** Normalize a persisted or streaming Pi message for browser display. */
export function normalizeMessage(
  id: string,
  message: unknown,
  fallbackTimestamp: number,
  sessionPaths: ReadonlyArray<string> = [],
): RelayMessage | undefined {
  const record = asRecord(message)
  if (record === undefined || typeof record.role !== 'string') {
    return undefined
  }
  const timestamp = numberOr(record.timestamp, fallbackTimestamp)
  if (record.role === 'user') {
    const images = extractImageMetadata(record.content)
    return createMessage(
      id,
      'user',
      boundedText(
        collapseUploadedFiles(extractTextBlocks(record.content)),
        MAXIMUM_RELAY_TEXT_LENGTH,
        sessionPaths,
      ),
      timestamp,
      images.length === 0 ? undefined : { images },
    )
  }
  if (record.role === 'assistant') {
    const thinking = extractThinking(record.content, sessionPaths)
    return createMessage(
      id,
      'assistant',
      extractText(record.content, sessionPaths),
      timestamp,
      thinking === undefined ? undefined : { thinking },
    )
  }
  if (record.role === 'toolResult') {
    const toolCallId = stringOrUndefined(record.toolCallId)
    return createMessage(
      id,
      'tool',
      extractText(record.content, sessionPaths),
      timestamp,
      toolCallId === undefined
        ? { isError: record.isError === true }
        : { isError: record.isError === true, toolCallId },
    )
  }
  if (record.role === 'custom' && record.display === true) {
    return createMessage(
      id,
      'system',
      extractText(record.content, sessionPaths),
      timestamp,
    )
  }
  return undefined
}

/** Extract Write target metadata without retaining its potentially large content. */
export function extractWriteResult(
  toolName: string,
  input: unknown,
  state: RelayWriteResult['state'],
  sessionPaths: ReadonlyArray<string> = [],
): RelayWriteResult | undefined {
  if (toolName.toLocaleLowerCase('en-US') !== 'write') return undefined
  const record = asRecord(input)
  if (
    typeof record?.path !== 'string' ||
    record.path.length === 0 ||
    record.path.length > 4_096 ||
    record.path.includes('\u0000') ||
    typeof record.content !== 'string'
  ) return undefined
  return {
    path: boundedText(record.path, 4_096, sessionPaths),
    size: Buffer.byteLength(record.content, 'utf8'),
    state,
  }
}

/** Serialize bounded tool input while omitting values that are not JSON data. */
export function serializeToolInput(
  input: unknown,
  sessionPaths: ReadonlyArray<string> = [],
): string | undefined {
  try {
    const serialized = JSON.stringify(input, undefined, 2)
    return serialized === undefined
      ? undefined
      : boundedText(serialized, MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths)
  } catch {
    return undefined
  }
}

/** Normalize tool calls and their browser-safe input from an assistant message. */
export function normalizeToolCalls(
  message: unknown,
  fallbackTimestamp: number,
  sessionPaths: ReadonlyArray<string> = [],
): ReadonlyArray<RelayTool> {
  const record = asRecord(message)
  if (record === undefined || !Array.isArray(record.content)) {
    return []
  }
  const timestamp = numberOr(record.timestamp, fallbackTimestamp)
  return record.content.flatMap((block) => {
    const toolCall = asRecord(block)
    if (
      toolCall?.type !== 'toolCall' ||
      typeof toolCall.id !== 'string' ||
      typeof toolCall.name !== 'string'
    ) {
      return []
    }
    const writeResult = extractWriteResult(toolCall.name, toolCall.arguments, 'pending', sessionPaths)
    const input = toolCall.name.toLocaleLowerCase('en-US') === 'write'
      ? undefined
      : serializeToolInput(toolCall.arguments, sessionPaths)
    return [
      {
        id: boundedIdentifier(toolCall.id, 'tool'),
        ...(input === undefined ? {} : { input }),
        name: boundedText(toolCall.name, 128),
        status: 'running' as const,
        timestamp,
        ...(writeResult === undefined ? {} : { writeResult }),
      },
    ]
  })
}

/** Build a bounded snapshot from `buildContextEntries()` without reading session JSONL. */
export function normalizeActiveBranch(
  entries: unknown,
  fallbackTimestamp: number,
  sessionPaths: ReadonlyArray<string> = [],
): RelaySnapshot {
  if (!Array.isArray(entries)) {
    return { messages: [], tools: [] }
  }

  const messages: RelayMessage[] = []
  const tools = new Map<string, RelayTool>()
  for (const record of retainRenderableEntries(entries)) {
    const timestamp = timestampForEntry(record, fallbackTimestamp)
    if (record.type === 'message') {
      const message = normalizeMessage(
        boundedIdentifier(record.id, 'entry'),
        record.message,
        timestamp,
        sessionPaths,
      )
      if (
        message !== undefined &&
        (message.text.length > 0 || message.thinking !== undefined || message.images !== undefined)
      ) {
        messages.push(message)
      }
      for (const tool of normalizeToolCalls(record.message, timestamp, sessionPaths)) {
        tools.set(tool.id, tool)
      }
      const persisted = asRecord(record.message)
      if (persisted?.role === 'toolResult' && typeof persisted.toolCallId === 'string') {
        const toolId = boundedIdentifier(persisted.toolCallId, 'tool')
        const current = tools.get(toolId)
        const toolName = current?.name ?? boundedText(String(persisted.toolName ?? 'tool'), 128)
        const detail = extractToolDetail(persisted.content, sessionPaths)
        const editDiff = extractEditDiff(toolName, persisted.details, sessionPaths)
        const readResult = extractReadResult(toolName, persisted.content, persisted.details, sessionPaths)
        const searchResult = extractSearchResult(toolName, persisted.content, persisted.details, sessionPaths)
        const writeResult = current?.writeResult === undefined
          ? undefined
          : { ...current.writeResult, state: persisted.isError === true ? 'unavailable' as const : 'available' as const }
        tools.set(toolId, {
          detail: detail.text,
          detailTruncated: detail.truncated,
          ...(editDiff === undefined ? {} : { editDiff }),
          id: toolId,
          ...(current?.input === undefined ? {} : { input: current.input }),
          isError: persisted.isError === true,
          name: toolName,
          ...(readResult === undefined ? {} : { readResult }),
          ...(searchResult === undefined ? {} : { searchResult }),
          status: 'complete',
          timestamp,
          ...(writeResult === undefined ? {} : { writeResult }),
        })
      }
      continue
    }
    if (
      record.type === 'custom_message' &&
      record.display === true
    ) {
      const text = extractText(record.content, sessionPaths)
      if (text.length > 0) {
        messages.push({
          id: boundedIdentifier(record.id, 'custom'),
          role: 'system',
          text,
          timestamp,
        })
      }
      continue
    }
    if (record.type === 'compaction' && typeof record.summary === 'string') {
      const tokensBefore = nonnegativeSafeInteger(record.tokensBefore)
      messages.push({
        ...(tokensBefore === undefined ? {} : { compaction: { tokensBefore } }),
        id: boundedIdentifier(record.id, 'compaction'),
        role: 'system',
        text: boundedText(record.summary, MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths),
        timestamp,
      })
      continue
    }
    if (record.type === 'branch_summary' && typeof record.summary === 'string') {
      messages.push({
        id: boundedIdentifier(record.id, 'branch'),
        role: 'system',
        text: boundedText(record.summary, MAXIMUM_RELAY_TEXT_LENGTH, sessionPaths),
        timestamp,
      })
    }
  }

  const chronologicalMessages = [...messages].sort(
    (left, right) => left.timestamp - right.timestamp,
  )
  const chronologicalTools = [...tools.values()].sort(
    (left, right) => left.timestamp - right.timestamp,
  )
  return boundSnapshot(
    chronologicalMessages.slice(-240),
    chronologicalTools.slice(-80),
  )
}

function retainRenderableEntries(
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<Record<string, unknown> & { readonly id: string }> {
  const retained: Array<Record<string, unknown> & { readonly id: string }> = []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const record = asRecord(entries[index])
    if (
      record === undefined ||
      typeof record.id !== 'string' ||
      !isRenderableEntry(record)
    ) {
      continue
    }
    const isSummaryEntry = record.type === 'compaction' || record.type === 'branch_summary'
    if (retained.length >= 240 && !isSummaryEntry) {
      continue
    }
    retained.unshift({ ...record, id: record.id })
  }
  return retained
}

function isRenderableEntry(record: Record<string, unknown>): boolean {
  if (
    record.type === 'compaction' ||
    record.type === 'branch_summary' ||
    (record.type === 'custom_message' && record.display === true)
  ) {
    return true
  }
  if (record.type !== 'message') {
    return false
  }
  const message = asRecord(record.message)
  return message?.role === 'user' ||
    message?.role === 'assistant' ||
    message?.role === 'toolResult' ||
    (message?.role === 'custom' && message.display === true)
}

/** Return a plain record only when the unknown value is an object. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function boundSnapshot(
  messages: ReadonlyArray<RelayMessage>,
  tools: ReadonlyArray<RelayTool>,
): RelaySnapshot {
  const boundedMessages: RelayMessage[] = []
  const boundedTools: RelayTool[] = []
  let bytes = jsonSize({ messages: boundedMessages, tools: boundedTools })

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) {
      continue
    }
    const additionalBytes = jsonSize(message) + (boundedMessages.length === 0 ? 0 : 1)
    if (bytes + additionalBytes > MAXIMUM_RELAY_SNAPSHOT_BYTES) {
      break
    }
    boundedMessages.unshift(message)
    bytes += additionalBytes
  }

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index]
    if (tool === undefined) {
      continue
    }
    const additionalBytes = jsonSize(tool) + (boundedTools.length === 0 ? 0 : 1)
    if (bytes + additionalBytes > MAXIMUM_RELAY_SNAPSHOT_BYTES) {
      break
    }
    boundedTools.unshift(tool)
    bytes += additionalBytes
  }

  return { messages: boundedMessages, tools: boundedTools }
}

function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function createMessage(
  id: string,
  role: RelayMessage['role'],
  text: string,
  timestamp: number,
  extra?: Pick<RelayMessage, 'images' | 'isError' | 'thinking' | 'toolCallId'>,
): RelayMessage {
  return {
    id: boundedIdentifier(id, 'message'),
    role,
    text,
    timestamp,
    ...(extra?.images === undefined ? {} : { images: extra.images }),
    ...(extra?.thinking === undefined ? {} : { thinking: extra.thinking }),
    ...(extra?.toolCallId === undefined ? {} : { toolCallId: boundedIdentifier(extra.toolCallId, 'tool') }),
    ...(extra?.isError === undefined ? {} : { isError: extra.isError }),
  }
}

function timestampForEntry(record: Record<string, unknown>, fallback: number): number {
  if (typeof record.timestamp === 'string') {
    const parsed = Date.parse(record.timestamp)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return numberOr(record.timestamp, fallback)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function isImageMimeType(
  value: unknown,
): value is 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp' {
  return value === 'image/gif' || value === 'image/jpeg' || value === 'image/png' || value === 'image/webp'
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function boundedIdentifier(value: string, prefix: string): string {
  const normalized = boundedText(value, 120).trim()
  return normalized.length === 0 ? `${prefix}-unknown` : normalized
}
