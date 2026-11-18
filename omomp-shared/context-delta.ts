/**
 * Delta messages: an extension's customization of OMP's base prompt reaches the model as a hidden
 * message appended to the conversation, never as an edit of the system prompt or tool definitions.
 *
 * RENDERING. A delta is `<system-reminder source="<source>">`, a newline, the body, a newline
 * and `</system-reminder>`, where `<source>` is the full string the caller gives
 * `createDeltaStream` (`<plugin>/<id>`). A delta that replaces an earlier one of the same source
 * opens its body with a line saying it supersedes them; a source whose customization stopped
 * applying sends a delta that says only that. The bytes depend only on the source, the body's text
 * and whether the context already holds a delta of that source.
 *
 * DELIVERY. Two points: the `before_agent_start` result `message` (a hidden custom message whose
 * `customType` is the source, `attribution: "agent"`) and the `tool_result` `additionalContext`
 * (OMP's developer message after the tool batch). Each asks for the source's last block in the
 * leaf's context projection — the messages `buildSessionContext` would emit — by walking the
 * parent chain back from the leaf with the projection's boundaries instead of materializing it.
 * Nothing is sent when the wanted body equals it, or when nothing applies and no body of the
 * source is effective. Delivered messages are never rewritten; once compaction drops one from the
 * projection, the next delivery point sends it again. The only process state is what a tool batch
 * of the current turn returned before OMP persists the batch's developer message; `turnStarted`,
 * called from the consumer's `turn_start` handler, drops it.
 */
import { getAnthropicCompactionPayload } from "@oh-my-pi/pi-agent-core";
import type { CompactionEntry, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { resolveSessionLeafId } from "@oh-my-pi/pi-coding-agent";
import { getOpenAiRemoteCompactionPayload } from "@oh-my-pi/pi-coding-agent/session/session-context";

/** What one extension adds to OMP's base prompt for the current session and inputs. */
export type Delta = { readonly kind: "none" } | { readonly kind: "text"; readonly body: string };

/** The `before_agent_start` result `message`; structurally a host `CustomMessagePayload`. */
interface DeltaMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: false;
	readonly attribution: "agent";
}

export interface DeltaStream {
	/** `before_agent_start` result carrying the delta, or undefined when the context already holds it. */
	atPrompt(ctx: ExtensionContext, delta: Delta): { message: DeltaMessage } | undefined;
	/** `tool_result` result carrying the delta, or undefined when the context or this batch already holds it. */
	afterTools(ctx: ExtensionContext, delta: Delta): { additionalContext: string } | undefined;
	/** Call from the consumer's `turn_start` handler: a new turn persists the previous batch's message. */
	turnStarted(): void;
}

/** The source's latest delta in the context: none yet, a retraction, or a body. */
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

/** Inverse of `render` for the source's last block in `text`, or undefined when `text` holds none. */
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

/**
 * `lastBlock` over a carrier's `content` without joining it: the joined `textOf` holds the open
 * tag only when one text block holds it or a block ends with the tag minus the separator newline
 * (the only position the "\n" separator can sit inside the tag), so the join — and its copy of the
 * whole carrier — runs only on a candidate.
 */
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

/**
 * `lastBlock` for the message `entry` emits in the model projection, or undefined when `entry`
 * emits no message or none carrying `source`. Mirrors `buildSessionContext`'s `appendMessage` for
 * the two carrier-capable entry types: a `message` entry emits its stored message; a
 * `custom_message` entry emits a `custom` role message with its `customType` only when its content
 * is a string or an array, since the host drops payloads it cannot persist.
 */
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

/** How the latest compaction bounds the kept segment below it in `buildSessionContext`. */
type KeptRegionBoundary = { readonly kind: "inclusive"; readonly id: string } | { readonly kind: "exclusive"; readonly id: string };
type KeptBoundary = { readonly kind: "none" } | KeptRegionBoundary;

/**
 * The kept segment of `compaction`, matching `buildSessionContext`'s retained tail. An OpenAI
 * remote compaction emits only entries after `providerReplayThroughEntryId`; an Anthropic native
 * payload with an empty `firstKeptEntryId` does the same; otherwise the segment starts at
 * `firstKeptEntryId` itself. A boundary id that is not on the path below the compaction means the
 * segment is empty — carriers below the compaction are outside the projection either way.
 */
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

/**
 * The source's effective delta in the leaf's model projection, walking the parentId chain with the
 * boundaries `buildSessionContext` applies: the first compaction met is the latest on the path and
 * sets the kept-segment boundary below it; a `reset_boundary` met first postdates every compaction
 * on the path and truncates the projection there. Steady state visits the leaf→carrier distance,
 * not the session's length.
 */
function inProjection(ctx: ExtensionContext, source: string): Effective {
	const sessions = ctx.sessionManager;
	const leafId = sessions.getLeafId();
	if (leafId === null) return { kind: "absent" };
	let entry = sessions.getEntry(leafId);
	if (entry === undefined) {
		// The manager's leaf is absent from its index: the host falls back to the leaf the entries
		// replay to.
		const replayedId = resolveSessionLeafId(sessions.getEntries());
		if (replayedId === null) return { kind: "absent" };
		entry = sessions.getEntry(replayedId);
	}
	if (entry === undefined) return { kind: "absent" };
	const seen = new Set<string>();
	let boundary: KeptRegionBoundary | undefined;
	let deferred: Effective | undefined;
	while (true) {
		// A parent cycle stops the walk at the first repeat, as `buildSessionContext` does.
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
			// Kept segment: carriers are provisional until the boundary entry confirms the segment
			// exists; the boundary id absent below the compaction means the segment is empty.
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

/** The text to send so that `wanted` becomes effective, or undefined when it already is. */
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

/**
 * The delta stream of `source` — the caller's full `<plugin>/<id>` string; one per plugin
 * instance, created in its factory. Call `turnStarted` from the consumer's `turn_start` handler.
 */
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
