import { expect, test } from "bun:test";
import { type PluginToolName, TOOL_DESCRIPTIONS, usageTopics } from "./tool-docs.ts";

const EXTERNAL_DESCRIPTION_CAP = 200;
const EXPECTED_TOOLS: readonly PluginToolName[] = [
	"container_exec",
	"container_write_stdin",
	"container_list_sessions",
	"container_kill_session",
	"remote_env_init",
	"remote_env_build_image",
];

function schemesIn(text: string): string[] {
	return [...text.matchAll(/[a-z][a-z0-9+.-]*:\/\//gi)].map((match) => match[0].toLowerCase());
}

test("all plugin tools fit the 200-byte external description cap and point to help:// topics", () => {
	const names = Object.keys(TOOL_DESCRIPTIONS) as PluginToolName[];
	expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());

	const topicsByTool = new Map<string, Readonly<Record<string, string>>>();
	for (const name of EXPECTED_TOOLS) {
		topicsByTool.set(name, usageTopics(name));
	}

	for (const name of EXPECTED_TOOLS) {
		const description = TOOL_DESCRIPTIONS[name];
		const pointer = `\`help://${name}/usage\``;
		const firstLine = description.split("\n").find((line) => line.trim().length > 0) ?? "";

		expect(schemesIn(description)).toEqual(["help://"]);
		expect(description).toContain(pointer);
		expect(description.length).toBeLessThanOrEqual(EXTERNAL_DESCRIPTION_CAP);
		expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(EXTERNAL_DESCRIPTION_CAP);
		expect(firstLine).toContain(pointer);
		expect(Buffer.byteLength(firstLine, "utf8")).toBeLessThanOrEqual(EXTERNAL_DESCRIPTION_CAP);

		const topics = topicsByTool.get(name);
		expect(topics?.usage?.trim().length).toBeGreaterThan(0);
		for (const body of Object.values(topics ?? {})) {
			for (const scheme of schemesIn(body)) expect(scheme).toBe("help://");
			for (const match of body.matchAll(/help:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
				const targetTopics = topicsByTool.get(match[1] ?? "");
				expect(targetTopics?.[match[2] ?? ""]).toBeDefined();
			}
		}
	}
});
