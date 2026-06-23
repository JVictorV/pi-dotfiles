import { homedir } from "node:os";

/** Replace a leading home directory with `~`. */
export function shortenHome(path: string): string {
	const home = homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Return the last path segment after trimming trailing slashes. */
export function lastPathSegment(path: string): string {
	const trimmed = path.replace(/\/+$/g, "");
	const index = trimmed.lastIndexOf("/");
	return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** Compact a path for narrow status-line layouts. */
export function compactPath(path: string): string {
	const shortened = shortenHome(path);
	if (shortened === "~") return shortened;

	const last = lastPathSegment(shortened);
	if (!last || shortened === last) return shortened;
	if (shortened.startsWith("~/")) return `~/${last}`;
	if (shortened.startsWith("/")) return `…/${last}`;
	return last;
}
