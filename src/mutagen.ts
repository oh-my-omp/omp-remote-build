import { RemoteBuildError } from "./diagnostics.ts";
import { run } from "./run.ts";
import type { EnvId, HostConfig, MutagenIgnoreRules } from "./types.ts";

const ENV_LABEL = "rb-env";

export async function findSession(host: HostConfig, id: EnvId): Promise<string | undefined> {
	const out = await run([
		host.bin.mutagen,
		"sync",
		"list",
		`--label-selector=${ENV_LABEL}=${id}`,
		"--template={{range .}}{{.Identifier}}\n{{end}}",
	]);
	const ids = out.split("\n").filter((line) => line.trim() !== "");
	if (ids.length > 1) throw new RemoteBuildError({ kind: "mutagen-duplicate", label: `${ENV_LABEL}=${id}`, ids });
	return ids[0];
}

export async function createSession(
	host: HostConfig,
	id: EnvId,
	root: string,
	remotePath: string,
	ignores: MutagenIgnoreRules,
): Promise<string> {
	await run(
		[
			host.bin.mutagen,
			"sync",
			"create",
			`--name=rb-${id}`,
			"--label=remote-build",
			`--label=${ENV_LABEL}=${id}`,
			"--mode=one-way-replica",
			"--ignore-vcs",
			...ignores.patterns.map((p) => `--ignore="${p.replaceAll('"', '""')}"`),
			root,
			`${host.ssh}:${remotePath}`,
		],
		{ stdout: "ignore" },
	);
	const session = await findSession(host, id);
	if (session === undefined) throw new RemoteBuildError({ kind: "mutagen-missing", id });
	return session;
}

export async function flush(host: HostConfig, session: string): Promise<void> {
	await run([host.bin.mutagen, "sync", "flush", session], { stdout: "ignore" });
}
