import type { EmbeddableSchema, IR } from "@oh-my-pi/omptype";
import { validateToolArguments } from "@oh-my-pi/pi-ai";

type ObjectIR = Extract<IR, { k: "object" }>;
type ArrayIR = Extract<IR, { k: "array" }>;

const verbatimKey: unique symbol = Symbol("omomp.verbatim");

function hasVerbatimMark(target: object): boolean {
	return Reflect.get(target, verbatimKey) === true;
}

function isEmbeddableSchema(value: unknown): value is EmbeddableSchema {
	if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
	const ir: unknown = Reflect.get(value, "ir");
	return typeof ir === "object" && ir !== null && typeof Reflect.get(ir, "k") === "string";
}

function markVerbatim(schema: unknown, visited: Set<unknown>): void {
	if (!isEmbeddableSchema(schema) || visited.has(schema)) return;
	visited.add(schema);
	if (!hasVerbatimMark(schema.ir)) {
		const marked = { ...schema.ir };
		Reflect.set(marked, verbatimKey, true);
		schema.ir = marked;
	}
	Object.defineProperty(schema, verbatimKey, { value: true, enumerable: false, configurable: true });
	for (const value of Object.values(schema)) {
		if (isEmbeddableSchema(value)) markVerbatim(value, visited);
	}
	for (const key of Object.getOwnPropertySymbols(schema)) {
		if (key === verbatimKey) continue;
		const value: unknown = Reflect.get(schema, key);
		if (isEmbeddableSchema(value)) markVerbatim(value, visited);
	}
}

export function verbatim<S>(schema: S): S {
	if (!isEmbeddableSchema(schema)) throw new Error("verbatim() requires a schema created by @oh-my-pi/omptype");
	markVerbatim(schema, new Set());
	return schema;
}

type FieldKind = "string" | "array" | "object" | "other";

interface FieldType {
	kind: FieldKind;
	verbatim: boolean;
}

function wrappedNode(node: IR): IR | undefined {
	switch (node.k) {
		case "morph":
			return node.input;
		case "refine":
			return node.base;
		case "sub":
			return node.schema.ir;
		case "unknown":
		case "null":
		case "undefined":
		case "boolean":
		case "bigint":
		case "symbol":
		case "never":
		case "anyobject":
		case "string":
		case "number":
		case "lit":
		case "union":
		case "intersection":
		case "array":
		case "tuple":
		case "object":
		case "instance":
		case "alias":
			return undefined;
		default:
			return assertNever(node);
	}
}

function assertNever(node: never): never {
	throw new Error(`unhandled omptype IR node ${JSON.stringify(node)}`);
}

function classifyField(node: IR, verbatim: boolean, depth: number): FieldType {
	const own = verbatim || hasVerbatimMark(node);
	if (depth > 12) return { kind: "other", verbatim: own };
	switch (node.k) {
		case "string":
			return { kind: "string", verbatim: own };
		case "lit":
			return typeof node.v === "string" ? { kind: "string", verbatim: own } : { kind: "other", verbatim: own };
		case "array":
			return { kind: "array", verbatim: own };
		case "object":
		case "anyobject":
			return { kind: "object", verbatim: own };
		case "union": {
			const members = node.members.filter((member) => member.k !== "undefined" && member.k !== "null");
			const [only] = members;
			if (only === undefined) return { kind: "other", verbatim: own };
			if (members.length === 1) return classifyField(only, own, depth + 1);
			if (members.every((member) => member.k === "string" || (member.k === "lit" && typeof member.v === "string"))) {
				return { kind: "string", verbatim: own };
			}
			return { kind: "other", verbatim: own };
		}
		case "sub":
			return classifyField(node.schema.ir, own || hasVerbatimMark(node.schema), depth + 1);
		case "morph":
		case "refine": {
			const inner = wrappedNode(node);
			return inner === undefined ? { kind: "other", verbatim: own } : classifyField(inner, own, depth + 1);
		}
		case "alias": {
			let resolved: IR;
			try {
				resolved = node.resolve();
			} catch {
				return { kind: "other", verbatim: own };
			}
			return classifyField(resolved, own, depth + 1);
		}
		case "unknown":
		case "null":
		case "undefined":
		case "boolean":
		case "bigint":
		case "symbol":
		case "never":
		case "number":
		case "intersection":
		case "tuple":
		case "instance":
			return { kind: "other", verbatim: own };
		default:
			return assertNever(node);
	}
}

function isEmptyValue(value: unknown, field: FieldType): boolean {
	if (value === null) return true;
	switch (field.kind) {
		case "string":
			if (typeof value !== "string") return false;
			return field.verbatim ? value.length === 0 : value.trim().length === 0;
		case "array":
			return Array.isArray(value) && value.length === 0;
		case "object":
			return typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0;
		case "other":
			return false;
	}
}

interface ElementRefusal {
	path: string;
	index: number;
}

function objectNodeOf(node: IR): ObjectIR | undefined {
	let current: IR | undefined = node;
	for (let depth = 0; current !== undefined && depth <= 12; depth++) {
		if (current.k === "object") return current;
		current = wrappedNode(current);
	}
	return undefined;
}

function arrayNodeOf(node: IR): ArrayIR | undefined {
	let current: IR | undefined = node;
	for (let depth = 0; current !== undefined && depth <= 12; depth++) {
		if (current.k === "array") return current;
		current = wrappedNode(current);
	}
	return undefined;
}

function peelOptional(node: IR): IR {
	if (node.k !== "union") return node;
	const members = node.members.filter((member) => member.k !== "undefined" && member.k !== "null");
	const [only] = members;
	return members.length === 1 && only !== undefined ? only : node;
}

function structuralObjectNode(node: IR): ObjectIR | undefined {
	return objectNodeOf(peelOptional(node));
}

function structuralArrayNode(node: IR): ArrayIR | undefined {
	return arrayNodeOf(peelOptional(node));
}

function pathJoin(base: string, key: string): string {
	return base === "" ? key : `${base}.${key}`;
}

type NormalizedField = { empty: true } | { empty: false; value: unknown; changed: boolean };

function normalizeField(node: IR, value: unknown, path: string, refusals: ElementRefusal[], depth: number): NormalizedField {
	if (depth > 12) return { empty: false, value, changed: false };
	const field = classifyField(node, false, 0);
	if (isEmptyValue(value, field)) return { empty: true };
	if (typeof value !== "object" || value === null) return { empty: false, value, changed: false };

	if (Array.isArray(value)) {
		const arrayNode = structuralArrayNode(node);
		if (arrayNode === undefined) return { empty: false, value, changed: false };
		let changed = false;
		const elements: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			const element = normalizeField(arrayNode.el, value[index], `${path}[${index}]`, refusals, depth + 1);
			if (element.empty) {
				refusals.push({ path, index });
				elements.push(value[index]);
				continue;
			}
			if (element.changed) changed = true;
			elements.push(element.changed ? element.value : value[index]);
		}
		return { empty: false, value: changed ? elements : value, changed };
	}

	const objectNode = structuralObjectNode(node);
	if (objectNode === undefined) return { empty: false, value, changed: false };
	const input = value as Record<string, unknown>;
	let changed = false;
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(input)) copy[key] = input[key];
	for (const prop of objectNode.props) {
		if (typeof prop.key !== "string" || !(prop.key in input)) continue;
		const propPath = pathJoin(path, prop.key);
		const normalized = normalizeField(prop.val, input[prop.key], propPath, refusals, depth + 1);
		if (normalized.empty) {
			delete copy[prop.key];
			changed = true;
		} else if (normalized.changed) {
			copy[prop.key] = normalized.value;
			changed = true;
		}
	}
	if (Object.keys(copy).length === 0) return { empty: true };
	return { empty: false, value: changed ? copy : value, changed };
}

interface NormalizeResult {
	args: unknown;
	changed: boolean;
	refusals: ElementRefusal[];
}

function normalizeArguments(rootNode: IR, args: unknown): NormalizeResult {
	const refusals: ElementRefusal[] = [];
	if (typeof args !== "object" || args === null || Array.isArray(args)) return { args, changed: false, refusals };
	const objectNode = structuralObjectNode(rootNode);
	if (objectNode === undefined) return { args, changed: false, refusals };
	let changed = false;
	const input = args as Record<string, unknown>;
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(input)) copy[key] = input[key];
	for (const prop of objectNode.props) {
		if (typeof prop.key !== "string" || !(prop.key in input)) continue;
		const propPath = pathJoin("", prop.key);
		const normalized = normalizeField(prop.val, input[prop.key], propPath, refusals, 0);
		if (normalized.empty) {
			delete copy[prop.key];
			changed = true;
		} else if (normalized.changed) {
			copy[prop.key] = normalized.value;
			changed = true;
		}
	}
	return { args: changed ? copy : args, changed, refusals };
}

function truncateForError(value: unknown): unknown {
	if (typeof value === "string") return value.length > 256 ? `${value.slice(0, 256)}…` : value;
	if (Array.isArray(value)) return value.map(truncateForError);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) out[key] = truncateForError((value as Record<string, unknown>)[key]);
		return out;
	}
	return value;
}

function refuseEmptyElements(name: string, refusals: ElementRefusal[], originalArgs: unknown): never {
	const lines = refusals.map((refusal) => `  - ${refusal.path}[${refusal.index}]: array element must not be empty`);
	throw new Error(
		`Validation failed for tool "${name}":\n${lines.join("\n")}\n\nReceived arguments:\n${JSON.stringify(truncateForError(originalArgs), null, 2)}`,
	);
}

function stripUndeclaredRootKeys(rootNode: IR, args: unknown): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const objectNode = structuralObjectNode(rootNode);
	if (objectNode === undefined) return args;
	if (objectNode.index !== undefined) return args;
	const declared = new Set<PropertyKey>();
	for (const prop of objectNode.props) declared.add(prop.key);
	const input = args as Record<string, unknown>;
	let stripped = false;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(input)) {
		if (declared.has(key)) {
			out[key] = input[key];
		} else {
			stripped = true;
		}
	}
	return stripped ? out : args;
}

function normalizeAndValidate(toolName: string, toolCallId: unknown, parameters: EmbeddableSchema, params: unknown): unknown {
	const originalArgs = params;
	const rootNode = parameters.ir;

	const initial = normalizeArguments(rootNode, params);
	if (initial.refusals.length > 0) refuseEmptyElements(toolName, initial.refusals, originalArgs);
	let current: unknown = initial.args;

	const id = typeof toolCallId === "string" ? toolCallId : "omomp";
	const seen = new Set<string>();
	for (;;) {
		const validated = validateToolArguments(
			{ name: toolName, description: "", parameters } as Parameters<typeof validateToolArguments>[0],
			{ type: "toolCall", id, name: toolName, arguments: current as Record<string, unknown> },
		);
		const renormalized = normalizeArguments(rootNode, validated);
		if (renormalized.refusals.length > 0) refuseEmptyElements(toolName, renormalized.refusals, originalArgs);
		if (!renormalized.changed) {
			return stripUndeclaredRootKeys(rootNode, validated);
		}
		const key = JSON.stringify(renormalized.args);
		if (seen.has(key)) {
			return stripUndeclaredRootKeys(rootNode, validated);
		}
		seen.add(key);
		current = renormalized.args;
	}
}

interface OmompToolDefinitionShape {
	name: string;
	parameters: unknown;
	execute: unknown;
}

function schemaOf(name: string, parameters: unknown): EmbeddableSchema {
	if (!isEmbeddableSchema(parameters)) {
		throw new Error(`omompTool(${name}): parameters must be a schema created by @oh-my-pi/omptype`);
	}
	return parameters;
}

export function omompTool<D extends OmompToolDefinitionShape>(definition: D): D {
	const descriptors = Object.getOwnPropertyDescriptors(definition);
	const declared = descriptors.parameters;
	if (declared !== undefined && "value" in declared) schemaOf(definition.name, declared.value);
	const originalExecute = definition.execute as (toolCallId: unknown, params: unknown, ...rest: unknown[]) => unknown;
	function execute(this: unknown, toolCallId: unknown, params: unknown, ...rest: unknown[]) {
		const normalized = normalizeAndValidate(definition.name, toolCallId, schemaOf(definition.name, definition.parameters), params);
		return originalExecute.call(this, toolCallId, normalized, ...rest);
	}
	return Object.create(Object.getPrototypeOf(definition), {
		...descriptors,
		lenientArgValidation: { value: true, enumerable: true, writable: true, configurable: true },
		execute: { value: execute, enumerable: true, writable: true, configurable: true },
	}) as D;
}
