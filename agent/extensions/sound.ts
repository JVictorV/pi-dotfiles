/**
 * Sound Notification Extension
 *
 * Plays a sound when the agent goes idle (finishes a turn and is waiting for
 * input). Ported from the opencode `notification` plugin, which played
 * `idle.ogg` on `session.idle` and `perm.oga` on permission prompts via
 * `afplay`.
 *
 * Notes vs. opencode:
 * - opencode's `session.idle` maps to pi's `agent_end` event.
 * - opencode also played `perm.oga` on `permission.ask` / question tool /
 *   external-directory prompts. pi has no generic "permission asked" event
 *   surfaced to extensions, so only the idle sound is wired up here. The
 *   `playSound` helper + `perm.oga` are kept so other extensions (or future
 *   hooks) can reuse them.
 *
 * Desktop notifications (text) are handled separately by notify.ts.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const soundFolder = join(homedir(), ".pi", "agent", "sounds");
const idleSound = join(soundFolder, "idle.ogg");

/**
 * Fire-and-forget sound playback via macOS `afplay`. Detached so it never
 * blocks the agent loop; errors are ignored (e.g. non-macOS, missing file).
 */
const playSound = (file: string): void => {
	try {
		const child = spawn("afplay", [file], {
			stdio: "ignore",
			detached: true,
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// ignore — best effort
	}
};

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		playSound(idleSound);
	});
}
