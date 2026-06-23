const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
	`${ESCAPE_CHAR}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${BELL_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\))`,
	"g",
);

/** Strip ANSI and OSC escape sequences from terminal text. */
export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}
