import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { failTarget, type HerdrFileSystemFailed, type TargetNotResolved } from "./errors";
import { liveAgent } from "./herdr-cli";
import { findEntry, nowIso, updateEntryHints } from "./store";
import type { HerdrSubagentParams, RegistryEntry, ResolvedPane } from "./types";

type HerdrPaneRequirements = ChildProcessSpawner | FileSystem | Path;

const presentUnique = (candidates: ReadonlyArray<string | undefined>): ReadonlyArray<string> => {
	const seen = new Set<string>();
	const values: string[] = [];
	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		values.push(candidate);
	}
	return values;
};

const resolutionCandidates = (
	target: string,
	entry: RegistryEntry | undefined,
): ReadonlyArray<string> => {
	if (!entry) {
		return [target];
	}
	if (entry.terminalId) {
		return presentUnique([entry.terminalId, entry.label, target]);
	}
	return presentUnique([entry.target, entry.paneId, entry.label, target]);
};

export const resolvePane: (
	target: string,
	entries: ReadonlyArray<RegistryEntry>,
) => Effect.Effect<ResolvedPane, HerdrFileSystemFailed | TargetNotResolved, HerdrPaneRequirements> =
	Effect.fnUntraced(function* (target, entries) {
		const entry = findEntry(entries, target);
		const candidates = resolutionCandidates(target, entry);

		for (const candidate of candidates) {
			const agent = yield* liveAgent(candidate);
			const paneId = agent?.pane_id;
			if (agent && paneId) {
				if (entry) {
					const updated: RegistryEntry = {
						...entry,
						phase: "active",
						target: agent.terminal_id ?? paneId,
						paneId,
						terminalId: agent.terminal_id ?? entry.terminalId,
						tabId: agent.tab_id ?? entry.tabId,
						workspaceId: agent.workspace_id ?? entry.workspaceId,
						updatedAt: yield* nowIso,
					};
					yield* updateEntryHints(updated);
				}
				return { name: entry?.name ?? target, paneId, liveAgent: agent };
			}
		}

		if (entry?.paneId && !entry.terminalId) {
			return { name: entry.name, paneId: entry.paneId };
		}
		if (target.includes(":p") || /^\w+-p\d+$/.test(target)) {
			return { name: target, paneId: target };
		}
		const known = entries.map((knownEntry) => knownEntry.name);
		return yield* failTarget(
			`Could not resolve subagent or pane target: ${target}. ${
				known.length > 0 ? `Known subagents: ${known.join(", ")}.` : "No subagents are registered."
			} Run the status action to list live agents and pane ids.`,
		);
	});

export const requireTarget = (params: HerdrSubagentParams): string | undefined =>
	params.target ?? params.name;
