// `registerInternalScheme` stamps the brand on the passed handler object with
// `Object.defineProperty`, so the handler must be extensible (not frozen).
import type { InternalUrlRouter, ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";

const OWNER_BRAND = Symbol.for("omomp-shared/internal-url");
const TOOL_HUB_SYMBOL = Symbol.for("omomp-shared/tool-hub");

export type SchemeHolder = { readonly kind: "owner"; readonly id: string } | { readonly kind: "unbranded" };

export type RegisterSchemeResult =
	| { readonly kind: "registered" }
	| { readonly kind: "builtin"; readonly reason: string }
	| { readonly kind: "held"; readonly holder: SchemeHolder; readonly reason: string };

export function registerInternalScheme(router: InternalUrlRouter, owner: string, handler: ProtocolHandler): RegisterSchemeResult {
	const scheme = handler.scheme;
	if (router.isBuiltin(scheme)) return { kind: "builtin", reason: `omp owns ${scheme}://` };
	const existing = router.getHandler(scheme);
	if (existing !== undefined) {
		const holder: unknown = Reflect.get(existing, OWNER_BRAND);
		if (typeof holder !== "string") {
			return { kind: "held", holder: { kind: "unbranded" }, reason: `a handler with no owner already holds ${scheme}://` };
		}
		if (holder !== owner) {
			return { kind: "held", holder: { kind: "owner", id: holder }, reason: `${holder} already holds ${scheme}://` };
		}
	}
	Object.defineProperty(handler, OWNER_BRAND, { value: owner, enumerable: false, writable: false, configurable: false });
	router.register(handler);
	const ordered = [...router.specs().keys()].filter((registeredScheme) => !router.isBuiltin(registeredScheme)).sort();
	for (const registeredScheme of ordered) {
		const registeredHandler = router.getHandler(registeredScheme);
		if (!registeredHandler) continue;
		router.unregister(registeredScheme);
		router.register(registeredHandler);
	}
	return { kind: "registered" };
}

export interface ToolTopicInjectRule {
	param?: string;
	pattern?: string;
	onError?: boolean;
	resultPattern?: string;
}

export interface ToolTopicDoc {
	tool: string;
	topic: string;
	title: string;
	when: string;
	body: string | (() => string);
	hiddenFromIndex?: boolean;
	inject?: readonly ToolTopicInjectRule[];
}

interface ToolHubState {
	readonly byOwner: Map<string, readonly ToolTopicDoc[]>;
}

function getToolHub(): ToolHubState {
	const existing: unknown = Reflect.get(globalThis, TOOL_HUB_SYMBOL);
	if (typeof existing === "object" && existing !== null && Reflect.get(existing, "byOwner") instanceof Map) {
		return existing as ToolHubState;
	}
	const created: ToolHubState = { byOwner: new Map() };
	Reflect.set(globalThis, TOOL_HUB_SYMBOL, created);
	return created;
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareDocs(a: ToolTopicDoc, b: ToolTopicDoc): number {
	return compareStrings(a.tool, b.tool) || compareStrings(a.topic, b.topic);
}

function cloneDoc(doc: ToolTopicDoc): ToolTopicDoc {
	return {
		...doc,
		...(doc.inject ? { inject: doc.inject.map((rule) => ({ ...rule })) } : {}),
	};
}

function collectDocs(): ToolTopicDoc[] {
	const merged = new Map<string, ToolTopicDoc>();
	for (const docs of getToolHub().byOwner.values()) {
		for (const doc of docs) {
			merged.set(`${doc.tool}\0${doc.topic}`, cloneDoc(doc));
		}
	}
	return [...merged.values()].sort(compareDocs);
}

function renderDocBody(doc: ToolTopicDoc): string {
	return typeof doc.body === "function" ? doc.body() : doc.body;
}

export function registerToolTopics(owner: string, docs: readonly ToolTopicDoc[]): void {
	getToolHub().byOwner.set(owner, docs.map(cloneDoc));
}

export function clearToolTopics(owner?: string): void {
	const hub = getToolHub();
	if (owner === undefined) {
		hub.byOwner.clear();
		return;
	}
	hub.byOwner.delete(owner);
}

export function listToolTopics(tool?: string, options?: { includeHidden?: boolean }): ToolTopicDoc[] {
	const includeHidden = options?.includeHidden === true;
	return collectDocs().filter((doc) => {
		if (tool !== undefined && doc.tool !== tool) return false;
		if (!includeHidden && doc.hiddenFromIndex === true) return false;
		return true;
	});
}

export function resolveToolTopic(tool: string, topic: string): { doc: ToolTopicDoc; content: string } | undefined {
	const doc = collectDocs().find((entry) => entry.tool === tool && entry.topic === topic);
	if (!doc) return undefined;
	return { doc, content: renderDocBody(doc) };
}

export function getToolTopicInjections(): ToolTopicDoc[] {
	return collectDocs().filter((doc) => doc.inject !== undefined && doc.inject.length > 0);
}

export function toDocTopics(docs: readonly ToolTopicDoc[]): () => Record<string, string> {
	const snapshot = docs.map(cloneDoc);
	return () => {
		const record: Record<string, string> = {};
		for (const doc of snapshot) {
			record[doc.topic] = renderDocBody(doc);
		}
		return record;
	};
}
