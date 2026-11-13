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

/** Git worktree root containing `cwd`, in canonical letter case (one identity per root on case-insensitive file systems). */
export async function worktreeRoot(cwd: string): Promise<string> {
	return realpathSync.native((await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim());
}

/** Main checkout of the repository containing `cwd` (parent of the common git dir). */
export async function mainCheckout(cwd: string): Promise<string> {
	const common = (await run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	return common.replace(/\/\.git$/, "");
}

/**
 * Whether worktree root `root` is its repository's main checkout. Git spells the common dir its own way
 * (`C:/…` on Windows) while worktree roots are `realpathSync.native` results (`C:\…`), so both sides go
 * through `realpathSync.native` before they are compared.
 */
export async function isMainCheckout(root: string): Promise<boolean> {
	return realpathSync.native(root) === realpathSync.native(await mainCheckout(root));
}

/** `<slug>-<hash>`: readable, unique per absolute path, valid as Mutagen label value and docker name. */
function idFor(path: string): string {
	const slug = basename(path)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const hash = createHash("sha256").update(path).digest("hex").slice(0, 10);
	return `${slug || "wt"}-${hash}`;
}

/** Environment identity of worktree `root`. */
export function envIdFor(root: string): EnvId {
	return idFor(root) as EnvId;
}

/** Project identity of the repository whose main checkout is `mainRoot`. */
export function projectIdFor(mainRoot: string): ProjectId {
	return idFor(mainRoot) as ProjectId;
}

/** Loads the host config; throws unless the build host answers SSH and its Komodo Core answers the API. */
export async function checkHost(): Promise<HostConfig> {
	const host = await loadHost();
	await run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.ssh, "true"], { stdout: "ignore" });
	await komodoReachable(host);
	return host;
}

/** The environment container: replica bind-mounted at the workdir, plus the configured volumes and env. */
export function envContainerSpec(env: PreparedEnv, image: string): ContainerSpec {
	return {
		name: env.container,
		image,
		workdir: env.config.workdir,
		mounts: [`${env.remotePath}:${env.config.workdir}`, ...env.config.volumes],
		env: env.config.env,
	};
}

/**
 * Brings up the environment for worktree `root`: Mutagen replica, container-only
 * files (each streamed from its local file to ssh stdin; a missing source fails
 * before its ssh starts), and, for a configured image, the Komodo container. Other
 * image sources leave the container to `remote_env_init`. Idempotent; an existing
 * session is reused.
 */
export async function prepareEnv(root: string, config: RemoteBuildConfig): Promise<PreparedEnv> {
	const host = await checkHost();
	const id = envIdFor(root);
	const remotePath = `${host.remoteRoot}/${id}`;
	const session =
		(await findSession(host, id)) ?? (await createSession(host, id, root, remotePath, await deriveIgnoreRules(root, config)));
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
