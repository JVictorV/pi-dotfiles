const ACRONYMS = new Set(["gpt", "ai", "llm", "vl", "oss"]);

/** Pretty-print a model id, e.g. `claude-opus-4-8` becomes `Claude Opus 4.8`. */
export function prettyModelName(id: string): string {
	const out: string[] = [];
	let nums: string[] = [];
	const flushNums = () => {
		if (nums.length) {
			out.push(nums.join("."));
			nums = [];
		}
	};
	for (const part of id.split("-")) {
		if (/^\d+(\.\d+)*$/.test(part)) {
			nums.push(part);
		} else {
			flushNums();
			out.push(
				ACRONYMS.has(part.toLowerCase())
					? part.toUpperCase()
					: part.charAt(0).toUpperCase() + part.slice(1),
			);
		}
	}
	flushNums();
	return out.join(" ");
}
