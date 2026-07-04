import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { failTarget, type HerdrFileSystemFailed, type TargetNotResolved } from "./errors";
import { liveAgent } from "./herdr-cli";
import { mutateRegistry, nowIso } from "./registry";
import type { HerdrSubagentParams, Registry, RegistryEntry, ResolvedPane } from "./types";

type HerdrPaneRequirements = ChildProcessSpawner | FileSystem | Path;

export const resolvePane: (
	target: string,
	registry: Registry,
) => Effect.Effect<ResolvedPane, HerdrFileSystemFailed | TargetNotResolved, HerdrPaneRequirements> =
	Effect.fnUntraced(function* (target, registry) {
		const entry = registry.entries[target];
		const candidates = [entry?.target, entry?.terminalId, entry?.paneId, target].filter(
			(candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
		);

		for (const candidate of candidates) {
			const agent = yield* liveAgent(candidate);
			const paneId = agent?.pane_id;
			if (agent && paneId) {
				if (entry) {
					const updated: RegistryEntry = {
						...entry,
						target: agent.terminal_id ?? paneId,
						paneId,
						terminalId: agent.terminal_id ?? entry.terminalId,
						tabId: agent.tab_id ?? entry.tabId,
						workspaceId: agent.workspace_id ?? entry.workspaceId,
						updatedAt: yield* nowIso,
					};
					yield* mutateRegistry((entries) =>
						entries[entry.name] ? { ...entries, [entry.name]: updated } : entries,
					);
				}
				return { name: entry?.name ?? target, paneId, liveAgent: agent };
			}
		}

		if (entry) {
			return { name: entry.name, paneId: entry.paneId };
		}
		if (target.includes(":p") || /^\w+-p\d+$/.test(target)) {
			return { name: target, paneId: target };
		}
		const known = Object.keys(registry.entries);
		return yield* failTarget(
			`Could not resolve subagent or pane target: ${target}. ${
				known.length > 0 ? `Known subagents: ${known.join(", ")}.` : "No subagents are registered."
			} Run the status action to list live agents and pane ids.`,
		);
	});

export const requireTarget = (params: HerdrSubagentParams): string | undefined =>
	params.target ?? params.name;
