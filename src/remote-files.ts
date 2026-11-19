import { dirname } from "node:path";
import { run, runResult, type StdinSource } from "./run.ts";
import type { HostConfig } from "./types.ts";

export function shQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

export async function writeRemoteFile(host: HostConfig, path: string, content: string | StdinSource): Promise<void> {
	const stdin: StdinSource = typeof content === "string" ? { kind: "bytes", bytes: new TextEncoder().encode(content) } : content;
	await run(["ssh", host.ssh, `mkdir -p ${shQuote(dirname(path))} && cat > ${shQuote(path)}`], { stdin, stdout: "ignore" });
}

export async function readRemoteFile(host: HostConfig, path: string): Promise<string | undefined> {
	const q = shQuote(path);
	const result = await runResult(["ssh", host.ssh, `if [ -f ${q} ]; then cat ${q}; else exit 3; fi`]);
	if (result.code === 3) return undefined;
	if (result.code !== 0) throw new Error(`cannot read ${host.ssh}:${path}: ${result.stderr.trim()}`);
	return result.stdout;
}

export async function removeRemoteDir(host: HostConfig, path: string): Promise<void> {
	await run(["ssh", host.ssh, `rm -rf ${shQuote(path)}`], { stdout: "ignore" });
}
