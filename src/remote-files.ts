import { dirname } from "node:path";
import { run, runResult, type StdinSource } from "./run.ts";
import type { HostConfig } from "./types.ts";

/** Single-quotes `s` for a POSIX shell. */
export function shQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Writes `content` to absolute `path` on the build host, creating parent directories.
 * A string is sent as UTF-8; a `file` or `pipe` source streams to ssh stdin without entering the JS heap.
 */
export async function writeRemoteFile(host: HostConfig, path: string, content: string | StdinSource): Promise<void> {
	const stdin: StdinSource = typeof content === "string" ? { kind: "bytes", bytes: new TextEncoder().encode(content) } : content;
	await run(["ssh", host.ssh, `mkdir -p ${shQuote(dirname(path))} && cat > ${shQuote(path)}`], { stdin, stdout: "ignore" });
}

/** Reads absolute `path` on the build host; `undefined` when it is not a regular file. */
export async function readRemoteFile(host: HostConfig, path: string): Promise<string | undefined> {
	const q = shQuote(path);
	const result = await runResult(["ssh", host.ssh, `if [ -f ${q} ]; then cat ${q}; else exit 3; fi`]);
	if (result.code === 3) return undefined;
	if (result.code !== 0) throw new Error(`cannot read ${host.ssh}:${path}: ${result.stderr.trim()}`);
	return result.stdout;
}

/** Removes absolute `path` on the build host recursively; only for directories the ssh user itself wrote. */
export async function removeRemoteDir(host: HostConfig, path: string): Promise<void> {
	await run(["ssh", host.ssh, `rm -rf ${shQuote(path)}`], { stdout: "ignore" });
}
