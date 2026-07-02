import { Effect, Option, Schema } from "effect";

import { FABLE_FALLBACK_MODEL_ID, FABLE_MODEL_ID } from "./state";

const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-06-01";
const OBSERVER_REGISTRY_KEY = Symbol.for("pi.statusline.fableRoutingFetchObserver");
const JsonObjectFromString = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonObjectFromStringOption = Schema.decodeUnknownOption(JsonObjectFromString);
const parseUrlOption = Option.liftThrowable((urlText: string) => new URL(urlText));
const cloneResponseOption = Option.liftThrowable((response: Response) => response.clone());

/** Routing facts emitted by the Anthropic fetch observer. */
export type FableRoutingEvent =
	| { readonly type: "request" }
	| { readonly type: "direct" }
	| { readonly type: "fallback"; readonly model: string }
	| { readonly type: "refusal"; readonly explanation: string | null }
	| { readonly type: "error"; readonly message: string };

type FetchFunction = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFunction>[0];
type FetchInit = Parameters<FetchFunction>[1];
type FableRoutingListener = (event: FableRoutingEvent) => void;

type ObserverRegistry = {
	readonly originalFetch: FetchFunction;
	readonly listeners: Map<number, FableRoutingListener>;
	nextListenerId: number;
};

type PreparedFetchInput = {
	readonly input: FetchInput;
	readonly init: FetchInit;
	readonly observesFableRouting: boolean;
};

type SseEvent = {
	readonly event: string | null;
	readonly data: string;
};

/** Install the Claude Fable routing fetch observer without adding a status listener. */
export function installFableRoutingFetchObserver(): void {
	ensureObserverRegistry();
}

/** Subscribe to Claude Fable routing events observed from Anthropic streaming responses. */
export function subscribeToFableRoutingEvents(listener: FableRoutingListener): () => void {
	const registry = ensureObserverRegistry();
	const listenerId = registry.nextListenerId;
	registry.nextListenerId += 1;
	registry.listeners.set(listenerId, listener);
	return () => {
		registry.listeners.delete(listenerId);
	};
}

function ensureObserverRegistry(): ObserverRegistry {
	const existing = readGlobalRegistry();
	if (existing !== undefined) return existing;

	const registry: ObserverRegistry = {
		originalFetch: globalThis.fetch.bind(globalThis),
		listeners: new Map(),
		nextListenerId: 1,
	};

	writeGlobalRegistry(registry);
	globalThis.fetch = async (input, init) => {
		const prepared = prepareFableAwareFetchInput(input, init);
		const response = await registry.originalFetch(prepared.input, prepared.init);
		if (prepared.observesFableRouting) {
			emitFableRoutingEvent(registry, { type: "request" });
			observeFableRoutingResponse(response, registry);
		}
		return response;
	};

	return registry;
}

function readGlobalRegistry(): ObserverRegistry | undefined {
	const candidate = globalThisWithObserverRegistry()[OBSERVER_REGISTRY_KEY];
	if (candidate === undefined) return undefined;
	return isObserverRegistry(candidate) ? candidate : undefined;
}

function writeGlobalRegistry(registry: ObserverRegistry): void {
	globalThisWithObserverRegistry()[OBSERVER_REGISTRY_KEY] = registry;
}

function globalThisWithObserverRegistry(): typeof globalThis & {
	[OBSERVER_REGISTRY_KEY]?: unknown;
} {
	// SAFETY: Symbol-keyed global storage is used only by this extension. The runtime
	// value is checked by isObserverRegistry before use.
	// oxlint-disable-next-line effect/no-type-casting
	return globalThis as typeof globalThis & { [OBSERVER_REGISTRY_KEY]?: unknown };
}

function isObserverRegistry(candidate: unknown): candidate is ObserverRegistry {
	if (!isRecord(candidate)) return false;
	return typeof candidate["originalFetch"] === "function" && candidate["listeners"] instanceof Map;
}

function prepareFableAwareFetchInput(input: FetchInput, init: FetchInit): PreparedFetchInput {
	const bodyText = getInitBodyText(init);
	const url = getFetchUrl(input);
	if (bodyText === undefined || url === undefined || !isMessagesEndpoint(url)) {
		return { input, init, observesFableRouting: false };
	}

	const parsed = parseJsonObject(bodyText);
	if (parsed === undefined || parsed["model"] !== FABLE_MODEL_ID) {
		return { input, init, observesFableRouting: false };
	}

	const nextPayload = addFableFallback(parsed);
	const headers = withServerSideFallbackBeta(input, init);
	const nextInit = {
		...init,
		headers,
		body: JSON.stringify(nextPayload),
	} satisfies RequestInit;

	return { input, init: nextInit, observesFableRouting: true };
}

function getInitBodyText(init: FetchInit): string | undefined {
	const body = init?.body;
	return typeof body === "string" ? body : undefined;
}

function getFetchUrl(input: FetchInput): string | undefined {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	return undefined;
}

function isMessagesEndpoint(urlText: string): boolean {
	const url = parseUrl(urlText);
	if (url === undefined) return false;
	return url.pathname === "/v1/messages" || url.pathname.endsWith("/v1/messages");
}

function parseUrl(urlText: string): URL | undefined {
	const decoded = parseUrlOption(urlText);
	return Option.isSome(decoded) ? decoded.value : undefined;
}

function withServerSideFallbackBeta(input: FetchInput, init: FetchInit): Headers {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	if (init?.headers !== undefined) {
		new Headers(init.headers).forEach((value, key) => headers.set(key, value));
	}

	const current = headers.get("anthropic-beta") ?? "";
	const values = current
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (!values.includes(SERVER_SIDE_FALLBACK_BETA)) values.push(SERVER_SIDE_FALLBACK_BETA);
	headers.set("anthropic-beta", values.join(","));
	return headers;
}

function addFableFallback(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
	if (payload["fallbacks"] !== undefined) return { ...payload };
	return {
		...payload,
		fallbacks: [{ model: FABLE_FALLBACK_MODEL_ID }],
	};
}

function parseJsonObject(text: string): Readonly<Record<string, unknown>> | undefined {
	const decoded = decodeJsonObjectFromStringOption(text);
	return Option.isSome(decoded) ? decoded.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function observeFableRoutingResponse(response: Response, registry: ObserverRegistry): void {
	const clone = cloneResponseOption(response);
	if (Option.isNone(clone)) {
		emitFableRoutingEvent(registry, {
			type: "error",
			message: "Could not inspect response",
		});
		return;
	}

	Effect.runPromise(consumeFableRoutingResponse(clone.value, registry)).catch(() => {
		emitFableRoutingEvent(registry, {
			type: "error",
			message: "Could not inspect response",
		});
	});
}

const consumeFableRoutingResponse = (
	response: Response,
	registry: ObserverRegistry,
): Effect.Effect<void> =>
	Effect.tryPromise(() => consumeFableRoutingResponseUnsafe(response, registry)).pipe(
		Effect.catch(() =>
			Effect.sync(() => {
				emitFableRoutingEvent(registry, {
					type: "error",
					message: "Could not inspect response",
				});
			}),
		),
	);

async function consumeFableRoutingResponseUnsafe(
	response: Response,
	registry: ObserverRegistry,
): Promise<void> {
	if (!response.ok) {
		emitFableRoutingEvent(registry, { type: "error", message: `HTTP ${response.status}` });
		return;
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/event-stream")) {
		await consumeJsonFableRoutingResponse(response, registry);
		return;
	}

	if (response.body === null) {
		emitFableRoutingEvent(registry, { type: "error", message: "Empty response body" });
		return;
	}

	let sawFallback = false;
	let sawTerminal = false;
	for await (const event of iterateSseEvents(response.body)) {
		const parsed = parseJsonObject(event.data);
		if (parsed === undefined) continue;

		const observed = routingEventFromAnthropicEvent(parsed);
		if (observed === undefined) continue;
		if (observed.type === "fallback") sawFallback = true;
		if (observed.type === "direct" || observed.type === "fallback" || observed.type === "refusal") {
			sawTerminal = true;
		}
		emitFableRoutingEvent(registry, observed);
	}

	if (!sawFallback && !sawTerminal) {
		emitFableRoutingEvent(registry, { type: "direct" });
	}
}

async function consumeJsonFableRoutingResponse(
	response: Response,
	registry: ObserverRegistry,
): Promise<void> {
	const text = await response.text();
	const parsed = parseJsonObject(text);
	if (parsed === undefined) return;
	const model = typeof parsed["model"] === "string" ? parsed["model"] : FABLE_MODEL_ID;
	const stopReason = parsed["stop_reason"];
	if (stopReason === "refusal") {
		emitFableRoutingEvent(registry, {
			type: "refusal",
			explanation: parseRefusalExplanation(parsed),
		});
		return;
	}
	if (model !== FABLE_MODEL_ID) {
		emitFableRoutingEvent(registry, { type: "fallback", model });
		return;
	}
	emitFableRoutingEvent(registry, { type: "direct" });
}

async function* iterateSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const read = await reader.read();
		if (read.done) break;
		buffer += decoder.decode(read.value, { stream: true });
		let boundary = findSseBoundary(buffer);
		while (boundary !== undefined) {
			const rawEvent = buffer.slice(0, boundary.index);
			buffer = buffer.slice(boundary.nextIndex);
			const event = parseSseEvent(rawEvent);
			if (event !== undefined) yield event;
			boundary = findSseBoundary(buffer);
		}
	}
	buffer += decoder.decode();
	const trailing = parseSseEvent(buffer);
	if (trailing !== undefined) yield trailing;
	reader.releaseLock();
}

function findSseBoundary(
	buffer: string,
): { readonly index: number; readonly nextIndex: number } | undefined {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf === -1 && crlf === -1) return undefined;
	if (lf !== -1 && (crlf === -1 || lf < crlf)) return { index: lf, nextIndex: lf + 2 };
	return { index: crlf, nextIndex: crlf + 4 };
}

function parseSseEvent(raw: string): SseEvent | undefined {
	let event: string | null = null;
	const data: string[] = [];
	for (const line of raw.split(/\r?\n/u)) {
		if (!line || line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
		if (field === "event") event = value;
		if (field === "data") data.push(value);
	}
	if (data.length === 0) return undefined;
	return { event, data: data.join("\n") };
}

function routingEventFromAnthropicEvent(
	event: Readonly<Record<string, unknown>>,
): FableRoutingEvent | undefined {
	const type = event["type"];
	if (type === "message_start") return routingEventFromMessageStart(event);
	if (type === "content_block_start") return routingEventFromContentBlockStart(event);
	if (type === "message_delta") return routingEventFromMessageDelta(event);
	return undefined;
}

function routingEventFromMessageStart(
	event: Readonly<Record<string, unknown>>,
): FableRoutingEvent | undefined {
	const message = isRecord(event["message"]) ? event["message"] : undefined;
	const model = typeof message?.["model"] === "string" ? message["model"] : undefined;
	if (model === undefined) return undefined;
	return model === FABLE_MODEL_ID ? { type: "direct" } : { type: "fallback", model };
}

function routingEventFromContentBlockStart(
	event: Readonly<Record<string, unknown>>,
): FableRoutingEvent | undefined {
	const contentBlock = isRecord(event["content_block"]) ? event["content_block"] : undefined;
	if (contentBlock?.["type"] !== "fallback") return undefined;
	const to = isRecord(contentBlock["to"]) ? contentBlock["to"] : undefined;
	const model = typeof to?.["model"] === "string" ? to["model"] : FABLE_FALLBACK_MODEL_ID;
	return { type: "fallback", model };
}

function routingEventFromMessageDelta(
	event: Readonly<Record<string, unknown>>,
): FableRoutingEvent | undefined {
	const delta = isRecord(event["delta"]) ? event["delta"] : undefined;
	if (delta?.["stop_reason"] === "refusal") {
		return {
			type: "refusal",
			explanation: parseRefusalExplanation(delta),
		};
	}

	const usage = isRecord(event["usage"]) ? event["usage"] : undefined;
	const fallbackModel = fallbackModelFromUsage(usage);
	return fallbackModel === undefined ? undefined : { type: "fallback", model: fallbackModel };
}

function parseRefusalExplanation(source: Readonly<Record<string, unknown>>): string | null {
	const details = isRecord(source["stop_details"]) ? source["stop_details"] : undefined;
	const explanation = details?.["explanation"];
	return typeof explanation === "string" && explanation.length > 0 ? explanation : null;
}

function fallbackModelFromUsage(
	usage: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
	const iterations = usage?.["iterations"];
	if (!Array.isArray(iterations)) return undefined;
	for (const entry of iterations) {
		if (!isRecord(entry) || entry["type"] !== "fallback_message") continue;
		const model = entry["model"];
		return typeof model === "string" ? model : FABLE_FALLBACK_MODEL_ID;
	}
	return undefined;
}

function emitFableRoutingEvent(registry: ObserverRegistry, event: FableRoutingEvent): void {
	for (const listener of registry.listeners.values()) {
		listener(event);
	}
}
