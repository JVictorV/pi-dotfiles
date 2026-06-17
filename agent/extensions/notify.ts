/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting
 * for input.
 *
 * Prefers `growlrrr` (the `grrr` CLI), a modern UserNotifications-based helper
 * that actually works on macOS 26+ (terminal-notifier relies on the removed
 * NSUserNotification API and silently no-ops on Tahoe). Falls back to
 * `osascript display notification` (shows under the "Script Editor" label)
 * when grrr is not installed.
 *
 * Click target: grrr's `--reactivate` only raises the Ghostty *app*, landing on
 * whatever tab was last active — not necessarily the one running pi. When the
 * terminal is Ghostty AND the session has a name, we instead use `--execute`
 * to run an AppleScript that activates Ghostty and clicks the "Window" menu
 * item whose title contains the session name. Ghostty lists every tab/surface
 * as a separate Window-menu entry (titled `π - <session> - <dir>` via shell
 * integration), so clicking that entry focuses the exact originating tab, even
 * across windows and spaces. If the title can't be matched the AppleScript has
 * already activated Ghostty, so it degrades to the old reactivate behavior.
 * Unnamed sessions / non-Ghostty terminals fall back to `--reactivate`.
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

/** Wrap a string as a POSIX-sh single-quoted literal (for `sh -c`, which grrr uses). */
const shSingleQuote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;

/** True when running inside Ghostty (Window-menu tab focusing only applies there). */
const isGhostty = process.env.TERM_PROGRAM === "ghostty";

/**
 * Build a `sh -c` command that activates Ghostty and clicks the Window-menu
 * entry whose title contains `sessionName`, focusing that exact tab/surface.
 * Requires Accessibility permission for the terminal (System Events scripting).
 */
const buildTabFocusCommand = (sessionName: string): string => {
	const focus =
		'tell application "System Events" to tell process "Ghostty" to tell menu 1 of ' +
		'menu bar item "Window" of menu bar 1 to click (first menu item whose name ' +
		`contains "${escapeAppleScript(sessionName)}")`;
	return `osascript -e ${shSingleQuote('tell application "Ghostty" to activate')} -e ${shSingleQuote(focus)}`;
};

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
const notify = (title: string, body: string, focusName: string | null): void => {
	if (grrrPath) {
		// --appId pi: custom growlrrr app bundle (~/.growlrrr/apps/pi.app) so the
		// notification shows the pi.dev logo. Create/update via:
		//   grrr apps add --appId pi --appIcon ~/.pi/agent/assets/pi-icon.png
		const args = ["--appId", "pi", "--title", title, "--sound", "none"];
		// Focus the exact originating tab when we can (Ghostty + named session);
		// otherwise just raise the app.
		if (isGhostty && focusName) {
			args.push("--execute", buildTabFocusCommand(focusName));
		} else {
			args.push("--reactivate");
		}
		args.push(body || title);
		spawnQuiet(grrrPath, args);
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
		const sessionName = pi.getSessionName()?.trim() || null;
		const { title, body } = formatNotification(lastText, sessionName ?? undefined);
		notify(title, body, sessionName);
	});
}
