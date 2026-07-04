import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Layer, ManagedRuntime } from "effect";

import { executeAction } from "./actions";
import { ACTIONS, AGENT_SCOPES, SOURCES, WAIT_STATUSES, type HerdrSubagentParams } from "./types";

const nodeLayer = Layer.provideMerge(
	NodeChildProcessSpawner.layer,
	Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
);
// ExtensionAPI exposes session lifecycle hooks but no extension unload/reload teardown; this
// stateless Node layer only allocates per-run Scope resources, so a /reload orphan is GC-reclaimable.
const nodeRuntime = ManagedRuntime.make(nodeLayer);

/** Register herdr-backed pi subagent orchestration tools. */
export default function herdrSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "herdr_subagent",
		label: "Herdr Subagent",
		description:
			"Spawn and control pi subagents as real herdr tabs/panels. Supports status, agent-types, spawn, inspect, send, wait, focus, and close. Requires HERDR_ENV=1 for panel control.",
		promptSnippet:
			"Spawn, inspect, command, wait on, focus, and close pi subagents in herdr tabs/panels",
		promptGuidelines: [
			"Use herdr_subagent when the user asks to orchestrate subagents, spawn panel-backed agents, inspect agent panels, or coordinate work across herdr.",
			"Call herdr_subagent with action=status before controlling existing panel-backed subagents.",
			"When using herdr_subagent action=spawn, pass an explicit model unless the user specifically asks to inherit the current/default model.",
			"For herdr_subagent implementation workers, scouts, tests, migrations, data analysis, and clear-spec mechanical work, prefer model openai-codex/gpt-5.5 with thinking medium/high.",
			"For herdr_subagent reviewers, planners, ambiguous investigations, architecture/API/UI/copy judgment, and synthesis, prefer model anthropic/claude-opus-4-8 with thinking high/xhigh.",
			"Avoid spawning anthropic/claude-fable-5 with herdr_subagent by default; Fable should usually orchestrate rather than work. Use it only for pure high-taste critique/copy/UI direction or explicit subjective comparisons.",
			"Prefer one herdr_subagent spawn per task, with tab labels like agent: <name>; inspect a subagent panel before trusting its result.",
			"Keep herdr_subagent fan-out to at most 12 concurrent subagents; start small and scale up only when the task genuinely benefits from parallelism.",
			"For parallel code editing, avoid multiple herdr_subagent workers mutating the same worktree unless the user has explicitly isolated their worktrees.",
		],
		parameters: Type.Object({
			action: StringEnum([...ACTIONS], { description: "Operation to perform." }),
			name: Type.Optional(
				Type.String({
					description: "Registry name for spawn, or a name target for other actions.",
				}),
			),
			target: Type.Optional(
				Type.String({
					description: "Subagent name, terminal id, pane id, or unique herdr agent target.",
				}),
			),
			task: Type.Optional(Type.String({ description: "Task prompt for action=spawn." })),
			agentType: Type.Optional(
				Type.String({
					description: "Optional agent definition from ~/.pi/agent/agents or trusted .pi/agents.",
				}),
			),
			agentScope: Type.Optional(
				StringEnum([...AGENT_SCOPES], { description: "Agent definition scope. Default: user." }),
			),
			confirmProjectAgents: Type.Optional(
				Type.Boolean({
					description: "Confirm before using project-local agent definitions. Default true.",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for a spawned subagent tab." }),
			),
			workspace: Type.Optional(
				Type.String({
					description: "Herdr workspace id for a spawned tab. Defaults to current workspace.",
				}),
			),
			label: Type.Optional(
				Type.String({ description: "Herdr tab/pane label for spawn. Defaults to agent: <name>." }),
			),
			model: Type.Optional(
				Type.String({
					description:
						"pi model for spawned subagent. Usually pass explicitly: openai-codex/gpt-5.5 for workers/scouts/mechanics, anthropic/claude-opus-4-8 for review/planning/taste/synthesis. Overrides agentType model.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"pi thinking level for spawned subagent, e.g. low, medium, high, xhigh. Overrides agentType thinking.",
				}),
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: "Tool allowlist for spawned subagent. Overrides agentType tools.",
				}),
			),
			message: Type.Optional(Type.String({ description: "Follow-up prompt for action=send." })),
			lines: Type.Optional(
				Type.Number({ description: "Lines to read for action=inspect. Default 120." }),
			),
			source: Type.Optional(
				StringEnum([...SOURCES], {
					description: "Pane read source for inspect. Default recent-unwrapped.",
				}),
			),
			status: Type.Optional(
				StringEnum([...WAIT_STATUSES], { description: "Status for action=wait. Default done." }),
			),
			timeoutMs: Type.Optional(
				Type.Number({ description: "Timeout in milliseconds for action=wait. Default 600000." }),
			),
		}),
		execute(_toolCallId, params: HerdrSubagentParams, signal, _onUpdate, ctx) {
			return nodeRuntime.runPromise(executeAction(params, ctx), { signal });
		},
	});
}
