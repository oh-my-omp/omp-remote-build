import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { loadHost } from "./host.ts";
import { deriveIgnoreRules } from "./ignores.ts";
import { ensureContainer, komodoReachable } from "./komodo.ts";
import { createSession, findSession, flush } from "./mutagen.ts";
import { writeRemoteFile } from "./remote-files.ts";
import { run } from "./run.ts";
import type { ContainerSpec, EnvId, HostConfig, PreparedEnv, ProjectId, RemoteBuildConfig } from "./types.ts";

export async function worktreeRoot(cwd: string): Promise<string> {
	return realpathSync.native((await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim());
}

export async function mainCheckout(cwd: string): Promise<string> {
	const common = (await run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	return common.replace(/\/\.git$/, "");
}

export async function isMainCheckout(root: string): Promise<boolean> {
	return realpathSync.native(root) === realpathSync.native(await mainCheckout(root));
}

function idFor(path: string): string {
	const slug = basename(path)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const hash = createHash("sha256").update(path).digest("hex").slice(0, 10);
	return `${slug || "wt"}-${hash}`;
}

export function envIdFor(root: string): EnvId {
	return idFor(root) as EnvId;
}

export function projectIdFor(mainRoot: string): ProjectId {
	return idFor(mainRoot) as ProjectId;
}

export async function checkHost(): Promise<HostConfig> {
	const host = await loadHost();
	await run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.ssh, "true"], { stdout: "ignore" });
	await komodoReachable(host);
	return host;
}

export function envContainerSpec(env: PreparedEnv, image: string): ContainerSpec {
	return {
		name: env.container,
		image,
		workdir: env.config.workdir,
		mounts: [`${env.remotePath}:${env.config.workdir}`, ...env.config.volumes],
		env: env.config.env,
	};
}

export async function prepareEnv(root: string, config: RemoteBuildConfig): Promise<PreparedEnv> {
	const host = await checkHost();
	const id = envIdFor(root);
	const remotePath = `${host.remoteRoot}/${id}`;
	const session = (await findSession(host, id)) ?? (await createSession(host, id, root, remotePath, await deriveIgnoreRules(root, config)));
	await flush(host, session);
	for (const [target, source] of Object.entries(config.containerFiles)) {
		await writeRemoteFile(host, `${remotePath}/${target}`, { kind: "file", path: join(root, source) });
	}
	const env: PreparedEnv = { id, root, remotePath, mutagenSession: session, container: `rb-${id}`, config, host };
	if (config.imageSource.kind === "configured") {
		await ensureContainer(host, envContainerSpec(env, config.imageSource.image), "ensure");
	}
	return env;
}
