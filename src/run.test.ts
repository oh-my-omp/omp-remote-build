import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBuildError } from "./diagnostics.ts";
import { run, runResult } from "./run.ts";

const node = (script: string) => [process.execPath, "-e", script];

test("stdout sinks: capture returns text, ignore returns nothing, file receives the bytes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rb-run-"));
	expect(await run(node('process.stdout.write("out")'))).toBe("out");
	expect(await run(node('process.stdout.write("out")'), { stdout: "ignore" })).toBeUndefined();
	const sink = join(dir, "sink");
	await writeFile(sink, "stale longer content");
	await run(node('process.stdout.write("out")'), { stdout: { kind: "file", path: sink } });
	expect(await readFile(sink, "utf8")).toBe("out");
});

test("stdin sources: bytes, file by descriptor, and another process's stdout", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rb-run-"));
	const source = join(dir, "source");
	await writeFile(source, "from file");
	expect(await run(["cat"], { stdin: { kind: "bytes", bytes: new TextEncoder().encode("from bytes") } })).toBe("from bytes");
	expect(await run(["cat"], { stdin: { kind: "file", path: source } })).toBe("from file");
	const upstream = Bun.spawn(node('process.stdout.write("from pipe")'), { stdout: "pipe" });
	expect(await run(["cat"], { stdin: { kind: "pipe", stream: upstream.stdout } })).toBe("from pipe");
});

test("a missing stdin file rejects before spawning and is not created", async () => {
	const missing = join(await mkdtemp(join(tmpdir(), "rb-run-")), "missing");
	const marker = join(tmpdir(), `rb-run-spawned-${process.pid}`);
	await expect(run(["touch", marker], { stdin: { kind: "file", path: missing }, stdout: "ignore" })).rejects.toMatchObject({ code: "ENOENT" });
	expect(existsSync(missing)).toBe(false);
	expect(existsSync(marker)).toBe(false);
});

test("non-zero exit reports stderr, else captured stdout; runResult returns both", async () => {
	const failing = node('process.stdout.write(" so "); process.stderr.write(" se "); process.exit(5)');
	await expect(run(failing)).rejects.toMatchObject({ diagnostic: { kind: "command-exit", code: 5, output: "se" } });
	await expect(run(failing, { stdout: "ignore" })).rejects.toBeInstanceOf(RemoteBuildError);
	await expect(run(node('process.stdout.write(" so "); process.exit(4)'))).rejects.toMatchObject({ diagnostic: { output: "so" } });
	expect(await runResult(failing)).toEqual({ code: 5, stdout: " so ", stderr: " se " });
});
