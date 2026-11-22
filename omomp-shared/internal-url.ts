// `registerInternalScheme` stamps the brand on the passed handler object with
// `Object.defineProperty`, so the handler must be extensible (not frozen).
import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	type ProtocolHandler,
	type SchemeSpec,
	type UrlCompletion,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const OWNER_BRAND = Symbol.for("omomp-shared/internal-url");
const TOOL_HUB_SYMBOL = Symbol.for("omomp-shared/tool-hub");
const TOOL_HUB_OWNER = "omomp-shared/tool-hub";
const TOOL_PROMPT_DOC = "`tool://` / `tool://<tool>` / `tool://<tool>/<topic>` — On-demand tool topic docs and usage guides.";

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

let registeredToolHandler: ProtocolHandler | undefined;

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

function parseToolUrl(url: InternalUrl): { readonly tool: string; readonly topic: string | undefined } {
	const tool = url.rawHost || url.hostname;
	const segments = (url.rawPathname ?? url.pathname).split("/").filter((segment) => segment.length > 0);
	if (segments.length > 1 || (!tool && segments.length > 0) || url.search || url.hash) {
		throw new ToolError(`Invalid tool:// URL: ${url.href}. Use tool://, tool://<tool>, or tool://<tool>/<topic>.`);
	}
	return { tool, topic: segments[0] };
}

function markdownResource(url: string, content: string): InternalResource {
	return {
		url,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
	};
}

function groupByTool(docs: readonly ToolTopicDoc[]): Map<string, ToolTopicDoc[]> {
	const grouped = new Map<string, ToolTopicDoc[]>();
	for (const doc of docs) {
		const list = grouped.get(doc.tool);
		if (list) list.push(doc);
		else grouped.set(doc.tool, [doc]);
	}
	return grouped;
}

function formatTopicLine(doc: ToolTopicDoc, markHidden: boolean): string {
	const suffix = markHidden && doc.hiddenFromIndex ? " [hidden]" : "";
	return `- tool://${doc.tool}/${doc.topic} — ${doc.title} (when: ${doc.when})${suffix}`;
}

function resolveAllToolsListing(url: InternalUrl): InternalResource {
	const grouped = groupByTool(collectDocs());
	if (grouped.size === 0) {
		return markdownResource(url.href, "# tool://\n\nNo tool topics registered.\n");
	}
	const lines: string[] = ["# tool://", "", "Available tool topics (read `tool://<tool>` or `tool://<tool>/<topic>`):", ""];
	for (const [tool, docs] of grouped) {
		const visible = docs.filter((doc) => doc.hiddenFromIndex !== true);
		const listed = visible.length > 0 ? visible : docs;
		lines.push(`## ${tool}`);
		for (const doc of listed) {
			lines.push(formatTopicLine(doc, visible.length === 0));
		}
		if (visible.length > 0 && visible.length < docs.length) {
			const hiddenCount = docs.length - visible.length;
			lines.push(`- (${hiddenCount} hidden topic${hiddenCount === 1 ? "" : "s"}; read \`tool://${tool}\` to list all)`);
		}
		lines.push("");
	}
	return markdownResource(url.href, lines.join("\n"));
}

function requireToolDocs(tool: string): ToolTopicDoc[] {
	const allDocs = collectDocs();
	const forTool = allDocs.filter((doc) => doc.tool === tool);
	if (forTool.length === 0) {
		const availableTools = [...new Set(allDocs.map((doc) => doc.tool))];
		const available = availableTools.length > 0 ? availableTools.join(", ") : "none";
		throw new ToolError(`Tool '${tool}' has no tool:// topics. Tools with topics: ${available}.`);
	}
	return forTool;
}

function resolveToolListing(url: InternalUrl, tool: string): InternalResource {
	const docs = requireToolDocs(tool);
	const lines = [
		`# ${tool} topics`,
		"",
		`Read \`tool://${tool}/<topic>\` (line selectors apply).`,
		"",
		...docs.map((doc) => formatTopicLine(doc, true)),
		"",
	];
	return markdownResource(url.href, lines.join("\n"));
}

function resolveSingleTopic(url: InternalUrl, tool: string, topic: string): InternalResource {
	const docs = requireToolDocs(tool);
	const match = docs.find((doc) => doc.topic === topic);
	if (!match) {
		const available = docs.map((doc) => doc.topic).join(", ");
		throw new ToolError(`Unknown topic '${topic}' for ${tool}. Available: ${available}.`);
	}
	return markdownResource(url.href, renderDocBody(match));
}

function createToolProtocolHandler(): ProtocolHandler {
	const spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
		compactTranscript: true,
	};
	return {
		scheme: "tool",
		spec,
		promptDoc(): string {
			return TOOL_PROMPT_DOC;
		},
		async resolve(url: InternalUrl): Promise<InternalResource> {
			const { tool, topic } = parseToolUrl(url);
			if (!tool) return resolveAllToolsListing(url);
			if (topic === undefined) return resolveToolListing(url, tool);
			return resolveSingleTopic(url, tool, topic);
		},
		async enumerate(url: InternalUrl): Promise<Array<{ url: string; content: string }>> {
			const { tool, topic } = parseToolUrl(url);
			if (!tool) {
				return collectDocs().map((doc) => ({
					url: `tool://${doc.tool}/${doc.topic}`,
					content: renderDocBody(doc),
				}));
			}
			const docs = requireToolDocs(tool);
			if (topic === undefined) {
				return docs.map((doc) => ({
					url: `tool://${doc.tool}/${doc.topic}`,
					content: renderDocBody(doc),
				}));
			}
			const match = docs.find((doc) => doc.topic === topic);
			if (!match) {
				const available = docs.map((doc) => doc.topic).join(", ");
				throw new ToolError(`Unknown topic '${topic}' for ${tool}. Available: ${available}.`);
			}
			return [{ url: `tool://${match.tool}/${match.topic}`, content: renderDocBody(match) }];
		},
		async complete(prefix = ""): Promise<UrlCompletion[]> {
			const grouped = groupByTool(collectDocs());
			const completions: UrlCompletion[] = [];
			for (const [tool, docs] of grouped) {
				completions.push({ value: tool, description: `${docs.length} topic${docs.length === 1 ? "" : "s"}` });
				for (const doc of docs) {
					completions.push({
						value: `${tool}/${doc.topic}`,
						description: `${doc.title} — ${doc.when}`,
					});
				}
			}
			const normalized = prefix
				.trim()
				.replace(/^tool:\/\//i, "")
				.toLowerCase();
			if (!normalized) return completions;
			return completions.filter((candidate) => candidate.value.toLowerCase().startsWith(normalized));
		},
	};
}

function ensureToolSchemeRegistered(): void {
	const router = InternalUrlRouter.instance();
	if (registeredToolHandler !== undefined && router.getHandler("tool") === registeredToolHandler) {
		return;
	}
	const handler = createToolProtocolHandler();
	const result = registerInternalScheme(router, TOOL_HUB_OWNER, handler);
	if (result.kind === "registered") {
		registeredToolHandler = handler;
	}
}

export function registerToolTopics(owner: string, docs: readonly ToolTopicDoc[]): void {
	getToolHub().byOwner.set(owner, docs.map(cloneDoc));
	ensureToolSchemeRegistered();
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
