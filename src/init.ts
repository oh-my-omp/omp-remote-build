import { readFileSync } from "node:fs";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { CONFIG_PATH, GENERATED_DOCKERFILE, PREPARER_REPORT, loadConfig, publishPreparedImage, readPreparerReport } from "./config.ts";
import { envContainerSpec, mainCheckout, projectIdFor } from "./environment.ts";
import { ensureContainer, imageExists, runOnce } from "./komodo.ts";
import { flush } from "./mutagen.ts";
import { PREPARER_AGENT_NAME, renderPreparerReport, runPreparer } from "./preparer.ts";
import {
	BASE_IMAGE,
	buildProjectImage,
	ensureBaseImage,
	outputTail,
	prepareDir,
	projectImage,
	resolveDockerfile,
	sha256,
	stageBases,
} from "./project.ts";
import { readRemoteFile, removeRemoteDir, writeRemoteFile } from "./remote-files.ts";
import type { DockerfileRef, ImageSource, OnceResult, PreparedEnv, RemoteBuildConfig } from "./types.ts";
import { tr } from "./i18n.ts";

const BOOTSTRAP_TIMEOUT_MS = 30 * 60_000;

const initSchema = z.object({
	rebuild: z
		.enum(["image", "prepare"])
		.optional()
		.describe(
			`"image": rebuild the project image from the worktree Dockerfile even if it is cached. "prepare": run the preparer subagent again and publish a new ${GENERATED_DOCKERFILE} (only without a hand-written Dockerfile). Omit to reuse.`,
		),
});

const buildSchema = z.object({
	dockerfile: z.string().describe(`Complete Dockerfile text; final stage FROM ${BASE_IMAGE}; empty build context, so no COPY or ADD.`),
	bootstrap: z
		.string()
		.describe("One-line idempotent shell command run in the working directory after each container deployment; empty string for none."),
});

/** What the caller asked for. */
type InitMode = "reuse" | "rebuild-image" | "reprepare";

/** Where the image definition comes from in this call. */
type ImagePlan =
	| { readonly kind: "configured"; readonly image: string }
	| { readonly kind: "dockerfile"; readonly dockerfile: DockerfileRef }
	| { readonly kind: "prepare" };

function planImage(source: ImageSource, mode: InitMode, dockerfile: DockerfileRef | undefined): ImagePlan {
	if (source.kind === "configured") {
		if (mode === "reprepare") throw new Error(`${CONFIG_PATH} names an image; there is nothing to prepare`);
		return { kind: "configured", image: source.image };
	}
	if (mode === "reprepare") {
		if (dockerfile !== undefined && dockerfile.path !== GENERATED_DOCKERFILE) {
			throw new Error(`${dockerfile.path} is a hand-written Dockerfile; edit it and call remote_env_init with rebuild "image"`);
		}
		return { kind: "prepare" };
	}
	return dockerfile === undefined ? { kind: "prepare" } : { kind: "dockerfile", dockerfile };
}

function assertNever(value: never): never {
	throw new Error(`unhandled variant ${JSON.stringify(value)}`);
}

/** Report fields in output order. */
const REPORT_KEYS = [
	"worktree",
	"project",
	"container",
	"image",
	"image_source",
	"persisted",
	"base_image",
	"note",
	"build_output_tail",
	"bootstrap",
	"bootstrap_exit_code",
	"bootstrap_output_tail",
	"preparer_report",
	"usage",
] as const;

type ReportField =
	| { readonly kind: "line"; readonly value: string }
	| { readonly kind: "tail"; readonly text: string }
	| { readonly kind: "verbatim"; readonly text: string };

type Report = Partial<Record<(typeof REPORT_KEYS)[number], ReportField>>;

/** `key:` followed by the output tail in a fence longer than any backtick run inside it. */
function tailBlock(key: string, text: string): string {
	const tail = outputTail(text);
	const longest = Math.max(0, ...Array.from(tail.matchAll(/`+/g), match => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${key}:\n${fence}\n${tail}\n${fence}`;
}

function renderReport(status: "ready" | "failed", report: Report, error?: string): string {
	const lines = [`status: ${status}`];
	for (const key of REPORT_KEYS) {
		const field = report[key];
		if (field === undefined) continue;
		switch (field.kind) {
			case "line":
				lines.push(`${key}: ${field.value}`);
				break;
			case "tail":
				lines.push(tailBlock(key, field.text));
				break;
			case "verbatim":
				lines.push(`${key}:\n${field.text}`);
				break;
			default:
				assertNever(field);
		}
	}
	if (error !== undefined) lines.push(`error: ${error}`);
	return lines.join("\n");
}

/** Recreates the worktree container from `image`, then runs `bootstrap` once in a fresh container with the same mounts. */
async function deployAndBootstrap(
	env: PreparedEnv,
	image: string,
	bootstrap: string | null,
	signal: AbortSignal | undefined,
): Promise<OnceResult | null> {
	const spec = envContainerSpec(env, image);
	await ensureContainer(env.host, spec, "redeploy");
	if (bootstrap === null) return null;
	return runOnce(
		env.host,
		{ ...spec, name: `rb-boot-${env.id}` },
		{ entrypoint: null, argv: [env.config.shell, "-c", bootstrap] },
		{ timeoutMs: BOOTSTRAP_TIMEOUT_MS, signal },
	);
}

/**
 * The config fields `remote_env_init` publishes and applies in the running session, read from
 * disk. Every other field keeps the value the environment was prepared with.
 */
async function liveEnv(env: PreparedEnv): Promise<PreparedEnv> {
	const config: RemoteBuildConfig | undefined = await loadConfig(env.root);
	if (config === undefined) throw new Error(`${CONFIG_PATH} disappeared from ${env.root}`);
	return { ...env, config: { ...env.config, imageSource: config.imageSource, bootstrap: config.bootstrap } };
}

/**
 * Runs the preparer from an empty scratch directory, and once its report has `result: success`,
 * publishes its last successful candidate into the worktree. Returns the published Dockerfile.
 */
async function prepare(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	env: PreparedEnv,
	report: Report,
	signal: AbortSignal | undefined,
): Promise<DockerfileRef> {
	const dir = prepareDir(env.host, env.id);
	await removeRemoteDir(env.host, dir);
	const base = await ensureBaseImage(env.host, env.id, signal);
	report.base_image = { kind: "line", value: `${BASE_IMAGE} (${base === "present" ? "present" : "built now"})` };
	await ensureContainer(env.host, envContainerSpec(env, BASE_IMAGE), "redeploy");
	const run = await runPreparer(pi, ctx, env, signal);
	const answer = renderPreparerReport(run);
	report.preparer_report = { kind: "verbatim", text: answer };
	if (run.result !== "success") {
		throw new Error(`the preparer reported result: ${run.result}; nothing was published`);
	}
	const [dockerfile, bootstrap] = await Promise.all([readRemoteFile(env.host, `${dir}/Dockerfile`), readRemoteFile(env.host, `${dir}/bootstrap`)]);
	if (dockerfile === undefined || bootstrap === undefined) {
		throw new Error("the preparer reported success without a successful remote_env_build_image; nothing was published");
	}
	const hash = sha256(dockerfile);
	await publishPreparedImage(env.root, { dockerfile, bootstrap: bootstrap.trim() || null, report: answer, sha256: hash });
	await removeRemoteDir(env.host, dir);
	report.persisted = {
		kind: "line",
		value: `${GENERATED_DOCKERFILE}, ${PREPARER_REPORT}, and dockerfile/bootstrap in ${CONFIG_PATH}; commit them so other worktrees and build hosts reuse this definition instead of preparing again`,
	};
	return { path: GENERATED_DOCKERFILE, sha256: hash, text: dockerfile };
}

/** Resolves the project image, recreates the worktree container from it and runs bootstrap; returns the report, or throws it on failure. */
async function initEnvironment(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prepared: PreparedEnv,
	mode: InitMode,
	signal: AbortSignal | undefined,
): Promise<string> {
	const { host } = prepared;
	const report: Report = { worktree: { kind: "line", value: prepared.root } };
	const phase = (name: string, nameZh: string) => ctx.ui.setStatus("remote-build", tr(`remote-build: init ${name}`, `remote-build：初始化${nameZh}`));
	try {
		phase("sync", "同步");
		await flush(host, prepared.mutagenSession);
		const mainRoot = await mainCheckout(prepared.root);
		const pid = projectIdFor(mainRoot);
		report.project = { kind: "line", value: `${pid} (main checkout ${mainRoot})` };
		report.container = {
			kind: "line",
			value: `${prepared.container} on server ${host.komodo.server}; workdir ${prepared.config.workdir}; shell ${prepared.config.shell}`,
		};

		let env = await liveEnv(prepared);
		const plan = planImage(env.config.imageSource, mode, await resolveDockerfile(env.root, env.config.imageSource));
		let image: string;
		switch (plan.kind) {
			case "configured":
				image = plan.image;
				report.image = { kind: "line", value: image };
				report.image_source = { kind: "line", value: "configured image" };
				break;
			case "prepare":
			case "dockerfile": {
				let dockerfile: DockerfileRef;
				if (plan.kind === "prepare") {
					phase("preparer", "准备器");
					report.image_source = { kind: "line", value: "prepared by subagent" };
					dockerfile = await prepare(pi, ctx, env, report, signal);
					env = await liveEnv(prepared);
					await flush(host, env.mutagenSession);
				} else {
					dockerfile = plan.dockerfile;
				}
				image = projectImage(pid, dockerfile.sha256);
				report.image = { kind: "line", value: image };
				if (mode !== "rebuild-image" && (await imageExists(host, image))) {
					report.image_source ??= { kind: "line", value: `reused (cached build of ${dockerfile.path})` };
				} else {
					report.image_source ??= { kind: "line", value: `built from worktree Dockerfile ${dockerfile.path}` };
					phase("build", "构建");
					const build = await buildProjectImage(
						host,
						env.id,
						image,
						{ contextPath: env.remotePath, dockerfile: dockerfile.path, text: dockerfile.text },
						signal,
					);
					if (build.base !== "unused") report.base_image = { kind: "line", value: `${BASE_IMAGE} (${build.base === "present" ? "present" : "built now"})` };
					report.build_output_tail = { kind: "tail", text: build.result.output };
					if (build.result.exitCode !== 0) throw new Error(`image build failed (exit ${build.result.exitCode})`);
				}
				const preparerReport = await readPreparerReport(env.root);
				if (preparerReport !== undefined && report.preparer_report === undefined) {
					report.preparer_report = { kind: "verbatim", text: preparerReport.text };
					if (preparerReport.sha256 !== dockerfile.sha256) {
						report.note = {
							kind: "line",
							value: `${PREPARER_REPORT} was written for an earlier version of ${dockerfile.path}; its claims may be stale`,
						};
					}
				}
				break;
			}
			default:
				assertNever(plan);
		}

		const bootstrap = env.config.bootstrap;
		report.bootstrap = { kind: "line", value: bootstrap ?? "none" };
		phase(bootstrap === null ? "deploy" : "deploy and bootstrap", bootstrap === null ? "部署" : "部署并运行 bootstrap");
		const boot = await deployAndBootstrap(env, image, bootstrap, signal);
		if (boot !== null) {
			report.bootstrap_exit_code = { kind: "line", value: String(boot.exitCode) };
			report.bootstrap_output_tail = { kind: "tail", text: boot.output };
			if (boot.exitCode !== 0) throw new Error(`bootstrap exited ${boot.exitCode}`);
		}
		report.usage = {
			kind: "line",
			value: `run project commands with container_exec in ${env.container}; local edits sync one-way into ${env.config.workdir} after each tool call; files created in the container are not copied back; after dependency changes edit the Dockerfile (the image is cached per Dockerfile content) or call remote_env_init with rebuild "image" or "prepare"; every call recreates the container and ends open container sessions`,
		};
		return renderReport("ready", report);
	} catch (error) {
		throw new Error(renderReport("failed", report, error instanceof Error ? error.message : String(error)));
	} finally {
		ctx.ui.setStatus("remote-build", undefined);
	}
}

/** Registers `remote_env_init` (agents) and `remote_env_build_image` (the preparer subagent only). */
export function registerInitTools(pi: ExtensionAPI, ensureEnv: (cwd: string) => Promise<PreparedEnv>): void {
	const initTool = {
		name: "remote_env_init",
		defaultInactive: true,
		label: tr("Remote env init", "远程环境初始化"),
		description: "Prepare this worktree's remote build container and return an initialization report.\n\nTopics — read the one a call needs before making it:\n- `xd://remote_env_init/usage` — before initializing, rebuilding, or recreating a worktree environment",
		docTopics: () => ({ usage: readFileSync(new URL("./topics/remote_env_init/usage.md", import.meta.url), "utf8") }),
		parameters: initSchema,
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = initSchema.parse(rawParams);
			if (ctx.agent.name === PREPARER_AGENT_NAME) {
				throw new Error("remote_env_init is not available to the preparer; use remote_env_build_image");
			}
			const mode: InitMode = params.rebuild === "image" ? "rebuild-image" : params.rebuild === "prepare" ? "reprepare" : "reuse";
			const report = await initEnvironment(pi, ctx, await ensureEnv(ctx.cwd), mode, signal);
			return { content: [{ type: "text", text: report }], details: { report } };
		},
	} satisfies ToolDefinition<typeof initSchema> & { docTopics(): Readonly<Record<string, string>> };
	pi.registerTool(initTool);

	const buildTool = {
		name: "remote_env_build_image",
		defaultInactive: true,
		label: tr("Remote env build image", "远程环境构建镜像"),
		description: "Build a candidate project image and run bootstrap for the preparer subagent.\n\nTopics — read the one a call needs before making it:\n- `xd://remote_env_build_image/usage` — before building a candidate or publishing the preparer's final report",
		docTopics: () => ({ usage: readFileSync(new URL("./topics/remote_env_build_image/usage.md", import.meta.url), "utf8") }),
		parameters: buildSchema,
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = buildSchema.parse(rawParams);
			if (ctx.agent.name !== PREPARER_AGENT_NAME) {
				throw new Error("remote_env_build_image is only available to the remote-env-preparer agent; call remote_env_init");
			}
			const env = await liveEnv(await ensureEnv(ctx.cwd));
			const source = env.config.imageSource;
			if (source.kind === "configured" || (source.kind === "dockerfile" && source.path !== GENERATED_DOCKERFILE)) {
				throw new Error(`${CONFIG_PATH} names an image or a hand-written Dockerfile; there is nothing to prepare`);
			}
			const dockerfile = params.dockerfile.endsWith("\n") ? params.dockerfile : `${params.dockerfile}\n`;
			if (stageBases(dockerfile).at(-1) !== BASE_IMAGE) throw new Error(`final stage must be FROM ${BASE_IMAGE}`);
			if (/^\s*(?:COPY|ADD)\s/im.test(dockerfile)) throw new Error("the build context is empty: COPY and ADD are not allowed");
			if (/[\r\n\0]/.test(params.bootstrap)) throw new Error("bootstrap must be a single line");
			const bootstrap = params.bootstrap.trim() || null;
			const pid = projectIdFor(await mainCheckout(env.root));
			const image = projectImage(pid, sha256(dockerfile));
			const dir = prepareDir(env.host, env.id);
			await writeRemoteFile(env.host, `${dir}/build/Dockerfile`, dockerfile);
			const build = await buildProjectImage(env.host, env.id, image, { contextPath: `${dir}/build`, dockerfile: "Dockerfile", text: dockerfile }, signal);
			const lines = [
				`image: ${image} ${build.result.exitCode === 0 ? "built" : `build failed (exit ${build.result.exitCode})`}`,
				tailBlock("build_output_tail", build.result.output),
			];
			if (build.result.exitCode !== 0) throw new Error(lines.join("\n"));
			const boot = await deployAndBootstrap(env, image, bootstrap, signal);
			lines.push(`container: ${env.container} recreated from ${image}; earlier container sessions have ended`);
			if (boot === null) {
				lines.push("bootstrap: none");
			} else {
				lines.push(`bootstrap: ${bootstrap} exit ${boot.exitCode}`, tailBlock("bootstrap_output_tail", boot.output));
				if (boot.exitCode !== 0) throw new Error(lines.join("\n"));
			}
			await writeRemoteFile(env.host, `${dir}/Dockerfile`, dockerfile);
			await writeRemoteFile(env.host, `${dir}/bootstrap`, bootstrap ?? "");
			lines.push(`candidate: this Dockerfile and bootstrap are published to ${GENERATED_DOCKERFILE} and ${CONFIG_PATH} when your final report has result: success`);
			const text = lines.join("\n");
			return { content: [{ type: "text", text }], details: { report: text } };
		},
	} satisfies ToolDefinition<typeof buildSchema> & { docTopics(): Readonly<Record<string, string>> };
	pi.registerTool(buildTool);
}
