import { getAnthropicCompactionPayload } from "@oh-my-pi/pi-agent-core";
import type { CompactionEntry, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { resolveSessionLeafId } from "@oh-my-pi/pi-coding-agent";
import { getOpenAiRemoteCompactionPayload } from "@oh-my-pi/pi-coding-agent/session/session-context";

export type Delta = { readonly kind: "none" } | { readonly kind: "text"; readonly body: string };

interface DeltaMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: false;
	readonly attribution: "agent";
}

export interface DeltaStream {
	atPrompt(ctx: ExtensionContext, delta: Delta): { message: DeltaMessage } | undefined;
	afterTools(ctx: ExtensionContext, delta: Delta): { additionalContext: string } | undefined;
	turnStarted(): void;
}

type Effective = { readonly kind: "absent" } | { readonly kind: "retracted" } | { readonly kind: "text"; readonly body: string };

const CLOSE = "\n</system-reminder>";

function openTag(source: string): string {
	return `<system-reminder source="${source}">\n`;
}

function supersedeLine(source: string): string {
	return `This reminder supersedes every earlier reminder from ${source}; only this one applies.`;
}

function retractionLine(source: string): string {
	return `The earlier reminders from ${source} no longer apply.`;
}

function render(source: string, inner: string): string {
	return `${openTag(source)}${inner}${CLOSE}`;
}

function lastBlock(source: string, text: string): Effective | undefined {
	const open = openTag(source);
	const start = text.lastIndexOf(open);
	if (start < 0) return undefined;
	const end = text.indexOf(CLOSE, start + open.length);
	if (end < 0) return undefined;
	const inner = text.slice(start + open.length, end);
	if (inner === retractionLine(source)) return { kind: "retracted" };
	const supersede = `${supersedeLine(source)}\n\n`;
	return { kind: "text", body: inner.startsWith(supersede) ? inner.slice(supersede.length) : inner };
}

function lastBlockInContent(source: string, content: unknown): Effective | undefined {
	if (typeof content === "string") return lastBlock(source, content);
	if (!Array.isArray(content)) return undefined;
	const open = openTag(source);
	const openSansNewline = open.slice(0, -1);
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		texts.push(block.text);
	}
	for (const [index, text] of texts.entries()) {
		if (text.includes(open) || (index < texts.length - 1 && text.endsWith(openSansNewline))) {
			return lastBlock(source, texts.join("\n"));
		}
	}
	return undefined;
}

function carrierBlock(entry: SessionEntry, source: string): Effective | undefined {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "custom") {
			if (message.customType !== source) return undefined;
		} else if (message.role === "developer") {
			if (message.attribution !== "agent") return undefined;
		} else {
			return undefined;
		}
		return lastBlockInContent(source, message.content);
	}
	if (entry.type === "custom_message") {
		if (entry.customType !== source) return undefined;
		if (typeof entry.content !== "string" && !Array.isArray(entry.content)) return undefined;
		return lastBlockInContent(source, entry.content);
	}
	return undefined;
}

type KeptRegionBoundary = { readonly kind: "inclusive"; readonly id: string } | { readonly kind: "exclusive"; readonly id: string };
type KeptBoundary = { readonly kind: "none" } | KeptRegionBoundary;

function keptBoundary(compaction: CompactionEntry): KeptBoundary {
	const remote = getOpenAiRemoteCompactionPayload(compaction)?.items;
	if (remote) {
		return compaction.providerReplayThroughEntryId ? { kind: "exclusive", id: compaction.providerReplayThroughEntryId } : { kind: "none" };
	}
	if (compaction.firstKeptEntryId !== "") return { kind: "inclusive", id: compaction.firstKeptEntryId };
	if (getAnthropicCompactionPayload(compaction.preserveData) && compaction.providerReplayThroughEntryId) {
		return { kind: "exclusive", id: compaction.providerReplayThroughEntryId };
	}
	return { kind: "none" };
}

function inProjection(ctx: ExtensionContext, source: string): Effective {
	const sessions = ctx.sessionManager;
	const leafId = sessions.getLeafId();
	if (leafId === null) return { kind: "absent" };
	let entry = sessions.getEntry(leafId);
	if (entry === undefined) {
		const replayedId = resolveSessionLeafId(sessions.getEntries());
		if (replayedId === null) return { kind: "absent" };
		entry = sessions.getEntry(replayedId);
	}
	if (entry === undefined) return { kind: "absent" };
	const seen = new Set<string>();
	let boundary: KeptRegionBoundary | undefined;
	let deferred: Effective | undefined;
	while (true) {
		if (seen.has(entry.id)) return { kind: "absent" };
		seen.add(entry.id);
		if (boundary === undefined) {
			const block = carrierBlock(entry, source);
			if (block !== undefined) return block;
			if (entry.type === "compaction") {
				const region = keptBoundary(entry);
				if (region.kind === "none") return { kind: "absent" };
				boundary = region;
			} else if (entry.type === "reset_boundary") {
				return { kind: "absent" };
			}
		} else {
			if (entry.id === boundary.id) {
				if (boundary.kind === "exclusive") return deferred ?? { kind: "absent" };
				return deferred ?? carrierBlock(entry, source) ?? { kind: "absent" };
			}
			const block = carrierBlock(entry, source);
			if (deferred === undefined && block !== undefined) deferred = block;
		}
		if (!entry.parentId) return { kind: "absent" };
		const parent = sessions.getEntry(entry.parentId);
		if (parent === undefined) return { kind: "absent" };
		entry = parent;
	}
}

function nextText(source: string, effective: Effective, wanted: Delta): string | undefined {
	switch (wanted.kind) {
		case "none":
			return effective.kind === "text" ? render(source, retractionLine(source)) : undefined;
		case "text":
			switch (effective.kind) {
				case "absent":
					return render(source, wanted.body);
				case "retracted":
					return render(source, `${supersedeLine(source)}\n\n${wanted.body}`);
				case "text":
					return effective.body === wanted.body ? undefined : render(source, `${supersedeLine(source)}\n\n${wanted.body}`);
				default: {
					const unreachable: never = effective;
					return unreachable;
				}
			}
		default: {
			const unreachable: never = wanted;
			return unreachable;
		}
	}
}

export function createDeltaStream(source: string): DeltaStream {
	let batch: Effective | undefined;
	return {
		atPrompt(ctx, delta) {
			const text = nextText(source, inProjection(ctx, source), delta);
			if (text === undefined) return undefined;
			return { message: { customType: source, content: text, display: false, attribution: "agent" } };
		},
		afterTools(ctx, delta) {
			const text = nextText(source, batch ?? inProjection(ctx, source), delta);
			if (text === undefined) return undefined;
			batch = delta.kind === "text" ? { kind: "text", body: delta.body } : { kind: "retracted" };
			return { additionalContext: text };
		},
		turnStarted() {
			batch = undefined;
		},
	};
}
