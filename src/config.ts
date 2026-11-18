import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RemoteBuildError } from "./diagnostics.ts";
import type { ImageSource, RemoteBuildConfig } from "./types.ts";

/** Path of the opt-in config, relative to a worktree root. */
export const CONFIG_PATH = ".omp/remote-build.json";

/** Where a prepared project image's Dockerfile is published, relative to a worktree root. */
export const GENERATED_DOCKERFILE = ".omp/remote-build.Dockerfile";

/** Where the preparer's final report is published, relative to a worktree root. */
export const PREPARER_REPORT = ".omp/remote-build.preparer.md";

/**
 * Reads `.omp/remote-build.json` at `root`.
 * Returns `undefined` when the file does not exist (project not opted in);
 * throws when it exists but is invalid.
 */
export async function loadConfig(root: string): Promise<RemoteBuildConfig | undefined> {
	let text: string;
	try {
		text = await readFile(join(root, CONFIG_PATH), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	return parseConfig(JSON.parse(text) as unknown);
}

/** A verified preparer result, as published into the worktree. */
export interface PreparedImageFiles {
	/** Published byte-for-byte: its sha256 keys the image tag already built from it. */
	readonly dockerfile: string;
	readonly bootstrap: string | null;
	readonly report: string;
	/** sha256 of `dockerfile`; recorded in the report so a later edit marks the report stale. */
	readonly sha256: string;
}

/**
 * Publishes a prepared image into worktree `root`: the Dockerfile, then the report, then the
 * config (`dockerfile` and `bootstrap` set, every other field kept), each by atomic rename.
 * The config is written last, so it never points at a missing Dockerfile.
 */
export async function publishPreparedImage(root: string, files: PreparedImageFiles): Promise<void> {
	const raw = record(JSON.parse(await readFile(join(root, CONFIG_PATH), "utf8")) as unknown, "config");
	if (raw.image !== undefined) throw new Error(`${CONFIG_PATH} names an image; a prepared image cannot be published`);
	const { bootstrap: _previous, ...rest } = raw;
	const config = { ...rest, dockerfile: GENERATED_DOCKERFILE, ...(files.bootstrap === null ? {} : { bootstrap: files.bootstrap }) };
	parseConfig(config);
	await replaceFile(root, GENERATED_DOCKERFILE, files.dockerfile);
	await replaceFile(root, PREPARER_REPORT, `<!-- dockerfile_sha256: ${files.sha256} -->\n${files.report.trimEnd()}\n`);
	await replaceFile(root, CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/** The published preparer report and the Dockerfile hash it was written for, if present. */
export async function readPreparerReport(root: string): Promise<{ readonly sha256: string; readonly text: string } | undefined> {
	let text: string;
	try {
		text = await readFile(join(root, PREPARER_REPORT), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	const match = /^<!-- dockerfile_sha256: ([0-9a-f]{64}) -->\n/.exec(text);
	if (match === null) throw new Error(`${PREPARER_REPORT}: first line must be <!-- dockerfile_sha256: <hex> -->`);
	return { sha256: match[1]!, text: text.slice(match[0].length).trimEnd() };
}

async function replaceFile(root: string, path: string, content: string): Promise<void> {
	const target = join(root, path);
	const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(temp, content);
		await rename(temp, target);
	} finally {
		await rm(temp, { force: true });
	}
}

type ConfigField = "image" | "dockerfile" | "workdir" | "shell" | "ignore" | "include" | "containerFiles" | "volumes" | "env" | "bootstrap";

const KNOWN_FIELDS: Record<ConfigField, true> = {
	image: true,
	dockerfile: true,
	workdir: true,
	shell: true,
	ignore: true,
	include: true,
	containerFiles: true,
	volumes: true,
	env: true,
	bootstrap: true,
};

function parseConfig(raw: unknown): RemoteBuildConfig {
	const obj = record(raw, "config");
	for (const key of Object.keys(obj)) {
		if (!(key in KNOWN_FIELDS)) throw new RemoteBuildError({ kind: "config-field", path: CONFIG_PATH, field: key, reason: "unknown" });
	}
	return {
		imageSource: imageSource(obj.image, obj.dockerfile),
		bootstrap: bootstrap(obj.bootstrap),
		workdir: absolutePath(obj.workdir ?? "/workspace", "workdir"),
		shell: nonEmptyString(obj.shell ?? "bash", "shell"),
		ignore: stringArray(obj.ignore ?? [], "ignore"),
		include: stringArray(obj.include ?? [], "include").map((p) => relativePath(p, "include")),
		containerFiles: containerFiles(obj.containerFiles ?? {}),
		volumes: stringArray(obj.volumes ?? [], "volumes"),
		env: stringRecord(obj.env ?? {}, "env"),
	};
}

function imageSource(image: unknown, dockerfile: unknown): ImageSource {
	if (image !== undefined && dockerfile !== undefined) {
		throw new RemoteBuildError({ kind: "config-image-source", path: CONFIG_PATH });
	}
	if (image !== undefined) return { kind: "configured", image: nonEmptyString(image, "image") };
	if (dockerfile !== undefined) return { kind: "dockerfile", path: relativePath(nonEmptyString(dockerfile, "dockerfile"), "dockerfile") };
	return { kind: "detect" };
}

function bootstrap(value: unknown): string | null {
	if (value === undefined) return null;
	const command = nonEmptyString(value, "bootstrap");
	if (/[\r\n\0]/.test(command))
		throw new RemoteBuildError({ kind: "config-field", path: CONFIG_PATH, field: "bootstrap", reason: "single-line" });
	return command;
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RemoteBuildError({ kind: "config-field", path: CONFIG_PATH, field, reason: "object" });
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new RemoteBuildError({ kind: "config-field", path: CONFIG_PATH, field, reason: "text" });
	}
	return value;
}

function absolutePath(value: unknown, field: string): string {
	const s = nonEmptyString(value, field);
	if (!s.startsWith("/")) throw new RemoteBuildError({ kind: "config-field", path: CONFIG_PATH, field, reason: "absolute" });
	return s;
}

function relativePath(value: string, field: string): string {
	if (value.startsWith("/") || value.split("/").includes("..")) {
		throw new RemoteBuildError({ kind: "config-relative", path: CONFIG_PATH, field, value });
	}
	return value.replace(/\/+$/, "");
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new RemoteBuildError({ kind: "config-field", path: CONFIG_PATH, field, reason: "strings" });
	return value.map((item, i) => nonEmptyString(item, `${field}[${i}]`));
}

function stringRecord(value: unknown, field: string): Record<string, string> {
	const obj = record(value, field);
	return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, nonEmptyString(v, `${field}.${k}`)]));
}

function containerFiles(value: unknown): Record<string, string> {
	const obj = stringRecord(value, "containerFiles");
	return Object.fromEntries(
		Object.entries(obj).map(([target, source]) => [
			relativePath(target, "containerFiles target"),
			relativePath(source, "containerFiles source"),
		]),
	);
}
