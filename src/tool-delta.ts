/**
 * Tool delta (oh-my-omp paradigm rule, "启用工具集与缓存"): this plugin's tools that are in the
 * system lifecycle's baseline but unavailable now reach the model as a hidden message appended to the
 * conversation, never as a change of the active tool set, so the system/tools prefix and its prompt
 * cache stay intact. Same mechanics as omp-config `agent/extensions/_shared/context-delta.ts`.
 *
 * RENDERING. A delta is `<system-reminder source="<source>">`, a newline, the body, a newline and
 * `</system-reminder>`. A delta that replaces an earlier one of the same source opens its body with a
 * line saying it supersedes them; once every baseline tool is available again, a delta saying only
 * that the earlier ones no longer apply retracts them.
 *
 * DELIVERY. The `before_agent_start` result `message` (a hidden custom message whose `customType` is
 * the source, `attribution: "agent"`) and the `tool_result` `additionalContext` (the host's developer
 * message after the tool batch). Each reads the active leaf's context projection: the source's last
 * block there is the effective delta, and nothing is sent when the wanted delta equals it. The only
 * process state is what a tool batch of the current turn returned before the host persists the
 * batch's developer message; `turn_start` drops it.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";

/** What the model must know about this plugin's baseline tools now. */
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
	/** Call from the plugin's `turn_start` handler: a new turn persists the previous batch's message. */
	turnStarted(): void;
}

/** The source's latest delta in the context: none yet, a retraction, or a body. */
type Effective = { readonly kind: "absent" } | { readonly kind: "retracted" } | { readonly kind: "text"; readonly body: string };

const CLOSE = "\n</system-reminder>";

const openTag = (source: string): string => `<system-reminder source="${source}">\n`;
const supersedeLine = (source: string): string => `This reminder supersedes every earlier reminder from ${source}; only this one applies.`;
const retractionLine = (source: string): string => `The earlier reminders from ${source} no longer apply.`;
const render = (source: string, inner: string): string => `${openTag(source)}${inner}${CLOSE}`;

/** Text of a message `content`: the string itself, or its text blocks joined by newlines. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "text") continue;
		if ("text" in block && typeof block.text === "string") texts.push(block.text);
	}
	return texts.join("\n");
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

function inProjection(ctx: ExtensionContext, source: string): Effective {
	const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message === undefined || !("role" in message)) continue;
		const carrier =
			(message.role === "custom" && message.customType === source) || (message.role === "developer" && message.attribution === "agent");
		if (!carrier) continue;
		const block = lastBlock(source, textOf(message.content));
		if (block !== undefined) return block;
	}
	return { kind: "absent" };
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

/** The delta stream of `source`; one per plugin instance, created in its factory. */
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
