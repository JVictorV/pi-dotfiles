// oxlint-disable effect/no-vitest-import -- Project tests use Vitest directly.
// oxlint-disable effect/no-timer-api-in-effect effect/no-raw-throw effect/no-try-catch -- Plain Vitest integration test, not Effect domain code.
// oxlint-disable effect/no-type-casting -- SAFETY: This integration test builds focused
// fakes for the subset of ExtensionAPI/ExtensionContext/Theme the status line uses and
// casts them to the real types at the boundary; the extension only touches the faked members.
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import statusLineExtension from "./index";

type Renderable = {
	render(width?: number): string[];
	invalidate(): void;
	dispose?(): void;
};

type FakeTui = { requestRender(): void };
type WidgetFactory = (tui: FakeTui, theme: Theme) => Renderable;
type FooterFactory = (
	tui: FakeTui,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => Renderable;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const identityTheme = { fg: (_color: string, value: string) => value } as unknown as Theme;

/** Build a status line under test with controllable footer extension statuses. */
function mountStatusLine() {
	const eventHandlers = new Map<string, (...args: ReadonlyArray<unknown>) => unknown>();
	const footerStatuses = new Map<string, string>();
	const footerData = {
		getExtensionStatuses: () => footerStatuses,
		getGitBranch: () => null,
		onBranchChange: () => () => {},
	} as unknown as ReadonlyFooterDataProvider;

	let widget: Renderable | undefined;
	let footer: Renderable | undefined;
	const tui: FakeTui = { requestRender: () => {} };

	const pi = {
		// git/gh always "unavailable" so the repository feature never spawns real subprocesses.
		exec: async () => ({ stdout: "", stderr: "", code: 1 }),
		getThinkingLevel: () => "off",
		on: (event: string, handler: (...args: ReadonlyArray<unknown>) => unknown) => {
			eventHandlers.set(event, handler);
		},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		getContextUsage: () => null,
		model: undefined,
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionName: () => undefined,
		},
		ui: {
			setWidget: (_id: string, factory: WidgetFactory) => {
				widget = factory(tui, identityTheme);
			},
			setFooter: (factory: FooterFactory) => {
				footer = factory(tui, identityTheme, footerData);
			},
		},
	} as unknown as ExtensionContext;

	statusLineExtension(pi);
	const sessionStart = eventHandlers.get("session_start");
	if (sessionStart === undefined) throw new Error("session_start handler was not registered");
	sessionStart({ reason: "startup" }, ctx);
	if (widget === undefined || footer === undefined) {
		throw new Error("status line widget/footer were not registered");
	}

	const renderLine = (): string => widget?.render(200)[0] ?? "";
	const shutdown = async (): Promise<void> => {
		await eventHandlers.get("session_shutdown")?.({ reason: "quit" });
	};

	return { footerStatuses, footer, renderLine, shutdown };
}

describe("status line MCP segment", () => {
	test("reflects live footer status changes after the footer mounts", async () => {
		const statusLine = mountStatusLine();
		try {
			statusLine.footer.render();
			await flush();
			expect(statusLine.renderLine()).not.toContain("MCP");

			statusLine.footerStatuses.set("mcp", "MCP: 2/2 servers");
			statusLine.footer.render();
			await flush();
			expect(statusLine.renderLine()).toContain("MCP: 2/2");

			statusLine.footerStatuses.set("mcp", "MCP: 1/2 servers");
			statusLine.footer.render();
			await flush();
			expect(statusLine.renderLine()).toContain("MCP: 1/2");
		} finally {
			await statusLine.shutdown();
		}
	});
});
