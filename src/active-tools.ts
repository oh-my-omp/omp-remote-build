import type { ExtensionAPI, ToolInfo } from "@oh-my-pi/pi-coding-agent";

/**
 * Canonical active-tool order (omp-config#158 §D4.1): requested builtins first, in `all` registry order;
 * every other requested name sorted by code point, deduplicated. Depends only on the tool set, not on
 * the registration order of extensions.
 */
export const canonicalToolOrder = (all: readonly ToolInfo[], names: Iterable<string>): string[] => {
	const requested = new Set(names);
	const builtins = [...new Set(all.filter(tool => tool.sourceInfo.source === "builtin" && requested.has(tool.name)).map(tool => tool.name))];
	const builtinSet = new Set(builtins);
	const others = [...requested].filter(name => !builtinSet.has(name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return [...builtins, ...others];
};

/** Activates exactly `names` in canonical order, with one `pi.setActiveTools` call. */
export const applyActiveTools = (pi: Pick<ExtensionAPI, "getAllTools" | "setActiveTools">, names: Iterable<string>): Promise<void> =>
	pi.setActiveTools(canonicalToolOrder(pi.getAllTools(), names));
