import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { omompTool } from "../omomp-shared/tool-entry.ts";
import { registerContainerTools } from "./container-tools.ts";
import { registerInitTools } from "./init.ts";
import { PREPARER_AGENT_NAME } from "./preparer.ts";
import type { PreparedEnv } from "./types.ts";

const ENSURE_ENV_SENTINEL = "ensureEnv-reached-sentinel";

function collectTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on() {},
	} as unknown as ExtensionAPI;
	const ensureEnv = async (_cwd: string): Promise<PreparedEnv> => {
		throw new Error(ENSURE_ENV_SENTINEL);
	};
	registerContainerTools(pi, ensureEnv);
	registerInitTools(pi, ensureEnv);
	return tools;
}

function fakeContext(agentName: string): ExtensionContext {
	return {
		cwd: "/tmp/worktree",
		agent: { name: agentName, id: "a1", kind: "main", depth: 0 },
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
}

async function callTool(tool: ToolDefinition, args: unknown, ctx: ExtensionContext): Promise<unknown> {
	return await tool.execute("tc-1", args as never, undefined, undefined, ctx);
}

beforeEach(() => {
	InternalUrlRouter.resetForTests();
});

afterEach(() => {
	InternalUrlRouter.resetForTests();
});

test("all four plugin tools register via omompTool with lenientArgValidation", () => {
	const tools = collectTools();
	expect([...tools.keys()].sort()).toEqual(["container_exec", "container_write_stdin", "remote_env_build_image", "remote_env_init"]);
	for (const tool of tools.values()) {
		expect(Reflect.get(tool, "lenientArgValidation")).toBe(true);
	}
});

test("container_write_stdin treats blank or null raw_base64 and special_key as omitted", async () => {
	const tools = collectTools();
	const writeTool = tools.get("container_write_stdin")!;
	const ctx = fakeContext("main");

	for (const args of [
		{ session_id: 1, text: "ls", enter: true, raw_base64: "" },
		{ session_id: 1, text: "ls", enter: true, raw_base64: "   " },
		{ session_id: 1, text: "ls", enter: true, raw_base64: null },
		{ session_id: 1, text: "ls", enter: true, special_key: "" },
		{ session_id: 1, text: "ls", enter: true, special_key: "   " },
		{ session_id: 1, text: "ls", enter: true, special_key: null },
		{ session_id: 1, raw_base64: "YQ==", text: "" },
		{ session_id: 1, raw_base64: "YQ==", text: null },
	]) {
		await expect(callTool(writeTool, args, ctx)).rejects.toThrow(ENSURE_ENV_SENTINEL);
	}

	await expect(callTool(writeTool, { session_id: 1, raw_base64: "YQ==", text: "ls" }, ctx)).rejects.toThrow(/cannot be combined/);
	await expect(callTool(writeTool, { session_id: 1, text: "ls", special_key: "not-a-key" }, ctx)).rejects.toThrow(
		/Validation failed for tool "container_write_stdin"/,
	);
});

test("container_write_stdin.text and container_exec.input preserve whitespace verbatim while dropping empty string", async () => {
	const tools = collectTools();
	const writeTool = tools.get("container_write_stdin")!;
	const execTool = tools.get("container_exec")!;
	const ctx = fakeContext("main");

	await expect(callTool(writeTool, { session_id: 1, raw_base64: "YQ==", text: " " }, ctx)).rejects.toThrow(/cannot be combined/);
	await expect(callTool(writeTool, { session_id: 1, raw_base64: "YQ==", text: "\n" }, ctx)).rejects.toThrow(/cannot be combined/);

	let seenExecArgs: unknown;
	const execProbe = omompTool({
		name: execTool.name,
		parameters: execTool.parameters,
		execute(_id: unknown, params: unknown) {
			seenExecArgs = params;
			return params;
		},
	});
	execProbe.execute("tc-1", { input: " " });
	expect(seenExecArgs).toEqual({ input: " " });
	execProbe.execute("tc-2", { input: "\n" });
	expect(seenExecArgs).toEqual({ input: "\n" });
	execProbe.execute("tc-3", { input: "" });
	expect(seenExecArgs).toEqual({});
	execProbe.execute("tc-4", { input: null, yield_time_ms: null });
	expect(seenExecArgs).toEqual({});

	for (const input of [" ", "\n", "", null]) {
		await expect(callTool(execTool, { input }, ctx)).rejects.toThrow(ENSURE_ENV_SENTINEL);
	}
	await expect(callTool(execTool, { input: " ", yield_time_ms: null }, ctx)).rejects.toThrow(ENSURE_ENV_SENTINEL);
	await expect(callTool(execTool, { yield_time_ms: 10 }, ctx)).rejects.toThrow(/Validation failed for tool "container_exec"/);
});

test("remote_env_build_image requires bootstrap or no_bootstrap: true and treats blank fields as omitted", async () => {
	const tools = collectTools();
	const buildTool = tools.get("remote_env_build_image")!;
	const ctx = fakeContext(PREPARER_AGENT_NAME);
	const validDockerfile = "FROM rb-base-archlinux:latest\n";

	for (const args of [
		{ dockerfile: validDockerfile, no_bootstrap: true },
		{ dockerfile: validDockerfile, bootstrap: "", no_bootstrap: true },
		{ dockerfile: validDockerfile, bootstrap: "   ", no_bootstrap: true },
		{ dockerfile: validDockerfile, bootstrap: null, no_bootstrap: true },
		{ dockerfile: validDockerfile, bootstrap: "npm ci" },
		{ dockerfile: validDockerfile, bootstrap: "npm ci", no_bootstrap: null },
	]) {
		await expect(callTool(buildTool, args, ctx)).rejects.toThrow(ENSURE_ENV_SENTINEL);
	}

	for (const args of [
		{ dockerfile: validDockerfile },
		{ dockerfile: validDockerfile, bootstrap: "" },
		{ dockerfile: validDockerfile, bootstrap: "   " },
		{ dockerfile: validDockerfile, bootstrap: null },
	]) {
		await expect(callTool(buildTool, args, ctx)).rejects.toThrow(/pass either `bootstrap` or `no_bootstrap: true`/);
	}

	await expect(callTool(buildTool, { dockerfile: validDockerfile, bootstrap: "npm ci", no_bootstrap: true }, ctx)).rejects.toThrow(
		/cannot be combined/,
	);

	await expect(callTool(buildTool, { dockerfile: validDockerfile, no_bootstrap: false }, ctx)).rejects.toThrow(
		/Validation failed for tool "remote_env_build_image"/,
	);

	for (const args of [
		{ no_bootstrap: true },
		{ dockerfile: "", no_bootstrap: true },
		{ dockerfile: "   ", no_bootstrap: true },
		{ dockerfile: null, no_bootstrap: true },
	]) {
		await expect(callTool(buildTool, args, ctx)).rejects.toThrow(/Validation failed for tool "remote_env_build_image"/);
	}

	await expect(callTool(buildTool, { dockerfile: validDockerfile, bootstrap: "echo a\necho b" }, ctx)).rejects.toThrow(
		/bootstrap must be a single line/,
	);
});

test("remote_env_init treats blank or null rebuild as omitted", async () => {
	const tools = collectTools();
	const initTool = tools.get("remote_env_init")!;
	const ctx = fakeContext("main");

	for (const args of [{}, { rebuild: "" }, { rebuild: "   " }, { rebuild: null }]) {
		await expect(callTool(initTool, args, ctx)).rejects.toThrow(ENSURE_ENV_SENTINEL);
	}

	await expect(callTool(initTool, { rebuild: "bogus" }, ctx)).rejects.toThrow(/Validation failed for tool "remote_env_init"/);
});
