import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { BeforeAgentStartEventResult, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";

export type Delta = { readonly kind: "none" } | { readonly kind: "text"; readonly body: string };

type HostMessage = Exclude<NonNullable<BeforeAgentStartEventResult["message"]>, string>;

type DeltaMessage = Required<Pick<HostMessage, "customType" | "display" | "attribution">> & {
	readonly content: Extract<HostMessage["content"], string>;
};

type CarrierContent = Extract<AgentMessage, { role: "custom" | "developer" }>["content"];

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

function lastBlockInContent(source: string, content: CarrierContent): Effective | undefined {
	if (typeof content === "string") return lastBlock(source, content);
	const open = openTag(source);
	const openSansNewline = open.slice(0, -1);
	const texts: string[] = [];
	for (const block of content) {
		if (block.type === "text") texts.push(block.text);
	}
	for (const [index, text] of texts.entries()) {
		if (text.includes(open) || (index < texts.length - 1 && text.endsWith(openSansNewline))) {
			return lastBlock(source, texts.join("\n"));
		}
	}
	return undefined;
}

function carrierBlock(message: AgentMessage, source: string): Effective | undefined {
	if (message.role === "custom") {
		return message.customType === source ? lastBlockInContent(source, message.content) : undefined;
	}
	if (message.role === "developer") {
		return message.attribution === "agent" ? lastBlockInContent(source, message.content) : undefined;
	}
	return undefined;
}

/** The source's last block among the messages omp builds for the session's current model. */
function inContext(ctx: ExtensionContext, source: string): Effective {
	const sessions = ctx.sessionManager;
	const { messages } = buildSessionContext(sessions.getEntries(), sessions.getLeafId(), undefined, { model: ctx.model });
	let effective: Effective = { kind: "absent" };
	for (const message of messages) effective = carrierBlock(message, source) ?? effective;
	return effective;
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
			const text = nextText(source, inContext(ctx, source), delta);
			if (text === undefined) return undefined;
			return { message: { customType: source, content: text, display: false, attribution: "agent" } };
		},
		afterTools(ctx, delta) {
			const text = nextText(source, batch ?? inContext(ctx, source), delta);
			if (text === undefined) return undefined;
			batch = delta.kind === "text" ? { kind: "text", body: delta.body } : { kind: "retracted" };
			return { additionalContext: text };
		},
		turnStarted() {
			batch = undefined;
		},
	};
}
