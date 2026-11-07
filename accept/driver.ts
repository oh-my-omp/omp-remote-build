/**
 * #19 acceptance driver: run deriveIgnoreRules on a load repo, capturing heap delta
 * and the byte totals of every git child process (stdin written via pipe writes or
 * direct stdin option, stdout captured).
 *
 * Usage: bun --expose-gc accept/driver.ts <repo-root> [--pattern-out <file>] [--label <s>]
 * The driver must run from the plugin worktree; loadConfig gate lives at <repoRoot>/.omp.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveIgnoreRules } from "../src/ignores.ts";
import { loadConfig } from "../src/config.ts";
import type { RemoteBuildConfig } from "../src/types.ts";

const args = process.argv.slice(2);
const repoRoot = args[0];
if (repoRoot === undefined) throw new Error("usage: driver.ts <repo-root> [--pattern-out <file>] [--label <s>]");
const patternOut = args.includes("--pattern-out") ? args[args.indexOf("--pattern-out") + 1] : undefined;
const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : "run";

interface ByteCounterChunk {
	length: number;
}

// --- instrumentation: watch the plugin's own Bun.spawn git calls at the boundary
// where ignores.ts sends bytes or BufferOptions stdin / reads stdout. ---
let spawnCount = 0;
let stdinOptionBytes = 0;
let stdinPipeBytes = 0;
let stdoutBytes = 0;

function countStdout(stdout: unknown): ReadableStream<Uint8Array> | undefined {
	// Wrap in a passthrough so the plugin's own `new Response(child.stdout).text()`
	// still sees all bytes; we count while relaying, never locking the original.
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
	// Bun.spawn(stdinOptions, options) | Bun.spawn(args, options): only the two-arg
	// call occurs in this plugin.
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

// --- build config gate if absent ---
const configDir = join(repoRoot, ".omp");
if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
const configPath = join(configDir, "remote-build.json");
if (!existsSync(configPath)) {
	writeFileSync(configPath, JSON.stringify({
		ignore: ["*.extra.log"],
		include: ["keep.normal"],
		containerFiles: {},
	}, null, 2));
}
const config: RemoteBuildConfig | undefined = await loadConfig(repoRoot);
if (config === undefined) throw new Error("loadConfig returned undefined for the load repo");

// --- measure ---
if (globalThis.gc === undefined) throw new Error("run with bun --expose-gc");
globalThis.gc();
const before = process.memoryUsage().heapUsed;
const result = await deriveIgnoreRules(repoRoot, config);
const after = process.memoryUsage().heapUsed;
globalThis.gc();
const settledAfter = process.memoryUsage().heapUsed;

console.log(JSON.stringify({
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
}, null, 2));

if (patternOut !== undefined) {
	writeFileSync(patternOut, result.patterns.join("\n\0") + "\n\0");
}
