import { afterEach, beforeEach, expect, test } from "bun:test";
import { InternalUrlRouter, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { registerContainerTools } from "./container-tools.ts";
import { type PluginToolName, TOOL_DESCRIPTIONS } from "./tool-docs.ts";
import type { PreparedEnv } from "./types.ts";

const EXPECTED_TOOLS: readonly PluginToolName[] = ["container_exec", "container_write_stdin", "remote_env_init", "remote_env_build_image"];

function schemesIn(text: string): string[] {
	return [...text.matchAll(/[a-z][a-z0-9+.-]*:\/\//gi)].map((match) => match[0].toLowerCase());
}

beforeEach(() => {
	InternalUrlRouter.resetForTests();
});

afterEach(() => {
	InternalUrlRouter.resetForTests();
});

test("retained plugin tools inline core guidance without help:// or xd:// topics", () => {
	const names = Object.keys(TOOL_DESCRIPTIONS) as PluginToolName[];
	expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());

	for (const name of EXPECTED_TOOLS) {
		const description = TOOL_DESCRIPTIONS[name];
		for (const scheme of schemesIn(description)) {
			expect(scheme).toBe("cterm://");
		}
		expect(description).not.toContain("help://");
		expect(description).not.toContain("xd://");
	}
	expect(TOOL_DESCRIPTIONS.container_exec).toContain("read cterm://");
	expect(TOOL_DESCRIPTIONS.container_exec).toContain("write cterm://<id>");
	expect(TOOL_DESCRIPTIONS.container_exec).toContain("write cterm://<id>/kill");
	expect(TOOL_DESCRIPTIONS.container_exec).toContain("km always exits 0");
	expect(TOOL_DESCRIPTIONS.container_write_stdin).toContain("km always exits 0");
});

test("cterm:// registers conditionally without promptDoc and lists empty sessions", async () => {
	const registered: Array<{ name: string; loadMode?: string; docTopics?: unknown }> = [];
	const pi = {
		registerTool: (tool: { name: string; loadMode?: string; docTopics?: unknown }) => registered.push(tool),
		on: () => {},
	} as unknown as Parameters<typeof registerContainerTools>[0];

	registerContainerTools(pi, async (cwd) => ({
		root: cwd,
		id: "test-env" as PreparedEnv["id"],
		container: "rb-test",
		remotePath: "/srv/remote-build/test",
		mutagenSession: "rb-test",
		host: {
			ssh: "stub-host",
			remoteRoot: "/srv/remote-build",
			komodo: { profile: "stub", server: "stub-server", cliConfig: "/tmp/komodo.toml" },
			bin: { km: "km", mutagen: "mutagen" },
		},
		config: {
			workdir: "/workspace",
			shell: "bash",
			ignore: [],
			include: [],
			env: {},
			volumes: [],
			imageSource: { kind: "configured", image: "img:test" },
			bootstrap: null,
			containerFiles: {},
		},
	}));

	expect(registered.map((tool) => tool.name).sort()).toEqual(["container_exec", "container_write_stdin"]);
	for (const tool of registered) {
		expect(tool.loadMode).toBe("essential");
		expect("docTopics" in tool).toBe(false);
	}

	const router = InternalUrlRouter.instance();
	const handler = router.getHandler("cterm");
	expect(handler).toBeDefined();
	expect(handler?.promptDoc).toBeUndefined();
	expect(handler?.spec.write?.via).toBe("handler");
	expect(handler?.spec.write?.cancels?.(parseInternalUrl("cterm://1/kill"))).toBe(true);
	expect(handler?.spec.write?.cancels?.(parseInternalUrl("cterm://1"))).toBe(false);

	const listing = await router.resolve("cterm://", { cwd: "/tmp/worktree" });
	expect(listing.content).toContain("[]");
	expect(listing.content).toContain("km always exits 0");
	await expect(router.resolve("cterm://1/kill", { cwd: "/tmp/worktree" })).rejects.toThrow(/write-only/);
	await expect(router.write("cterm://999", "echo hi", { cwd: "/tmp/worktree" })).rejects.toThrow(/Unknown container session 999/);
});
