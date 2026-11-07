import { open, type FileHandle } from "node:fs/promises";
import { RemoteBuildError } from "./diagnostics.ts";

/**
 * What a child process reads on stdin. A file is fed by descriptor and a pipe
 * (e.g. another child's `stdout` stream) is streamed: neither passes through the JS heap.
 */
export type StdinSource =
	| { readonly kind: "bytes"; readonly bytes: Uint8Array }
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "pipe"; readonly stream: ReadableStream<Uint8Array> };

/** Where a child's output stream goes: decoded into a JS string, discarded, or written (truncating) to a file without entering JS. */
export type OutputSink = "capture" | "ignore" | { readonly kind: "file"; readonly path: string };

type Stdin = Uint8Array | number | ReadableStream<Uint8Array> | "ignore";
type Stdout = "pipe" | "ignore" | number;

/** Text of a captured stream; `undefined` for any other sink, whose bytes never enter JS. */
function captured(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string | undefined> {
	return stream instanceof ReadableStream ? new Response(stream).text() : Promise.resolve(undefined);
}

/**
 * Spawns argv with the declared stdio. Files are opened here, before the process
 * starts, so a missing or unreadable stdin file fails without spawning (Bun.file
 * as stdin would create a missing file and feed it empty); descriptors are closed
 * once the process has exited.
 */
async function spawn(
	argv: readonly string[],
	stdin: StdinSource | undefined,
	stdout: OutputSink,
	stderr: OutputSink,
): Promise<{ code: number; stdout: string | undefined; stderr: string | undefined }> {
	const handles: FileHandle[] = [];
	const output = async (sink: OutputSink): Promise<Stdout> => {
		if (sink === "capture") return "pipe";
		if (sink === "ignore") return "ignore";
		const handle = await open(sink.path, "w");
		handles.push(handle);
		return handle.fd;
	};
	try {
		let input: Stdin = "ignore";
		if (stdin !== undefined) {
			switch (stdin.kind) {
				case "bytes":
					input = stdin.bytes;
					break;
				case "pipe":
					input = stdin.stream;
					break;
				case "file": {
					const handle = await open(stdin.path, "r");
					handles.push(handle);
					input = handle.fd;
					break;
				}
			}
		}
		const proc = Bun.spawn([...argv], { stdin: input, stdout: await output(stdout), stderr: await output(stderr) });
		const [out, err, code] = await Promise.all([captured(proc.stdout), captured(proc.stderr), proc.exited]);
		return { code, stdout: out, stderr: err };
	} finally {
		await Promise.all(handles.map(handle => handle.close()));
	}
}

/** Runs a binary with argv (no shell) and returns its exit code and both captured outputs. */
export async function runResult(
	argv: readonly string[],
	options: { readonly stdin?: StdinSource } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const result = await spawn(argv, options.stdin, "capture", "capture");
	return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Options of `run`; stderr defaults to captured, since a non-zero exit reports it. */
export type RunOptions = { readonly stdin?: StdinSource; readonly stderr?: OutputSink };

/**
 * Runs a binary with argv (no shell); throws `command-exit` with the captured
 * stderr (else captured stdout) on non-zero exit. Resolves to stdout when it is
 * captured (the default); a caller that declares stdout ignored or a file gets
 * nothing back and allocates no buffer for it.
 */
export function run(argv: readonly string[], options?: RunOptions & { readonly stdout?: "capture" }): Promise<string>;
export function run(argv: readonly string[], options: RunOptions & { readonly stdout: Exclude<OutputSink, "capture"> }): Promise<void>;
export async function run(argv: readonly string[], options: RunOptions & { readonly stdout?: OutputSink } = {}): Promise<string | void> {
	const result = await spawn(argv, options.stdin, options.stdout ?? "capture", options.stderr ?? "capture");
	if (result.code !== 0) {
		const output = result.stderr?.trim() || result.stdout?.trim() || "";
		throw new RemoteBuildError({ kind: "command-exit", command: argv.slice(0, 3).join(" "), code: result.code, output });
	}
	return result.stdout;
}
