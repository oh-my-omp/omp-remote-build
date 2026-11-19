import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { truncateTail } from "@oh-my-pi/pi-coding-agent";
import { CONFIG_PATH } from "./config.ts";
import { buildImage, imageExists } from "./komodo.ts";
import { writeRemoteFile } from "./remote-files.ts";
import type { DockerfileRef, EnvId, HostConfig, ImageSource, OnceResult, ProjectId } from "./types.ts";

/** Plugin-provided base of every prepared project image: Arch Linux with base-devel, git, sudo and paru. */
export const BASE_IMAGE = "rb-base-archlinux:latest";

/** Worktree Dockerfiles probed when the config names neither `image` nor `dockerfile`, in order. */
export const DOCKERFILE_CANDIDATES = [".devcontainer/Dockerfile", "Dockerfile"] as const;

/** Upper bound of one image build. */
export const BUILD_TIMEOUT_MS = 60 * 60_000;

/**
 * Tag of the project image built from a Dockerfile with content hash `sha256`. Keying the tag by
 * content makes an existing tag proof that it matches the Dockerfile, and lets worktrees with
 * different Dockerfiles keep separate images. The build host prunes unused tags.
 */
export function projectImage(id: ProjectId, sha256: string): string {
	return `rb-project-${id}:${sha256.slice(0, 16)}`;
}

/**
 * Build-host scratch directory of one preparer run in environment `id`: the candidate Dockerfile
 * (empty build context) and bootstrap command. It exists only while `remote_env_init` prepares.
 * Env ids end in `-<hash>`, so `prepare` cannot collide with a replica.
 */
export function prepareDir(host: HostConfig, id: EnvId): string {
	return `${host.remoteRoot}/prepare/${id}`;
}

/** Helper container that runs every image build of environment `id`. */
export function buildContainerName(id: EnvId): string {
	return `rb-build-${id}`;
}

/** Hex sha256 of `content`. */
export function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Last output lines of a build or command, for reports. */
export function outputTail(text: string): string {
	return truncateTail(text, { maxLines: 80, maxBytes: 8192 }).content;
}

/** The worktree Dockerfile the image source points at; `undefined` when there is none. */
export async function resolveDockerfile(root: string, source: ImageSource): Promise<DockerfileRef | undefined> {
	const read = async (path: string): Promise<DockerfileRef> => {
		const text = await Bun.file(join(root, path)).text();
		return { path, sha256: sha256(text), text };
	};
	switch (source.kind) {
		case "configured":
			return undefined;
		case "dockerfile":
			if (!(await isFile(join(root, source.path)))) throw new Error(`${CONFIG_PATH}: dockerfile ${source.path} not found in ${root}`);
			return read(source.path);
		case "detect":
			for (const candidate of DOCKERFILE_CANDIDATES) {
				if (await isFile(join(root, candidate))) return read(candidate);
			}
			return undefined;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/** Literal base image of every build stage of `dockerfile`, in order. `ARG`-expanded bases are left to Docker. */
export function stageBases(dockerfile: string): string[] {
	return Array.from(dockerfile.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim), (match) => match[1]!);
}

/** Outcome of a project image build. */
export interface ProjectBuild {
	/** `unused`: no stage builds on `BASE_IMAGE`. */
	readonly base: "unused" | "present" | "built";
	readonly result: OnceResult;
}

/**
 * Builds `image` from `dockerfile` in build-host directory `contextPath`. The build host prunes
 * unused images, so `BASE_IMAGE` is built first whenever a stage needs it and it is missing.
 */
export async function buildProjectImage(
	host: HostConfig,
	env: EnvId,
	image: string,
	build: { readonly contextPath: string; readonly dockerfile: string; readonly text: string },
	signal: AbortSignal | undefined,
): Promise<ProjectBuild> {
	const base = stageBases(build.text).includes(BASE_IMAGE) ? await ensureBaseImage(host, env, signal) : "unused";
	const result = await buildImage(
		host,
		{ name: buildContainerName(env), image, contextPath: build.contextPath, dockerfile: build.dockerfile },
		{ timeoutMs: BUILD_TIMEOUT_MS, signal },
	);
	return { base, result };
}

/** Builds `BASE_IMAGE` on the build host unless it exists. */
export async function ensureBaseImage(host: HostConfig, env: EnvId, signal: AbortSignal | undefined): Promise<"present" | "built"> {
	if (await imageExists(host, BASE_IMAGE)) return "present";
	const contextPath = `${host.remoteRoot}/base/archlinux`;
	const dockerfile = await Bun.file(new URL("../images/archlinux.Dockerfile", import.meta.url)).text();
	await writeRemoteFile(host, `${contextPath}/Dockerfile`, dockerfile);
	const result = await buildImage(
		host,
		{ name: buildContainerName(env), image: BASE_IMAGE, contextPath, dockerfile: "Dockerfile" },
		{ timeoutMs: BUILD_TIMEOUT_MS, signal },
	);
	if (result.exitCode !== 0) throw new Error(`base image build failed (exit ${result.exitCode})\n${outputTail(result.output)}`);
	return "built";
}
