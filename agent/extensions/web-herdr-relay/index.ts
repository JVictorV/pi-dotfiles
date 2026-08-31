import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import {
  stripFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
  asRecord,
  boundedText,
  extractEditDiff,
  extractReadResult,
  extractSearchResult,
  extractText,
  extractToolDetail,
  extractWriteResult,
  normalizeActiveBranch,
  normalizeModelOptions,
  serializeToolInput,
} from './normalization'
import {
  expandSkillInvocation,
  isSupportedWebCommand,
  reloadRuntimeCommandName,
} from './skill-invocation'
import { startedMessageAction } from './message-lifecycle'

const MAXIMUM_BOOTSTRAP_LINE_BYTES = 64 * 1024
const MAXIMUM_RELAY_COMMAND_LINE_BYTES = 16 * 1024 * 1024
const MAXIMUM_CHAT_ATTACHMENTS = 4
const MAXIMUM_CHAT_IMAGES = MAXIMUM_CHAT_ATTACHMENTS
const MAXIMUM_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
const MAXIMUM_CHAT_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024
const WRITE_OUTPUT_INACTIVITY_MILLISECONDS = 60_000
const relayBootstrapSocketPath =
  process.env.HERDR_RELAY_BOOTSTRAP_SOCKET ??
  join(homedir(), '.cache', 'web-herdr', 'pi-relay-bootstrap.sock')
const paneId = process.env.HERDR_PANE_ID
const reportedSessionPath = process.env.PI_SESSION_FILE

type RelayImage = {
  readonly data: string
  readonly mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
  readonly type: 'image'
}

type RelayImagePayload = Omit<RelayImage, 'type'>

type RelayFilePayload = {
  readonly name: string
  readonly path: string
}

type RelayUserCommandFields = {
  readonly content: string
  readonly files?: ReadonlyArray<RelayFilePayload>
  readonly images?: ReadonlyArray<RelayImagePayload>
  readonly operationId: string
  readonly paneId: string
}

type RelayUserCommand =
  | ({ readonly command: 'Prompt' } & RelayUserCommandFields)
  | ({ readonly command: 'Steer' } & RelayUserCommandFields)
  | ({ readonly command: 'FollowUp' } & RelayUserCommandFields)

type RelayCommand =
  | RelayUserCommand
  | { readonly command: 'Abort'; readonly operationId: string; readonly paneId: string }
  | { readonly command: 'SetModel'; readonly model: { readonly id: string; readonly provider: string }; readonly operationId: string; readonly paneId: string }
  | { readonly command: 'SetThinkingLevel'; readonly operationId: string; readonly paneId: string; readonly thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  | { readonly command: 'Compact'; readonly instructions?: string; readonly operationId: string; readonly paneId: string }
  | { readonly command: 'SetSessionName'; readonly name: string; readonly operationId: string; readonly paneId: string }
  | { readonly command: 'RequestSnapshot'; readonly operationId: string; readonly paneId: string }

type RelaySessionIdentity = {
  readonly sessionId: string
  readonly sessionPath: string
}

type RelayCredentials = {
  readonly key: string
  readonly relaySocket: string
  readonly writeOutputSocket?: string
}

class RelayClient {
  private buffer = ''
  private socket: net.Socket | undefined
  private stopped = false
  private ready = false
  private readonly writeOutputSockets = new Map<string, net.Socket>()

  constructor(
    private readonly credentials: RelayCredentials,
    private readonly identity: RelaySessionIdentity,
    private readonly onCommand: (command: RelayCommand) => Promise<void>,
    private readonly onReady: () => void,
    private readonly onDisconnect: () => void,
  ) {}

  start(): void {
    this.connect()
  }

  stop(options: { readonly releaseUploads: boolean } = { releaseUploads: false }): void {
    this.stopped = true
    this.ready = false
    for (const outputSocket of this.writeOutputSockets.values()) outputSocket.destroy()
    this.writeOutputSockets.clear()
    const socket = this.socket
    this.socket = undefined
    if (socket === undefined) {
      return
    }
    if (options.releaseUploads && !socket.destroyed) {
      socket.end('{"type":"release_uploads"}\n')
      return
    }
    socket.destroy()
  }

  publish(event: Record<string, unknown>): void {
    this.writeLine(event)
  }

  stageWriteOutput(toolCallId: string, path: string, content: string): Promise<boolean> {
    if (
      !this.ready ||
      this.stopped ||
      paneId === undefined ||
      this.credentials.writeOutputSocket === undefined
    ) return Promise.resolve(false)
    const socket = net.createConnection(this.credentials.writeOutputSocket)
    this.writeOutputSockets.set(toolCallId, socket)
    return new Promise((resolveStage) => {
      let response = ''
      let settled = false
      const finish = (stored: boolean) => {
        if (settled) return
        settled = true
        if (this.writeOutputSockets.get(toolCallId) === socket) {
          this.writeOutputSockets.delete(toolCallId)
        }
        socket.destroy()
        resolveStage(stored)
      }
      socket.setEncoding('utf8')
      socket.setTimeout(WRITE_OUTPUT_INACTIVITY_MILLISECONDS, () => finish(false))
      socket.on('connect', () => {
        void streamWriteContent(socket, {
          key: this.credentials.key,
          name: basename(path)
            .replace(/[\u0000-\u001F\u007F/\\]/g, '_')
            .slice(0, 255) || 'write-output',
          paneId,
          sessionId: this.identity.sessionId,
          sessionPath: this.identity.sessionPath,
          size: Buffer.byteLength(content, 'utf8'),
          toolCallId,
          type: 'write_output',
        }, content).catch(() => finish(false))
      })
      socket.on('data', (chunk) => {
        response += String(chunk)
        if (Buffer.byteLength(response, 'utf8') > MAXIMUM_BOOTSTRAP_LINE_BYTES) {
          finish(false)
          return
        }
        const newline = response.indexOf('\n')
        if (newline < 0) return
        try {
          const value = asRecord(JSON.parse(response.slice(0, newline)))
          finish(value?.type === 'stored')
        } catch {
          finish(false)
        }
      })
      socket.on('error', () => finish(false))
      socket.on('close', () => finish(false))
    })
  }

  controlWriteOutput(toolCallId: string, action: 'complete' | 'discard'): void {
    if (this.credentials.writeOutputSocket === undefined) return
    if (action === 'discard') this.writeOutputSockets.get(toolCallId)?.destroy()
    this.writeLine({ action, toolCallId, type: 'write_output_control' })
  }

  private writeLine(value: Record<string, unknown>): void {
    if (!this.ready || this.socket === undefined || this.socket.destroyed) {
      return
    }
    try {
      this.socket.write(`${JSON.stringify(value)}\n`)
    } catch {
      this.socket.destroy()
    }
  }

  private connect(): void {
    if (this.stopped || paneId === undefined) {
      return
    }
    const socket = net.createConnection(this.credentials.relaySocket)
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({
          key: this.credentials.key,
          paneId,
          reportedSessionPath: reportedSessionPath ?? this.identity.sessionPath,
          sessionId: this.identity.sessionId,
          sessionPath: this.identity.sessionPath,
          type: 'hello',
        })}\n`,
      )
    })
    socket.on('data', (chunk) => this.receive(String(chunk)))
    socket.on('error', () => {})
    socket.on('close', () => {
      this.ready = false
      if (this.socket === socket) {
        this.socket = undefined
      }
      if (!this.stopped) {
        this.onDisconnect()
      }
    })
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > MAXIMUM_RELAY_COMMAND_LINE_BYTES) {
      this.socket?.destroy()
      return
    }
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      newlineIndex = this.buffer.indexOf('\n')
      if (line.length === 0) {
        continue
      }
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.socket?.destroy()
        return
      }
      const record = asRecord(message)
      if (record?.type === 'ready') {
        this.ready = true
        this.onReady()
        continue
      }
      if (record?.type !== 'command') {
        this.socket?.destroy()
        return
      }
      const command = parseCommand(record.command)
      if (command === undefined || command.paneId !== paneId) {
        this.socket?.destroy()
        return
      }
      void this.onCommand(command)
    }
  }
}

async function streamWriteContent(
  socket: net.Socket,
  header: Record<string, unknown>,
  content: string,
): Promise<void> {
  await writeWithBackpressure(socket, `${JSON.stringify(header)}\n`)
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(content.length, offset + 64 * 1024)
    const finalCodeUnit = content.charCodeAt(end - 1)
    if (end < content.length && finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) end -= 1
    await writeWithBackpressure(socket, content.slice(offset, end))
    offset = end
  }
  socket.end()
}

function writeWithBackpressure(socket: net.Socket, value: string): Promise<void> {
  if (socket.destroyed) return Promise.reject(new Error('Write output socket is closed'))
  if (socket.write(value)) return Promise.resolve()
  return new Promise((resolveWrite, rejectWrite) => {
    const cleanup = () => {
      socket.off('drain', onDrain)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolveWrite()
    }
    const onError = (error: Error) => {
      cleanup()
      rejectWrite(error)
    }
    const onClose = () => {
      cleanup()
      rejectWrite(new Error('Write output socket closed before draining'))
    }
    socket.once('drain', onDrain)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function requestRelayCredentials(identity: RelaySessionIdentity): Promise<RelayCredentials | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection(relayBootstrapSocketPath)
    let buffer = ''
    let settled = false
    const finish = (credentials: RelayCredentials | undefined) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      resolve(credentials)
    }
    const timeout = setTimeout(() => finish(undefined), 1_000)
    timeout.unref?.()
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({
        ...identity,
        paneId,
        reportedSessionPath: reportedSessionPath ?? identity.sessionPath,
        type: 'bootstrap',
      })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      if (Buffer.byteLength(buffer, 'utf8') > MAXIMUM_BOOTSTRAP_LINE_BYTES) {
        finish(undefined)
        return
      }
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex < 0) {
        return
      }
      let message: unknown
      try {
        message = JSON.parse(buffer.slice(0, newlineIndex))
      } catch {
        finish(undefined)
        return
      }
      const record = asRecord(message)
      const key = record?.key
      const relaySocket = record?.relaySocket
      const writeOutputSocket = record?.writeOutputSocket
      finish(
        record?.type === 'credentials' &&
          typeof key === 'string' &&
          key.length >= 16 &&
          key.length <= 256 &&
          typeof relaySocket === 'string' &&
          relaySocket.length > 0 &&
          relaySocket.length <= 4_096 &&
          (writeOutputSocket === undefined || (
            typeof writeOutputSocket === 'string' &&
            writeOutputSocket.length > 0 &&
            writeOutputSocket.length <= 4_096
          ))
          ? {
            key,
            relaySocket,
            ...(typeof writeOutputSocket === 'string' ? { writeOutputSocket } : {}),
          }
          : undefined,
      )
    })
    socket.on('error', () => finish(undefined))
    socket.on('end', () => finish(undefined))
  })
}

/** Connect an interactive Pi session to the local authenticated web relay. */
export default function webHerdrRelay(pi: ExtensionAPI): void {
  if (
    paneId === undefined ||
    paneId.length === 0
  ) {
    return
  }

  let client: RelayClient | undefined
  let bootstrapTimer: ReturnType<typeof setTimeout> | undefined
  let connectionGeneration = 0
  let commandInFlight = false
  let compactionInFlight = false
  let eventSequence = 1
  let activeAssistantId: string | undefined
  let activeSessionPaths: ReadonlyArray<string> = []
  let lastAssistantUpdateAt = 0
  let localEventCount = 0
  const writeInputs = new Map<string, {
    completionScheduled: boolean
    readonly generation: number
    readonly path: string
    readonly size: number
    state: 'pending' | 'available' | 'unavailable'
    readonly transfer: Promise<boolean>
  }>()

  function nextEventId(prefix: string): string {
    localEventCount += 1
    return `${prefix}-${Date.now()}-${localEventCount}`
  }

  function relayToolId(toolCallId: string): string {
    const normalized = boundedText(toolCallId, 120).trim()
    return normalized.length === 0 ? 'tool-unknown' : normalized
  }

  function rememberWriteInput(
    toolCallId: string,
    path: string,
    size: number,
    input: unknown,
  ): void {
    const id = relayToolId(toolCallId)
    if (writeInputs.has(id)) return
    const content = asRecord(input)?.content
    const transfer = typeof content === 'string' && !path.includes('[redacted')
      ? client?.stageWriteOutput(id, path, content) ?? Promise.resolve(false)
      : Promise.resolve(false)
    writeInputs.set(id, {
      completionScheduled: false,
      generation: connectionGeneration,
      path,
      size,
      state: 'pending',
      transfer,
    })
    while (writeInputs.size > 256) {
      const oldest = writeInputs.keys().next().value
      if (oldest === undefined) return
      writeInputs.delete(oldest)
    }
  }

  function scheduleWriteCompletion(
    toolCallId: string,
    name: string,
    detail: string | undefined,
  ): void {
    const id = relayToolId(toolCallId)
    const writeInput = writeInputs.get(id)
    if (writeInput === undefined || writeInput.completionScheduled) return
    writeInput.completionScheduled = true
    void writeInput.transfer.then((stored) => {
      if (
        writeInput.generation !== connectionGeneration ||
        writeInputs.get(id) !== writeInput
      ) return
      writeInput.state = stored ? 'available' : 'unavailable'
      client?.controlWriteOutput(id, stored ? 'complete' : 'discard')
      publish('tool', {
        tool: {
          ...(detail === undefined ? {} : { detail }),
          id,
          isError: false,
          name: boundedText(name, 128),
          status: 'complete',
          timestamp: Date.now(),
          writeResult: {
            path: writeInput.path,
            size: writeInput.size,
            state: writeInput.state,
          },
        },
      })
    })
  }

  function publish(type: string, event: Record<string, unknown>): void {
    client?.publish({ at: Date.now(), sequence: eventSequence, type, ...event })
    eventSequence += 1
  }

  function runtimeFor(ctx: ExtensionContext) {
    const usage = ctx.getContextUsage()
    const model = ctx.model
    const sessionName = pi.getSessionName()
    const skills = pi.getCommands()
      .filter(isSupportedWebCommand)
      .slice(0, 256)
      .map((command) => {
        const description = command.description === undefined
          ? undefined
          : boundedText(command.description, 1_024).trim()
        return {
          name: boundedText(command.name, 128),
          ...(description === undefined || description.length === 0 ? {} : { description }),
        }
      })
    return {
      busy: !ctx.isIdle(),
      compacting: compactionInFlight,
      contextPercent: safeUsageNumber(usage?.percent),
      contextTokens: safeUsageNumber(usage?.tokens),
      contextWindow: safeUsageNumber(usage?.contextWindow),
      ...(model === undefined ? {} : {
        model: {
          id: boundedText(model.id, 256),
          provider: boundedText(model.provider, 128),
          supportsImages: model.input.includes('image'),
        },
      }),
      pending: ctx.hasPendingMessages(),
      ...(sessionName === undefined ? {} : { sessionName: boundedText(sessionName, 256, activeSessionPaths) }),
      skills,
      thinkingLevel: pi.getThinkingLevel(),
    }
  }

  function publishRuntime(ctx: ExtensionContext): void {
    publish('runtime', { runtime: runtimeFor(ctx) })
  }

  function setCompactionInFlight(compacting: boolean, ctx: ExtensionContext): void {
    if (compactionInFlight === compacting) {
      return
    }
    compactionInFlight = compacting
    publishRuntime(ctx)
  }

  function publishModelCatalog(ctx: ExtensionContext): void {
    const availableModels = ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((scopedModel) => scopedModel.model)
      : ctx.modelRegistry.getAvailable()
    publish('model_catalog', { models: normalizeModelOptions(availableModels) })
  }

  function publishSnapshot(ctx: ExtensionContext): void {
    const branch = normalizeActiveBranch(
      ctx.sessionManager.buildContextEntries(),
      Date.now(),
      activeSessionPaths,
    )
    const tools = branch.tools.map((tool) => {
      if (tool.writeResult === undefined) return tool
      const current = writeInputs.get(tool.id)
      return {
        ...tool,
        writeResult: {
          ...tool.writeResult,
          state: current?.state ?? 'unavailable' as const,
        },
      }
    })
    publish('snapshot', {
      snapshot: {
        messages: branch.messages,
        runtime: runtimeFor(ctx),
        tools,
      },
    })
    publishModelCatalog(ctx)
  }

  function reportCommand(command: RelayCommand, status: 'ok' | 'rejected' | 'error', error?: string): void {
    publish('command_result', {
      operationId: command.operationId,
      status,
      ...(error === undefined ? {} : { error: boundedText(error) }),
    })
  }

  async function handleCommand(command: RelayCommand, ctx: ExtensionContext): Promise<void> {
    if (commandInFlight) {
      reportCommand(command, 'rejected', 'Pi is already handling a web command.')
      return
    }
    if (
      (command.command === 'Prompt' || command.command === 'Steer' || command.command === 'FollowUp') &&
      command.images !== undefined &&
      ctx.model?.input.includes('image') !== true
    ) {
      reportCommand(command, 'rejected', 'The selected Pi model does not support images.')
      return
    }
    commandInFlight = true
    try {
      await executeCommand(command, ctx)
      reportCommand(command, 'ok')
    } catch {
      reportCommand(command, 'error', 'Pi rejected the web command.')
    } finally {
      commandInFlight = false
      publishRuntime(ctx)
    }
  }

  async function executeCommand(command: RelayCommand, ctx: ExtensionContext): Promise<void> {
    if (command.command === 'RequestSnapshot') {
      publishSnapshot(ctx)
      return
    }
    if (command.command === 'Abort') {
      if (ctx.isIdle()) {
        throw new Error('Pi is idle.')
      }
      ctx.abort()
      return
    }
    if (command.command === 'Steer' || command.command === 'FollowUp') {
      if (ctx.isIdle()) {
        throw new Error('Pi is idle.')
      }
      pi.sendUserMessage(await expandedUserMessageContent(command), {
        deliverAs: command.command === 'Steer' ? 'steer' : 'followUp',
      })
      return
    }
    if (!ctx.isIdle()) {
      throw new Error('Pi is busy.')
    }
    if (command.command === 'Prompt') {
      pi.sendUserMessage(await expandedUserMessageContent(command))
      return
    }
    if (command.command === 'SetModel') {
      const model = ctx.modelRegistry.find(command.model.provider, command.model.id)
      if (model === undefined || !(await pi.setModel(model))) {
        throw new Error('The requested model is unavailable.')
      }
      return
    }
    if (command.command === 'SetThinkingLevel') {
      pi.setThinkingLevel(command.thinkingLevel)
      return
    }
    if (command.command === 'SetSessionName') {
      pi.setSessionName(command.name)
      return
    }
    await new Promise<void>((resolve, reject) => {
      ctx.compact({
        ...(command.instructions === undefined ? {} : { customInstructions: command.instructions }),
        onComplete: () => {
          setCompactionInFlight(false, ctx)
          resolve()
        },
        onError: () => {
          setCompactionInFlight(false, ctx)
          reject(new Error('Compaction failed.'))
        },
      })
    })
  }

  function scheduleBootstrap(
    ctx: ExtensionContext,
    identity: RelaySessionIdentity,
    generation: number,
    delayMilliseconds: number,
  ): void {
    if (generation !== connectionGeneration || bootstrapTimer !== undefined) {
      return
    }
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = undefined
      connectThroughBootstrap(ctx, identity, generation, Math.min(delayMilliseconds * 2, 30_000))
    }, delayMilliseconds)
    bootstrapTimer.unref?.()
  }

  function connectThroughBootstrap(
    ctx: ExtensionContext,
    identity: RelaySessionIdentity,
    generation: number,
    delayMilliseconds = 250,
  ): void {
    void requestRelayCredentials(identity).then((credentials) => {
      if (generation !== connectionGeneration) {
        return
      }
      if (credentials === undefined) {
        scheduleBootstrap(ctx, identity, generation, delayMilliseconds)
        return
      }
      client = new RelayClient(
        credentials,
        identity,
        async (command) => handleCommand(command, ctx),
        () => publishSnapshot(ctx),
        () => {
          if (generation !== connectionGeneration) {
            return
          }
          client = undefined
          scheduleBootstrap(ctx, identity, generation, 250)
        },
      )
      client.start()
    })
  }

  async function expandedUserMessageContent(
    command: RelayUserCommand,
  ): Promise<string | Array<RelayImage | { readonly text: string; readonly type: 'text' }>> {
    const expanded = await expandSkillInvocation(
      command.content,
      pi.getCommands(),
      (path) => readFile(path, 'utf8'),
      stripFrontmatter,
    )
    const content = contentWithUploadedFiles(command, expanded ?? command.content)
    return userMessageContent(command, content)
  }

  function contentWithUploadedFiles(
    command: RelayUserCommand,
    content: string,
  ): string {
    if (command.files === undefined) {
      return content
    }
    const manifest = command.files.map((file) => `${file.name}\t${file.path}`).join('\n')
    return `<web-herdr-files>\nThe following user-uploaded files are available locally:\n${manifest}\n</web-herdr-files>${content.length === 0 ? '' : `\n\n${content}`}`
  }

  pi.registerCommand(reloadRuntimeCommandName, {
    description: 'Reload Pi extensions, skills, prompts, themes, and context files',
    handler: async (_args, ctx) => {
      await ctx.reload()
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    connectionGeneration += 1
    const generation = connectionGeneration
    client?.stop({ releaseUploads: true })
    client = undefined
    activeSessionPaths = []
    writeInputs.clear()
    compactionInFlight = false
    if (bootstrapTimer !== undefined) {
      clearTimeout(bootstrapTimer)
      bootstrapTimer = undefined
    }
    if (ctx.mode !== 'tui') {
      return
    }
    const identity = sessionIdentity(ctx)
    if (identity === undefined) {
      return
    }
    activeSessionPaths = knownSessionPaths(identity)
    connectThroughBootstrap(ctx, identity, generation)
  })

  pi.on('resources_discover', (_event, ctx) => {
    const generation = connectionGeneration
    const refreshTimer = setTimeout(() => {
      if (generation === connectionGeneration) {
        publishSnapshot(ctx)
      }
    }, 0)
    refreshTimer.unref?.()
  })
  pi.on('input', (_event, ctx) => publishRuntime(ctx))
  pi.on('agent_start', (_event, ctx) => publishRuntime(ctx))
  pi.on('agent_end', (_event, ctx) => publishRuntime(ctx))
  pi.on('agent_settled', (_event, ctx) => {
    compactionInFlight = false
    publishRuntime(ctx)
    publishSnapshot(ctx)
  })
  pi.on('turn_start', (_event, ctx) => publishRuntime(ctx))
  pi.on('turn_end', (_event, ctx) => {
    publishRuntime(ctx)
    publishSnapshot(ctx)
  })
  pi.on('model_select', (_event, ctx) => publishRuntime(ctx))
  pi.on('thinking_level_select', (_event, ctx) => publishRuntime(ctx))
  pi.on('session_info_changed', (_event, ctx) => publishRuntime(ctx))
  pi.on('session_before_compact', (event, ctx) => {
    setCompactionInFlight(true, ctx)
    event.signal.addEventListener(
      'abort',
      () => setCompactionInFlight(false, ctx),
      { once: true },
    )
  })
  pi.on('session_compact', (_event, ctx) => {
    setCompactionInFlight(false, ctx)
    publishSnapshot(ctx)
  })
  pi.on('message_start', (event, ctx) => {
    const now = Date.now()
    const action = startedMessageAction(
      event.message,
      nextEventId('message'),
      now,
      activeSessionPaths,
    )
    if (action._tag === 'PublishUserMessage') {
      publish('message', { message: action.message })
    } else if (action._tag === 'StartAssistant') {
      activeAssistantId = nextEventId('assistant')
    }
    publishRuntime(ctx)
  })
  pi.on('message_update', (event) => {
    const now = Date.now()
    if (now - lastAssistantUpdateAt < 75) {
      return
    }
    lastAssistantUpdateAt = now
    const message = asRecord(event.message)
    if (message?.role !== 'assistant') {
      return
    }
    const id = activeAssistantId ?? nextEventId('assistant')
    activeAssistantId = id
    const thinking = message.content === undefined
      ? undefined
      : extractThinkingForUpdate(message.content, activeSessionPaths)
    publish('assistant_update', {
      id,
      text: extractText(message.content, activeSessionPaths),
      ...(thinking === undefined ? {} : { thinking }),
      timestamp: safeUsageNumber(message.timestamp) ?? now,
    })
  })
  pi.on('message_end', (event, ctx) => {
    const message = asRecord(event.message)
    if (message?.role === 'user') {
      return
    }
    if (message?.role === 'assistant') {
      activeAssistantId = undefined
    }
    publishSnapshot(ctx)
  })
  pi.on('tool_execution_start', (event) => {
    const writeResult = extractWriteResult(event.toolName, event.args, 'pending', activeSessionPaths)
    const input = event.toolName.toLocaleLowerCase('en-US') === 'write'
      ? undefined
      : serializeToolInput(event.args, activeSessionPaths)
    if (writeResult !== undefined) {
      rememberWriteInput(event.toolCallId, writeResult.path, writeResult.size, event.args)
    }
    publish('tool', {
      tool: {
        id: boundedText(event.toolCallId, 120),
        ...(input === undefined ? {} : { input }),
        name: boundedText(event.toolName, 128),
        status: 'running',
        timestamp: Date.now(),
        ...(writeResult === undefined ? {} : { writeResult }),
      },
    })
  })
  pi.on('tool_execution_update', (event) => {
    const writeResult = extractWriteResult(event.toolName, event.args, 'pending', activeSessionPaths)
    const input = event.toolName.toLocaleLowerCase('en-US') === 'write'
      ? undefined
      : serializeToolInput(event.args, activeSessionPaths)
    const result = asRecord(event.partialResult)
    const detail = result?.content === undefined
      ? undefined
      : extractToolDetail(result.content, activeSessionPaths)
    publish('tool', {
      tool: {
        ...(detail === undefined ? {} : { detail: detail.text, detailTruncated: detail.truncated }),
        id: boundedText(event.toolCallId, 120),
        ...(input === undefined ? {} : { input }),
        name: boundedText(event.toolName, 128),
        status: 'running',
        timestamp: Date.now(),
        ...(writeResult === undefined ? {} : { writeResult }),
      },
    })
  })
  pi.on('tool_execution_end', (event) => {
    const result = asRecord(event.result)
    const detail = result?.content === undefined
      ? undefined
      : extractToolDetail(result.content, activeSessionPaths)
    const editDiff = extractEditDiff(event.toolName, result?.details, activeSessionPaths)
    const readResult = extractReadResult(event.toolName, result?.content, result?.details, activeSessionPaths)
    const searchResult = extractSearchResult(event.toolName, result?.content, result?.details, activeSessionPaths)
    const writeToolId = relayToolId(event.toolCallId)
    const writeInput = writeInputs.get(writeToolId)
    if (writeInput !== undefined) {
      if (event.isError) writeInput.state = 'unavailable'
      else if (!writeInput.completionScheduled) writeInput.state = 'pending'
      if (event.isError) client?.controlWriteOutput(writeToolId, 'discard')
    }
    const writeResult = writeInput === undefined
      ? undefined
      : { path: writeInput.path, size: writeInput.size, state: writeInput.state }
    publish('tool', {
      tool: {
        ...(detail === undefined ? {} : { detail: detail.text, detailTruncated: detail.truncated }),
        ...(editDiff === undefined ? {} : { editDiff }),
        id: boundedText(event.toolCallId, 120),
        isError: event.isError,
        name: boundedText(event.toolName, 128),
        ...(readResult === undefined ? {} : { readResult }),
        ...(searchResult === undefined ? {} : { searchResult }),
        status: 'complete',
        timestamp: Date.now(),
        ...(writeResult === undefined ? {} : { writeResult }),
      },
    })
    if (!event.isError) {
      scheduleWriteCompletion(
        event.toolCallId,
        event.toolName,
        detail?.text,
      )
    }
  })
  pi.on('tool_result', (event) => {
    const writeResult = extractWriteResult(
      event.toolName,
      event.input,
      event.isError ? 'unavailable' : 'pending',
      activeSessionPaths,
    )
    const input = event.toolName.toLocaleLowerCase('en-US') === 'write'
      ? undefined
      : serializeToolInput(event.input, activeSessionPaths)
    let effectiveWriteResult = writeResult
    if (writeResult !== undefined) {
      rememberWriteInput(event.toolCallId, writeResult.path, writeResult.size, event.input)
      const writeToolId = relayToolId(event.toolCallId)
      const writeInput = writeInputs.get(writeToolId)
      if (writeInput !== undefined) {
        if (event.isError) writeInput.state = 'unavailable'
        else if (!writeInput.completionScheduled) writeInput.state = 'pending'
        if (event.isError) client?.controlWriteOutput(writeToolId, 'discard')
        effectiveWriteResult = {
          path: writeInput.path,
          size: writeInput.size,
          state: writeInput.state,
        }
      }
    }
    const detail = extractToolDetail(event.content, activeSessionPaths)
    const editDiff = extractEditDiff(event.toolName, event.details, activeSessionPaths)
    const readResult = extractReadResult(event.toolName, event.content, event.details, activeSessionPaths)
    const searchResult = extractSearchResult(event.toolName, event.content, event.details, activeSessionPaths)
    publish('tool', {
      tool: {
        detail: detail.text,
        detailTruncated: detail.truncated,
        ...(editDiff === undefined ? {} : { editDiff }),
        id: boundedText(event.toolCallId, 120),
        ...(input === undefined ? {} : { input }),
        isError: event.isError,
        name: boundedText(event.toolName, 128),
        ...(readResult === undefined ? {} : { readResult }),
        ...(searchResult === undefined ? {} : { searchResult }),
        status: 'complete',
        timestamp: Date.now(),
        ...(effectiveWriteResult === undefined ? {} : { writeResult: effectiveWriteResult }),
      },
    })
    if (!event.isError) {
      scheduleWriteCompletion(
        event.toolCallId,
        event.toolName,
        detail.text,
      )
    }
  })
  pi.on('session_shutdown', async () => {
    connectionGeneration += 1
    if (bootstrapTimer !== undefined) {
      clearTimeout(bootstrapTimer)
      bootstrapTimer = undefined
    }
    client?.stop({ releaseUploads: true })
    client = undefined
    activeSessionPaths = []
    writeInputs.clear()
  })
}

function knownSessionPaths(identity: RelaySessionIdentity): ReadonlyArray<string> {
  return reportedSessionPath === undefined || reportedSessionPath === identity.sessionPath
    ? [identity.sessionPath]
    : [identity.sessionPath, reportedSessionPath]
}

function sessionIdentity(ctx: ExtensionContext): RelaySessionIdentity | undefined {
  const sessionPath = ctx.sessionManager.getSessionFile()
  const sessionId = ctx.sessionManager.getSessionId()
  return typeof sessionPath === 'string' && sessionPath.length > 0 && sessionId.length > 0
    ? { sessionId, sessionPath }
    : undefined
}

function safeUsageNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function extractThinkingForUpdate(
  content: unknown,
  sessionPaths: ReadonlyArray<string>,
): string | undefined {
  if (!Array.isArray(content)) {
    return undefined
  }
  const thinking = boundedText(
    content
      .flatMap((block) => {
        const record = asRecord(block)
        return record?.type === 'thinking' && typeof record.thinking === 'string'
          ? [record.thinking]
          : []
      })
      .join(''),
    undefined,
    sessionPaths,
  )
  return thinking.length === 0 ? undefined : thinking
}

function parseCommand(value: unknown): RelayCommand | undefined {
  const record = asRecord(value)
  if (
    record === undefined ||
    !isIdentifier(record.operationId) ||
    !isIdentifier(record.paneId) ||
    typeof record.command !== 'string'
  ) {
    return undefined
  }
  const base = { operationId: record.operationId, paneId: record.paneId }
  if (record.command === 'Prompt' || record.command === 'Steer' || record.command === 'FollowUp') {
    const hasFiles = Object.hasOwn(record, 'files')
    const hasImages = Object.hasOwn(record, 'images')
    const expectedKeys = [
      'command',
      'content',
      ...(hasFiles ? ['files'] : []),
      ...(hasImages ? ['images'] : []),
      'operationId',
      'paneId',
    ]
    if (!hasExactKeys(record, expectedKeys)) {
      return undefined
    }
    const content = boundedCommandText(record.content)
    const files = hasFiles ? parseFiles(record.files) : undefined
    const images = hasImages ? parseImages(record.images) : undefined
    const attachmentCount = (files?.length ?? 0) + (images?.length ?? 0)
    if (
      content === undefined ||
      (hasFiles && files === undefined) ||
      (hasImages && images === undefined) ||
      (content.length === 0 && attachmentCount === 0) ||
      attachmentCount > MAXIMUM_CHAT_ATTACHMENTS
    ) {
      return undefined
    }
    return {
      ...base,
      command: record.command,
      content,
      ...(files === undefined ? {} : { files }),
      ...(images === undefined ? {} : { images }),
    }
  }
  if (record.command === 'Abort' || record.command === 'RequestSnapshot') {
    return hasExactKeys(record, ['command', 'operationId', 'paneId'])
      ? { ...base, command: record.command }
      : undefined
  }
  if (record.command === 'SetModel') {
    const model = asRecord(record.model)
    return hasExactKeys(record, ['command', 'model', 'operationId', 'paneId']) &&
      model !== undefined &&
      hasExactKeys(model, ['id', 'provider']) &&
      typeof model.id === 'string' &&
      typeof model.provider === 'string' &&
      isBounded(model.id, 256) &&
      isBounded(model.provider, 128)
      ? { ...base, command: 'SetModel', model: { id: model.id.trim(), provider: model.provider.trim() } }
      : undefined
  }
  if (record.command === 'SetThinkingLevel') {
    return hasExactKeys(record, ['command', 'operationId', 'paneId', 'thinkingLevel']) &&
      isThinkingLevel(record.thinkingLevel)
      ? { ...base, command: 'SetThinkingLevel', thinkingLevel: record.thinkingLevel }
      : undefined
  }
  if (record.command === 'SetSessionName') {
    if (!hasExactKeys(record, ['command', 'name', 'operationId', 'paneId'])) {
      return undefined
    }
    const name = boundedValue(record.name, 256)
    return name === undefined ? undefined : { ...base, command: 'SetSessionName', name }
  }
  if (record.command === 'Compact') {
    const hasInstructions = Object.hasOwn(record, 'instructions')
    if (!hasExactKeys(
      record,
      hasInstructions
        ? ['command', 'instructions', 'operationId', 'paneId']
        : ['command', 'operationId', 'paneId'],
    )) {
      return undefined
    }
    if (!hasInstructions) {
      return { ...base, command: 'Compact' }
    }
    const instructions = boundedValue(record.instructions, 4_000)
    return instructions === undefined ? undefined : { ...base, command: 'Compact', instructions }
  }
  return undefined
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: ReadonlyArray<string>,
): boolean {
  const keys = Object.keys(record)
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(record, key))
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && isBounded(value, 128)
}

function boundedCommandText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length <= 12_000
    ? value.trim()
    : undefined
}

function parseFiles(value: unknown): ReadonlyArray<RelayFilePayload> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_CHAT_ATTACHMENTS) {
    return undefined
  }
  const files: RelayFilePayload[] = []
  for (const valueFile of value) {
    const file = asRecord(valueFile)
    if (
      file === undefined ||
      !hasExactKeys(file, ['name', 'path']) ||
      !isSafeFileName(file.name) ||
      !isSafeUploadPath(file.path)
    ) {
      return undefined
    }
    files.push({ name: file.name, path: file.path })
  }
  return files
}

function parseImages(value: unknown): ReadonlyArray<RelayImagePayload> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_CHAT_IMAGES) {
    return undefined
  }
  const images: RelayImagePayload[] = []
  let totalBytes = 0
  for (const valueImage of value) {
    const image = asRecord(valueImage)
    if (
      image === undefined ||
      !hasExactKeys(image, ['data', 'mimeType']) ||
      typeof image.data !== 'string' ||
      !isImageMimeType(image.mimeType) ||
      !isBase64(image.data) ||
      !hasImageSignature(image.data, image.mimeType)
    ) {
      return undefined
    }
    const bytes = decodedBase64Bytes(image.data)
    totalBytes += bytes
    if (bytes > MAXIMUM_CHAT_IMAGE_BYTES || totalBytes > MAXIMUM_CHAT_IMAGE_TOTAL_BYTES) {
      return undefined
    }
    images.push({ data: image.data, mimeType: image.mimeType })
  }
  return images
}

function userMessageContent(
  command: RelayUserCommand,
  content = command.content,
): string | Array<RelayImage | { readonly text: string; readonly type: 'text' }> {
  if (command.images === undefined) {
    return content
  }
  return [
    ...(content.length === 0 ? [] : [{ text: content, type: 'text' as const }]),
    ...command.images.map((image) => ({ ...image, type: 'image' as const })),
  ]
}

function isBase64(value: string): boolean {
  return value.length >= 4 &&
    value.length <= Math.ceil(MAXIMUM_CHAT_IMAGE_BYTES / 3) * 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}

function isSafeUploadPath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= 4_096 &&
    isAbsolute(value) &&
    /[/\\]web-herdr-uploads-[A-Za-z0-9_-]+[/\\][0-9a-f-]{36}(?:\.[A-Za-z0-9]{1,16})?$/.test(value)
}

function isSafeFileName(value: unknown): value is string {
  return typeof value === 'string' &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 96 &&
    value !== '.' &&
    value !== '..' &&
    !/[\u0000-\u001F\u007F/\\]/.test(value)
}

function hasImageSignature(data: string, mimeType: RelayImage['mimeType']): boolean {
  const bytes = Buffer.from(data.slice(0, 24), 'base64')
  if (mimeType === 'image/jpeg') {
    return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF
  }
  if (mimeType === 'image/png') {
    return bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4E &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0D &&
      bytes[5] === 0x0A &&
      bytes[6] === 0x1A &&
      bytes[7] === 0x0A
  }
  if (mimeType === 'image/gif') {
    return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
  }
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function decodedBase64Bytes(data: string): number {
  const paddingBytes = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - paddingBytes
}

function isImageMimeType(value: unknown): value is RelayImage['mimeType'] {
  return value === 'image/gif' || value === 'image/jpeg' || value === 'image/png' || value === 'image/webp'
}

function boundedValue(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximum
    ? value.trim()
    : undefined
}

function isBounded(value: string, maximum: number): boolean {
  return value.trim().length > 0 && value.trim().length <= maximum
}

function isThinkingLevel(value: unknown): value is 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
}
