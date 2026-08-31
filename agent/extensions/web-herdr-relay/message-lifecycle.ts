import {
  asRecord,
  normalizeMessage,
  type RelayMessage,
} from './normalization'

/** Browser-safe relay action produced when Pi starts one message. */
export type StartedMessageAction =
  | { readonly _tag: 'PublishUserMessage'; readonly message: RelayMessage }
  | { readonly _tag: 'StartAssistant' }
  | { readonly _tag: 'Ignore' }

/**
 * Map a Pi `message_start` event to the immediate browser relay action.
 *
 * Pi emits this event when Prompt, Steer, or FollowUp content is delivered.
 * Publishing the user message here keeps it ahead of assistant streaming.
 *
 * @param message - The untrusted Pi message.
 * @param id - The transient relay ID for the message.
 * @param fallbackTimestamp - The timestamp to use when Pi omits one.
 * @param sessionPaths - Session paths that must be redacted.
 * @returns The safe action for the relay.
 */
export function startedMessageAction(
  message: unknown,
  id: string,
  fallbackTimestamp: number,
  sessionPaths: ReadonlyArray<string>,
): StartedMessageAction {
  const record = asRecord(message)
  if (record?.role === 'assistant') {
    return { _tag: 'StartAssistant' }
  }
  if (record?.role !== 'user') {
    return { _tag: 'Ignore' }
  }
  const userMessage = normalizeMessage(id, message, fallbackTimestamp, sessionPaths)
  return userMessage !== undefined
    && (userMessage.text.length > 0 || userMessage.images !== undefined)
    ? { _tag: 'PublishUserMessage', message: userMessage }
    : { _tag: 'Ignore' }
}
