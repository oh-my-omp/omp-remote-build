import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

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

export function applyActiveTools(pi: Pick<ExtensionAPI, "getAllTools" | "setActiveTools">, names: Iterable<string>): Promise<void> {
	return pi.setActiveTools(canonicalToolOrder(pi.getAllTools(), names));
}

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
