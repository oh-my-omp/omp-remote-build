import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { deriveIgnoreRules } from "../src/ignores.ts";
import type { RemoteBuildConfig } from "../src/types.ts";

const args = process.argv.slice(2);
const repoRoot = args[0];
if (repoRoot === undefined) throw new Error("usage: driver.ts <repo-root> [--pattern-out <file>] [--label <s>]");
const patternOut = args.includes("--pattern-out") ? args[args.indexOf("--pattern-out") + 1] : undefined;
const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : "run";

let spawnCount = 0;
let stdinOptionBytes = 0;
let stdinPipeBytes = 0;
let stdoutBytes = 0;

function countStdout(stdout: unknown): ReadableStream<Uint8Array> | undefined {
	const source = stdout as ReadableStream<Uint8Array> | undefined;
	if (source === undefined) return undefined;
	const passthrough = new TransformStream<Uint8Array, Uint8Array>();
	const writer = passthrough.writable.getWriter();
	void (async () => {
		const reader = source.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			stdoutBytes += value.byteLength;
			void writer.write(value);
		}
		writer.close();
	})();
	return passthrough.readable;
}

const realBunSpawn = Bun.spawn;
Bun.spawn = function bsWrapper(optionsOrArgs, options) {
	spawnCount++;
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	if (Array.isArray(optionsOrArgs)) {
		child = realBunSpawn(optionsOrArgs, options);
	} else {
		child = realBunSpawn(optionsOrArgs);
	}
	const spawnOptions: unknown = Array.isArray(optionsOrArgs) ? options : optionsOrArgs;
	const stdinOption = (spawnOptions as { stdin?: unknown } | undefined)?.stdin;
	if (stdinOption instanceof Uint8Array) {
		stdinOptionBytes += stdinOption.byteLength;
	}
	const wrappedStdout = countStdout(child.stdout);
	let view: Bun.Subprocess<"ignore", "pipe", "pipe"> = child;
	if (wrappedStdout !== undefined) {
		view = new Proxy(child, {
			get(target, prop) {
				if (prop === "stdout") return wrappedStdout;
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
	const stdinPipe = child.stdin;
	if (stdinPipe) {
		const origWrite = stdinPipe.write.bind(stdinPipe);
		stdinPipe.write = function wp(...wArgs: unknown[]) {
			const first = wArgs[0];
			if (typeof first === "string") {
				stdinPipeBytes += Buffer.byteLength(first);
			} else if (first instanceof Uint8Array) {
				stdinPipeBytes += first.byteLength;
			}
			type TypedWriteArgs = Parameters<typeof stdinPipe.write>;
			return origWrite(...(wArgs as TypedWriteArgs));
		};
	}
	return view;
};

const configDir = join(repoRoot, ".omp");
if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
const configPath = join(configDir, "remote-build.json");
if (!existsSync(configPath)) {
	writeFileSync(
		configPath,
		JSON.stringify(
			{
				ignore: ["*.extra.log"],
				include: ["keep.normal"],
				containerFiles: {},
			},
			null,
			2,
		),
	);
}
const config: RemoteBuildConfig | undefined = await loadConfig(repoRoot);
if (config === undefined) throw new Error("loadConfig returned undefined for the load repo");

if (globalThis.gc === undefined) throw new Error("run with bun --expose-gc");
globalThis.gc();
const before = process.memoryUsage().heapUsed;
const result = await deriveIgnoreRules(repoRoot, config);
const after = process.memoryUsage().heapUsed;
globalThis.gc();
const settledAfter = process.memoryUsage().heapUsed;

console.log(
	JSON.stringify(
		{
			label,
			patternCount: result.patterns.length,
			heapBefore: before,
			heapAfter: after,
			heapDelta: after - before,
			heapAfterSettled: settledAfter,
			settledDelta: settledAfter - before,
			spawnCount,
			stdinOptionBytes,
			stdinPipeBytes,
			stdoutBytes,
			perSpawnLayer: { stdinTotal: stdinOptionBytes + stdinPipeBytes },
		},
		null,
		2,
	),
);

if (patternOut !== undefined) {
	writeFileSync(patternOut, `${result.patterns.join("\n\0")}\n\0`);
}
