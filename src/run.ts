import { type FileHandle, open } from "node:fs/promises";
import { RemoteBuildError } from "./diagnostics.ts";

export type StdinSource =
	| { readonly kind: "bytes"; readonly bytes: Uint8Array }
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "pipe"; readonly stream: ReadableStream<Uint8Array> };

export type OutputSink = "capture" | "ignore" | { readonly kind: "file"; readonly path: string };

type Stdin = Uint8Array | number | ReadableStream<Uint8Array> | "ignore";
type Stdout = "pipe" | "ignore" | number;

function captured(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string | undefined> {
	return stream instanceof ReadableStream ? new Response(stream).text() : Promise.resolve(undefined);
}

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
					if ((await handle.stat()).isDirectory()) await handle.read(new Uint8Array(1), 0, 1, 0);
					input = handle.fd;
					break;
				}
			}
		}
		const proc = Bun.spawn([...argv], { stdin: input, stdout: await output(stdout), stderr: await output(stderr) });
		const [out, err, code] = await Promise.all([captured(proc.stdout), captured(proc.stderr), proc.exited]);
		return { code, stdout: out, stderr: err };
	} finally {
		await Promise.all(handles.map((handle) => handle.close()));
	}
}

export async function runResult(
	argv: readonly string[],
	options: { readonly stdin?: StdinSource } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const result = await spawn(argv, options.stdin, "capture", "capture");
	return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export type RunOptions = { readonly stdin?: StdinSource; readonly stderr?: OutputSink };

export function run(argv: readonly string[], options?: RunOptions & { readonly stdout?: "capture" }): Promise<string>;
export function run(argv: readonly string[], options: RunOptions & { readonly stdout: Exclude<OutputSink, "capture"> }): Promise<undefined>;
export async function run(
	argv: readonly string[],
	options: RunOptions & { readonly stdout?: OutputSink } = {},
): Promise<string | undefined> {
	const result = await spawn(argv, options.stdin, options.stdout ?? "capture", options.stderr ?? "capture");
	if (result.code !== 0) {
		const output = result.stderr?.trim() || result.stdout?.trim() || "";
		throw new RemoteBuildError({ kind: "command-exit", command: argv.slice(0, 3).join(" "), code: result.code, output });
	}
	return result.stdout;
}
