/**
 * Context command extension.
 *
 * Registers `/context` to show the current prompt/context snapshot in a
 * temporary, dismissible TUI overlay without adding anything to the session.
 */

import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type ContextView = "all" | "overview" | "files" | "skills" | "prompt" | "conversation";

type ContextDocument = {
	readonly title: string;
	readonly lines: ReadonlyArray<string>;
};

type BranchEntry = ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>[number];

const CONTEXT_VIEWS: ReadonlyArray<ContextView> = [
	"all",
	"overview",
	"files",
	"skills",
	"prompt",
	"conversation",
];

const VIEW_COMPLETIONS: ReadonlyArray<AutocompleteItem> = CONTEXT_VIEWS.map((view) => ({
	value: view,
	label: view,
}));

const VIEW_ALIASES: Readonly<Record<string, ContextView>> = {
	"": "all",
	base: "overview",
	ctx: "all",
	file: "files",
	contextfiles: "files",
	skill: "skills",
	system: "prompt",
	systemprompt: "prompt",
	raw: "prompt",
	chat: "conversation",
	messages: "conversation",
	session: "conversation",
};

class ContextOverlay {
	private scrollOffset = 0;
	private cachedWidth: number | undefined;
	private cachedLines: ReadonlyArray<string> | undefined;
	private lastViewportHeight = 1;
	private lastMaxScroll = 0;

	constructor(
		private readonly document: ContextDocument,
		private readonly theme: Theme,
		private readonly close: () => void,
		private readonly requestRender: () => void,
		private readonly getTerminalRows: () => number,
	) {}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.ctrl("c")) ||
			data === "q"
		) {
			this.close();
			return;
		}

		const previousOffset = this.scrollOffset;
		const page = Math.max(1, this.lastViewportHeight - 1);

		if (matchesKey(data, Key.up) || data === "k") {
			this.scrollOffset -= 1;
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.scrollOffset += 1;
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
			this.scrollOffset -= page;
		} else if (
			matchesKey(data, Key.pageDown) ||
			matchesKey(data, Key.ctrl("f")) ||
			matchesKey(data, Key.space)
		) {
			this.scrollOffset += page;
		} else if (matchesKey(data, Key.home) || data === "g") {
			this.scrollOffset = 0;
		} else if (matchesKey(data, Key.end) || data === "G") {
			this.scrollOffset = this.lastMaxScroll;
		}

		this.clampScrollOffset();
		if (this.scrollOffset !== previousOffset) this.requestRender();
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth(this.document.title, width, "")];

		const contentWidth = Math.max(1, width - 2);
		const contentLines = this.getWrappedLines(contentWidth);
		const maxRows = this.getMaxRows();
		const viewportHeight = Math.max(1, Math.min(contentLines.length, maxRows - 4));
		this.lastViewportHeight = viewportHeight;
		this.lastMaxScroll = Math.max(0, contentLines.length - viewportHeight);
		this.clampScrollOffset();

		const top = this.theme.fg("border", `╭${"─".repeat(contentWidth)}╮`);
		const bottom = this.theme.fg("border", `╰${"─".repeat(contentWidth)}╯`);
		const row = (content: string): string =>
			this.theme.fg("border", "│") +
			padRightAnsi(content, contentWidth) +
			this.theme.fg("border", "│");

		const firstVisibleLine = this.scrollOffset + 1;
		const lastVisibleLine = Math.min(contentLines.length, this.scrollOffset + viewportHeight);
		const scrollLabel = `${formatCount(firstVisibleLine)}-${formatCount(lastVisibleLine)}/${formatCount(contentLines.length)}`;
		const title = ` ${this.theme.fg("accent", this.theme.bold(this.document.title))} ${this.theme.fg("dim", scrollLabel)}`;
		const footer =
			this.lastMaxScroll > 0
				? "↑↓/j/k scroll • PgUp/PgDn/Space page • Home/End • q/Esc/Enter dismiss"
				: "q/Esc/Enter dismiss";

		const visibleContent = contentLines.slice(
			this.scrollOffset,
			this.scrollOffset + viewportHeight,
		);
		return [
			top,
			row(title),
			...visibleContent.map(row),
			row(this.theme.fg("dim", ` ${footer}`)),
			bottom,
		];
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private getMaxRows(): number {
		const terminalRows = Math.max(1, this.getTerminalRows());
		const marginAdjustedRows = Math.max(1, terminalRows - 2);
		const percentageRows = Math.max(1, Math.floor(terminalRows * 0.88));
		return Math.min(marginAdjustedRows, percentageRows);
	}

	private getWrappedLines(contentWidth: number): ReadonlyArray<string> {
		if (this.cachedWidth === contentWidth && this.cachedLines !== undefined)
			return this.cachedLines;

		const wrapped: string[] = [];
		let inCodeBlock = false;
		for (const line of this.document.lines) {
			const displayLine = sanitizeDisplayLine(line);
			const isFence = displayLine === "```";
			const styledLine = this.styleLine(displayLine, inCodeBlock);
			const nextLines = styledLine.length === 0 ? [""] : wrapTextWithAnsi(styledLine, contentWidth);
			wrapped.push(...(nextLines.length > 0 ? nextLines : [""]));
			if (isFence) inCodeBlock = !inCodeBlock;
		}

		this.cachedWidth = contentWidth;
		this.cachedLines = wrapped.length > 0 ? wrapped : ["(empty)"];
		return this.cachedLines;
	}

	private styleLine(line: string, inCodeBlock: boolean): string {
		if (line === "```") return this.theme.fg("dim", line);
		if (inCodeBlock) return line;
		if (line.startsWith("# ")) return this.theme.fg("accent", this.theme.bold(line.slice(2)));
		if (line.startsWith("## ")) return this.theme.fg("accent", this.theme.bold(line.slice(3)));
		if (line.startsWith("### ")) return this.theme.fg("muted", this.theme.bold(line.slice(4)));
		return line;
	}

	private clampScrollOffset(): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.lastMaxScroll));
	}
}

/**
 * Register the `/context` command.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show current prompt/context in a dismissible overlay",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const normalized = normalizeViewInput(prefix);
			const matches = VIEW_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? [...matches] : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/context is only available in the interactive TUI", "warning");
				return;
			}

			const view = parseContextView(args);
			if (view === undefined) {
				ctx.ui.notify(`Usage: /context [${CONTEXT_VIEWS.join("|")}]`, "warning");
				return;
			}

			const document = buildContextDocument(pi, ctx, view);
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new ContextOverlay(
						document,
						theme,
						() => done(undefined),
						() => tui.requestRender(),
						() => tui.terminal.rows,
					),
				{
					overlay: true,
					overlayOptions: {
						width: "92%",
						minWidth: 40,
						maxHeight: "88%",
						anchor: "center",
						margin: 1,
					},
				},
			);
		},
	});
}

function buildContextDocument(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	view: ContextView,
): ContextDocument {
	const options = ctx.getSystemPromptOptions();
	const lines: string[] = [];
	const title = view === "all" ? "/context" : `/context ${view}`;

	lines.push("# Pi Context Snapshot");
	lines.push("");
	appendOverview(lines, pi, ctx, options);

	if (view === "all" || view === "files") appendContextFiles(lines, options);
	if (view === "all" || view === "skills") appendSkills(lines, options);
	if (view === "all" || view === "prompt") appendPromptInputs(lines, options);
	if (view === "all" || view === "prompt") appendSystemPrompt(lines, ctx.getSystemPrompt());
	if (view === "all" || view === "conversation") appendConversation(lines, ctx);

	return { title, lines };
}

function appendOverview(
	lines: string[],
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	options: BuildSystemPromptOptions,
): void {
	appendSection(lines, "Overview");

	const usage = ctx.getContextUsage();
	const sessionFile = ctx.sessionManager.getSessionFile() ?? "(ephemeral)";
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
	const contextFiles = options.contextFiles ?? [];
	const skills = options.skills ?? [];
	const promptSkills = skills.filter((skill) => !skill.disableModelInvocation);
	const commandOnlySkills = skills.length - promptSkills.length;
	const activeTools = pi.getActiveTools();

	lines.push(`CWD: ${ctx.cwd}`);
	lines.push(`Session: ${sessionFile}`);
	lines.push(`Model: ${model}`);
	lines.push(`Thinking: ${pi.getThinkingLevel()}`);
	lines.push(`Context usage: ${formatUsage(usage)}`);
	lines.push(`Project trusted: ${ctx.isProjectTrusted() ? "yes" : "no"}`);
	lines.push(
		`Active tools (${formatCount(activeTools.length)}): ${activeTools.join(", ") || "(none)"}`,
	);
	lines.push(`Loaded context files: ${formatCount(contextFiles.length)}`);
	lines.push(
		`Loaded skills: ${formatCount(promptSkills.length)} in prompt${
			commandOnlySkills > 0 ? `, ${formatCount(commandOnlySkills)} command-only` : ""
		}`,
	);
	lines.push(`Branch entries: ${formatCount(ctx.sessionManager.getBranch().length)}`);
}

function appendContextFiles(lines: string[], options: BuildSystemPromptOptions): void {
	appendSection(lines, "Loaded context files");
	const contextFiles = options.contextFiles ?? [];
	if (contextFiles.length === 0) {
		lines.push("(none)");
		return;
	}

	for (const file of contextFiles) {
		lines.push(`### ${file.path}`);
		lines.push(
			`Characters: ${formatCount(file.content.length)} • Lines: ${formatCount(countLines(file.content))}`,
		);
		appendCodeBlock(lines, file.content);
	}
}

function appendSkills(lines: string[], options: BuildSystemPromptOptions): void {
	appendSection(lines, "Loaded skills");
	const skills = options.skills ?? [];
	if (skills.length === 0) {
		lines.push("(none)");
		return;
	}

	for (const skill of skills) {
		const mode = skill.disableModelInvocation ? "command-only" : "in prompt";
		lines.push(`- ${skill.name} (${mode}) — ${skill.description}`);
		lines.push(`  file: ${skill.filePath}`);
	}
}

function appendPromptInputs(lines: string[], options: BuildSystemPromptOptions): void {
	appendSection(lines, "System prompt inputs");

	lines.push(`Selected tools: ${(options.selectedTools ?? []).join(", ") || "(default)"}`);
	appendOptionalBlock(lines, "Custom system prompt", options.customPrompt);
	appendList(lines, "Prompt guidelines", options.promptGuidelines ?? []);
	appendOptionalBlock(lines, "Appended system prompt", options.appendSystemPrompt);

	const toolSnippets = Object.entries(options.toolSnippets ?? {}).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	lines.push("### Tool snippets");
	if (toolSnippets.length === 0) {
		lines.push("(none)");
	} else {
		for (const [toolName, snippet] of toolSnippets) {
			lines.push(`- ${toolName}: ${snippet}`);
		}
	}
}

function appendSystemPrompt(lines: string[], systemPrompt: string): void {
	appendSection(lines, "Effective system prompt");
	lines.push(
		"This is ctx.getSystemPrompt(): pi's current base system prompt, including tools, guidelines, loaded context files, skills, and appended prompt text.",
	);
	appendCodeBlock(lines, systemPrompt);
}

function appendConversation(lines: string[], ctx: ExtensionCommandContext): void {
	appendSection(lines, "Session branch summary");
	const branch = ctx.sessionManager.getBranch();
	if (branch.length === 0) {
		lines.push("(empty session)");
		return;
	}

	lines.push(
		"The normal chat is already visible; this section summarizes branch entries that can affect context.",
	);
	lines.push("");
	for (const entry of branch) appendBranchEntrySummary(lines, entry);
}

function appendBranchEntrySummary(lines: string[], entry: BranchEntry): void {
	switch (entry.type) {
		case "message": {
			const role = getStringField(entry.message, "role") ?? "message";
			const excluded = getBooleanField(entry.message, "excludeFromContext");
			const label = excluded ? `${role} (excluded from context)` : role;
			lines.push(`- ${entry.id} ${label}: ${messagePreview(entry.message)}`);
			return;
		}
		case "compaction":
			lines.push(
				`- ${entry.id} compaction: ${formatCount(entry.tokensBefore)} tokens summarized; keeps from ${entry.firstKeptEntryId}; ${singleLine(entry.summary)}`,
			);
			return;
		case "branch_summary":
			lines.push(`- ${entry.id} branch summary from ${entry.fromId}: ${singleLine(entry.summary)}`);
			return;
		case "custom_message":
			lines.push(
				`- ${entry.id} custom message (${entry.customType}, display=${entry.display ? "yes" : "no"}): ${contentPreview(entry.content)}`,
			);
			return;
		case "model_change":
			lines.push(`- ${entry.id} model change: ${entry.provider}/${entry.modelId}`);
			return;
		case "thinking_level_change":
			lines.push(`- ${entry.id} thinking change: ${entry.thinkingLevel}`);
			return;
		case "custom":
			lines.push(`- ${entry.id} extension state (${entry.customType}; not sent to model)`);
			return;
		case "label":
			lines.push(`- ${entry.id} label: ${entry.targetId} → ${entry.label ?? "(cleared)"}`);
			return;
		case "session_info":
			lines.push(`- ${entry.id} session info: ${entry.name ?? "(no name)"}`);
			return;
	}
}

function appendSection(lines: string[], title: string): void {
	if (lines.length > 0) lines.push("");
	lines.push(`## ${title}`);
	lines.push("");
}

function appendOptionalBlock(lines: string[], title: string, content: string | undefined): void {
	lines.push(`### ${title}`);
	if (content === undefined || content.length === 0) {
		lines.push("(none)");
		return;
	}

	appendCodeBlock(lines, content);
}

function appendList(lines: string[], title: string, items: ReadonlyArray<string>): void {
	lines.push(`### ${title}`);
	if (items.length === 0) {
		lines.push("(none)");
		return;
	}

	for (const item of items) lines.push(`- ${item}`);
}

function appendCodeBlock(lines: string[], content: string): void {
	if (content.length === 0) {
		lines.push("(empty)");
		return;
	}

	lines.push("```");
	lines.push(...splitLines(content));
	lines.push("```");
}

function parseContextView(input: string): ContextView | undefined {
	const normalized = normalizeViewInput(input);
	return contextViewFromNormalized(normalized) ?? VIEW_ALIASES[normalized];
}

function contextViewFromNormalized(input: string): ContextView | undefined {
	switch (input) {
		case "all":
		case "overview":
		case "files":
		case "skills":
		case "prompt":
		case "conversation":
			return input;
		default:
			return undefined;
	}
}

function normalizeViewInput(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/^--?/, "")
		.replace(/[\s_-]+/g, "");
}

function messagePreview(message: unknown): string {
	const role = getStringField(message, "role");
	if (role === "bashExecution") {
		const command = getStringField(message, "command") ?? "";
		const output = getStringField(message, "output") ?? "";
		return singleLine(`$ ${command}${output.length > 0 ? ` → ${output}` : ""}`);
	}

	if (role === "toolResult") {
		const toolName = getStringField(message, "toolName") ?? "tool";
		return singleLine(`${toolName}: ${contentPreview(getField(message, "content"))}`);
	}

	return contentPreview(getField(message, "content"));
}

function contentPreview(content: unknown): string {
	if (typeof content === "string") return singleLine(content);
	if (!Array.isArray(content)) return "(no text)";

	const parts = content.map(contentBlockPreview).filter((part) => part.length > 0);
	return singleLine(parts.join(" ") || "(no text)");
}

function contentBlockPreview(block: unknown): string {
	if (!isRecord(block)) return "[content]";

	const type = block["type"];
	if (type === "text") {
		const text = block["text"];
		return typeof text === "string" ? text : "";
	}

	if (type === "thinking") {
		const thinking = block["thinking"];
		return typeof thinking === "string"
			? `[thinking block: ${formatCount(thinking.length)} chars]`
			: "[thinking block]";
	}

	if (type === "toolCall") {
		const name = block["name"];
		return typeof name === "string" ? `[tool call: ${name}]` : "[tool call]";
	}

	if (type === "image") {
		const mediaType = block["mediaType"];
		return typeof mediaType === "string" ? `[image: ${mediaType}]` : "[image]";
	}

	return typeof type === "string" ? `[${type}]` : "[content]";
}

function formatUsage(usage: ReturnType<ExtensionCommandContext["getContextUsage"]>): string {
	if (usage === undefined) return "unknown";
	const tokens = usage.tokens === null ? "unknown" : formatCount(usage.tokens);
	const percent = usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
	return `${tokens}/${formatCount(usage.contextWindow)} tokens (${percent})`;
}

function singleLine(value: string, maxLength = 240): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact || "(empty)";
	return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sanitizeDisplayLine(value: string): string {
	let result = "";
	for (const character of value) {
		if (character === "\t") {
			result += "    ";
			continue;
		}

		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && isUnsafeTerminalControl(codePoint)) {
			result += formatControlCodePoint(codePoint);
			continue;
		}

		result += character;
	}
	return result;
}

function isUnsafeTerminalControl(codePoint: number): boolean {
	return (
		(codePoint >= 0 && codePoint <= 8) ||
		codePoint === 11 ||
		codePoint === 12 ||
		(codePoint >= 14 && codePoint <= 31) ||
		codePoint === 127 ||
		(codePoint >= 128 && codePoint <= 159)
	);
}

function formatControlCodePoint(codePoint: number): string {
	return `\\x${codePoint.toString(16).padStart(2, "0")}`;
}

function splitLines(value: string): string[] {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function countLines(value: string): number {
	if (value.length === 0) return 0;
	return splitLines(value).length;
}

function formatCount(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function padRightAnsi(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "…");
	const padding = Math.max(0, width - visibleWidth(truncated));
	return `${truncated}${" ".repeat(padding)}`;
}

function getField(value: unknown, key: string): unknown {
	if (!isRecord(value)) return undefined;
	return value[key];
}

function getStringField(value: unknown, key: string): string | undefined {
	const field = getField(value, key);
	return typeof field === "string" ? field : undefined;
}

function getBooleanField(value: unknown, key: string): boolean {
	const field = getField(value, key);
	return field === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
