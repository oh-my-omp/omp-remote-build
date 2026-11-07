import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { deriveIgnoreRules } from "./ignores.ts";
import type { RemoteBuildConfig } from "./types.js";

/** Repos created per test; removed once all tests finish. */
const scratchRepos: string[] = [];

afterAll(async () => {
	await Promise.all(scratchRepos.map(path => rm(path, { force: true, recursive: true })));
});

const ignoreOnlyConfig: RemoteBuildConfig = {
	imageSource: { kind: "dockerfile", dockerfile: "Dockerfile" },
	dockerfile: null,
	bootstrap: null,
	workdir: "/workspace",
	shell: "bash",
	ignore: [],
	include: [],
	containerFiles: {},
	volumes: [],
	env: {},
} as unknown as RemoteBuildConfig;

test("derivation negates exactly git's tracked-and-ignored set and nothing else", async () => {
	const root = await mkdtemp(join(tmpdir(), "rb-ignore-"));
	scratchRepos.push(root);
	await Bun.spawn(["git", "-C", root, "init", "-q"]).exited;
	await mkdir(join(root, "build"), { recursive: true });
	await mkdir(join(root, "vendored/lib"), { recursive: true });
	await mkdir(join(root, "src"), { recursive: true });
	for (const [name, text] of Object.entries({
		".gitignore": "build/\nvendored/\nspace*\n*.log\n!keep.log\n",
		"src/main.rs": "fn main() {}\n",
		"build/artifact.o": "",
		"vendored/lib/dep.rs": "",
		"space file.txt": "",
		"err.log": "",
		"keep.log": "",
	})) {
		await writeFile(join(root, name!), text);
	}
	await Bun.spawn(["git", "-C", root, "add", "-f", "-A"]).exited;
	await Bun.spawn(["git", "-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]).exited;

	const { patterns } = await deriveIgnoreRules(root, ignoreOnlyConfig);
	// One negation per ignored tracked path:
	expect(patterns.filter(pattern => pattern === "!/build/artifact.o").length).toBe(1);
	expect(patterns.filter(pattern => pattern === "!/vendored/lib/dep.rs").length).toBe(1);
	expect(patterns.filter(pattern => pattern === "!/space file.txt").length).toBe(1);
	expect(patterns.filter(pattern => pattern === "!/err.log").length).toBe(1);
	// !keep.log un-negates: no per-path negation for it.
	expect(patterns.filter(pattern => pattern === "!/keep.log").length).toBe(0);
	// Tracked non-ignored files translate nothing.
	expect(patterns.filter(pattern => pattern === "!/src/main.rs").length).toBe(0);
});
