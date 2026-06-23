import { Data } from "effect";

import { makeStatusLineStateKey } from "../core/state";

/** One LSP client summary published by the LSP extension. */
export type LspClientSnapshot = {
	readonly id: string;
	readonly label: string;
};

/** LSP runtime state for display in the status line. */
export type LspStatus = Data.TaggedEnum<{
	Unknown: {};
	NotRunning: {};
	Running: {
		readonly running: ReadonlyArray<LspClientSnapshot>;
		readonly broken: ReadonlyArray<LspClientSnapshot>;
	};
}>;

/** Constructors and matchers for {@link LspStatus}. */
export const LspStatus = Data.taggedEnum<LspStatus>();

/** State key for the LSP feature. */
export const LSP_STATUS = makeStatusLineStateKey<LspStatus>({
	id: "lsp",
	initial: LspStatus.NotRunning(),
	equals: lspStatusEquals,
});

/** Compare LSP status states. */
export function lspStatusEquals(left: LspStatus, right: LspStatus): boolean {
	return LspStatus.$match(left, {
		Unknown: () => LspStatus.$is("Unknown")(right),
		NotRunning: () => LspStatus.$is("NotRunning")(right),
		Running: (running) =>
			LspStatus.$is("Running")(right) &&
			lspClientsEqual(running.running, right.running) &&
			lspClientsEqual(running.broken, right.broken),
	});
}

const lspClientsEqual = (
	left: ReadonlyArray<LspClientSnapshot>,
	right: ReadonlyArray<LspClientSnapshot>,
): boolean => {
	if (left.length !== right.length) return false;
	return left.every((client, index) => {
		const other = right[index];
		return other !== undefined && client.id === other.id && client.label === other.label;
	});
};
