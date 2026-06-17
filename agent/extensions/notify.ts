/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting
 * for input.
 *
 * Prefers `growlrrr` (the `grrr` CLI), a modern UserNotifications-based helper
 * that actually works on macOS 26+ (terminal-notifier relies on the removed
 * NSUserNotification API and silently no-ops on Tahoe). `--reactivate` makes a
 * click jump back to the originating Ghostty window/tab. Falls back to
 * `osascript display notification` (shows under the "Script Editor" label)
 * when grrr is not installed.
 *
 * The notification is always shown SILENTLY (`--sound none`); the custom audio
 * (idle.ogg) is played separately by sound.ts via afplay.
 *
 * IMPORTANT: grrr is spawned WITHOUT detached/unref. Its notification delivery
 * is async; detaching it into a new session (e.g. via setsid) reaps the
 * process before delivery completes and the notification never appears. A
 * plain non-blocking spawn lets it finish while pi's event loop keeps running;
 * grrr exits as soon as the notification is registered (the click action is
 * handled later by the growlrrr.app bundle, not this CLI process).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

/** Locate the growlrrr CLI once at load; undefined if not installed. */
const grrrPath = ["/usr/local/bin/grrr", "/opt/homebrew/bin/grrr"].find((candidate) =>
	existsSync(candidate),
);

/** Escape a string for safe inclusion inside an AppleScript double-quoted literal. */
const escapeAppleScript = (text: string): string =>
	text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Non-blocking spawn that never blocks pi or throws. Errors ignored. */
const spawnQuiet = (command: string, args: string[]): void => {
	try {
		const child = spawn(command, args, { stdio: "ignore" });
		child.on("error", () => {});
	} catch {
		// ignore — best effort
	}
};

/**
 * Send a silent native desktop notification. Uses growlrrr (with click-to-
 * reactivate the originating terminal) when available, otherwise falls back to
 * a silent osascript notification.
 */
const notify = (title: string, body: string): void => {
	if (grrrPath) {
		// --appId pi: custom growlrrr app bundle (~/.growlrrr/apps/pi.app) so the
		// notification shows the pi.dev logo. Create/update via:
		//   grrr apps add --appId pi --appIcon ~/.pi/agent/assets/pi-icon.png
		spawnQuiet(grrrPath, [
			"--appId",
			"pi",
			"--title",
			title,
			"--sound",
			"none",
			"--reactivate",
			body || title,
		]);
		return;
	}
	const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`;
	spawnQuiet("osascript", ["-e", script]);
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(
		part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part,
	);

const extractLastAssistantText = (
	messages: Array<{ role?: string; content?: unknown }>,
): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}

		const content = message.content;
		if (typeof content === "string") {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content
				.filter(isTextPart)
				.map((part) => part.text)
				.join("\n")
				.trim();
			return text || null;
		}

		return null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (
	text: string | null,
	sessionTitle: string | undefined,
): { title: string; body: string } => {
	// Prefer the session's generated title (see session-title.ts); fall back to
	// the pi symbol when the session is still unnamed.
	const title = sessionTitle?.trim() || "π";
	const simplified = text ? simpleMarkdown(text) : "";
	const normalized = simplified.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return { title, body: "" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title, body };
};

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event) => {
		const lastText = extractLastAssistantText(event.messages ?? []);
		const { title, body } = formatNotification(lastText, pi.getSessionName());
		notify(title, body);
	});
}
