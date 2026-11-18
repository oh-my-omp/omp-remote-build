import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Canonical active-tool order shared by the omomp plugins. Each plugin writes
 * its active tool set at session start; the system/tools prefix a session
 * starts with — and the provider cache key derived from it — depends only on
 * the tool set when every writer uses this order, not on the order tools were
 * registered in or the order `names` lists them.
 */

/**
 * Returns `names` in canonical order: requested names whose registry entry has
 * `sourceInfo.source === "builtin"` first, in `registry` order; then every
 * other requested name — extension, SDK, MCP, or unknown to the registry —
 * sorted by Unicode code point and deduplicated. `registry` is the
 * `pi.getAllTools()` element shape. The result depends only on the requested
 * set: permutations and duplicates of the same names give the same output.
 */
export function canonicalToolOrder(
	registry: readonly { name: string; sourceInfo: { source: string } }[],
	names: Iterable<string>,
): string[] {
	const remaining = new Set(names);
	const builtins: string[] = [];
	for (const { name, sourceInfo } of registry) {
		if (sourceInfo.source === "builtin" && remaining.delete(name)) builtins.push(name);
	}
	return [...builtins, ...[...remaining].sort(compareByCodePoint)];
}

/**
 * Sets the session's active tools to `names` in {@link canonicalToolOrder}
 * order with exactly one `pi.setActiveTools` call.
 */
export function applyActiveTools(pi: Pick<ExtensionAPI, "getAllTools" | "setActiveTools">, names: Iterable<string>): Promise<void> {
	return pi.setActiveTools(canonicalToolOrder(pi.getAllTools(), names));
}

/**
 * Compares two strings code point by code point. `<` on strings compares
 * UTF-16 code units, which orders every astral character (lead surrogates
 * U+D800–U+DBFF) before the BMP range U+E000–U+FFFF.
 */
function compareByCodePoint(a: string, b: string): number {
	const aIterator = a[Symbol.iterator]();
	const bIterator = b[Symbol.iterator]();
	while (true) {
		const aNext = aIterator.next();
		const bNext = bIterator.next();
		if (aNext.done || bNext.done) {
			if (aNext.done && bNext.done) return 0;
			return aNext.done ? -1 : 1;
		}
		if (aNext.value !== bNext.value) {
			return (aNext.value.codePointAt(0) ?? 0) - (bNext.value.codePointAt(0) ?? 0);
		}
	}
}
