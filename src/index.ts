import type { Stats } from "node:fs";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { applyActiveTools } from "../omomp-shared/active-tools.ts";
import { createDeltaStream, type Delta } from "../omomp-shared/context-delta.ts";
import { tr } from "../omomp-shared/i18n.ts";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { registerContainerTools } from "./container-tools.ts";
import { humanErrorMessage, RemoteBuildError } from "./diagnostics.ts";
import { checkHost, envIdFor, isMainCheckout, prepareEnv, worktreeRoot } from "./environment.ts";
import { loadHost } from "./host.ts";
import { registerInitTools } from "./init.ts";
import { findSession, flush } from "./mutagen.ts";
import { PREPARER_AGENT_NAME } from "./preparer.ts";
import type { EnvState, PreparedEnv, RemoteBuildConfig } from "./types.ts";

const WORKTREE_COMMAND = /^\/(?:wt|worktree)(?:\s|$)/;

const MOVE_COMMAND = /^\/(?:wt|worktree|move)(?:\s|$)/;

const MOVE_TIMEOUT_MS = 10 * 60 * 1000;

const NON_WRITING_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	ast_grep: true,
	web_search: true,
	todo: true,
	ask: true,
	ctx: true,
	wait: true,
	container_exec: true,
	container_write_stdin: true,
	container_list_sessions: true,
	container_kill_session: true,
	remote_env_build_image: true,
};

const CONTAINER_TOOLS = ["container_exec", "container_write_stdin", "container_list_sessions", "container_kill_session"];

const PLUGIN_TOOLS: Record<string, true> = {
	container_exec: true,
	container_write_stdin: true,
	container_list_sessions: true,
	container_kill_session: true,
	remote_env_init: true,
	remote_env_build_image: true,
};

export default function remoteBuild(pi: ExtensionAPI) {
	const envs = new Map<string, EnvState>();

	const begin = (root: string, config: RemoteBuildConfig): Promise<PreparedEnv> => {
		const done = prepareEnv(root, config).then(
			(env) => {
				envs.set(root, { kind: "ready", env });
				return env;
			},
			(error: unknown) => {
				envs.set(root, { kind: "failed", error: errorMessage(error) });
				throw error;
			},
		);
		done.catch(() => {});
		envs.set(root, { kind: "preparing", done });
		return done;
	};

	const stateFor = (cwd: string): EnvState | undefined => {
		const real = canonicalPath(cwd);
		if (real === undefined) return undefined;
		for (const [root, state] of envs) {
			const inside = relative(root, real);
			if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return state;
		}
		return undefined;
	};

	const ensureEnv = async (cwd: string): Promise<PreparedEnv> => {
		const state = stateFor(cwd);
		if (state === undefined) {
			const project = await projectConfig(cwd);
			if (project === undefined) throw new Error(`${cwd} is not in a remote-build project (no ${CONFIG_PATH})`);
			if (await isMainCheckout(project.root)) {
				throw new Error(`remote-build environments exist only in git worktrees; ${project.root} is the main checkout`);
			}
			return begin(project.root, project.config);
		}
		switch (state.kind) {
			case "ready":
				return state.env;
			case "preparing":
				return state.done;
			case "failed":
				throw new Error(`remote-build environment failed: ${state.error}`);
		}
	};

	registerContainerTools(pi, ensureEnv);
	registerInitTools(pi, ensureEnv);

	let baseline: ReadonlySet<string> = new Set();
	let reconciledCwd: string | undefined;
	const deltas = createDeltaStream("omp-remote-build/tools");

	const writeOwnTools = async (own: ReadonlySet<string>, force: boolean): Promise<void> => {
		const current = pi.getActiveTools();
		const currentOwn = new Set(current.filter((name) => name in PLUGIN_TOOLS));
		if (!force && currentOwn.size === own.size && [...own].every((name) => currentOwn.has(name))) return;
		await applyActiveTools(pi, [...current.filter((name) => !(name in PLUGIN_TOOLS)), ...own]);
	};

	const startLifecycle = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
		const availability = await availabilityFor(ctx);
		const own = new Set(availableTools(availability));
		await writeOwnTools(own, force);
		baseline = own;
		reconciledCwd = availability.cwd;
	};

	const reconcile = async (ctx: ExtensionContext): Promise<Delta> => {
		const availability = await availabilityFor(ctx);
		const available = availableTools(availability);
		if (available.some((name) => !baseline.has(name))) {
			const widened = new Set([...baseline, ...available]);
			await writeOwnTools(widened, false);
			baseline = widened;
		}
		reconciledCwd = availability.cwd;
		const unavailable = [...baseline].filter((name) => !available.includes(name));
		return unavailable.length === 0 ? { kind: "none" } : { kind: "text", body: unavailableBody(unavailable, availability) };
	};

	const warnToolsFailed = (ctx: ExtensionContext, error: unknown): void => {
		ctx.ui.notify(`${tr("remote-build: updating tools failed: ", "remote-build：更新工具失败：")}${humanErrorMessage(error)}`, "warning");
	};

	pi.on("session_switch", async (_event, ctx) => {
		await startLifecycle(ctx, false).catch((error: unknown) => warnToolsFailed(ctx, error));
	});
	pi.on("turn_start", () => {
		deltas.turnStarted();
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			return deltas.atPrompt(ctx, await reconcile(ctx));
		} catch (error) {
			warnToolsFailed(ctx, error);
			return undefined;
		}
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();
		if (!MOVE_COMMAND.test(text)) return undefined;
		const source = WORKTREE_COMMAND.test(text) ? await projectConfig(ctx.cwd) : undefined;
		if (source !== undefined) {
			try {
				await checkHost();
			} catch (error) {
				ctx.ui.notify(
					`${tr("remote-build: build host check failed, worktree not created: ", "remote-build：构建主机检查失败，未创建 worktree：")}${humanErrorMessage(error)}`,
					"error",
				);
				return { handled: true };
			}
		}
		void waitForMove(ctx, ctx.sessionManager.getCwd()).then(
			async (moved) => {
				if (source === undefined) return;
				const root = await worktreeRoot(moved);
				ctx.ui.setStatus("remote-build", `${tr("remote-build: preparing ", "remote-build：正在准备 ")}${root}`);
				try {
					const env = await begin(root, source.config);
					ctx.ui.notify(`${tr("remote-build: ready ", "remote-build：已就绪 ")}${env.container} <- ${root}`, "info");
				} catch (error) {
					ctx.ui.notify(
						`${tr("remote-build: environment failed for ", "remote-build：环境失败：")}${root}: ${humanErrorMessage(error)}`,
						"error",
					);
				} finally {
					ctx.ui.setStatus("remote-build", undefined);
				}
			},
			(error: unknown) => {
				if (source !== undefined) ctx.ui.notify(`${tr("remote-build: ", "remote-build：")}${humanErrorMessage(error)}`, "warning");
			},
		);
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		await startLifecycle(ctx, true).catch((error: unknown) => warnToolsFailed(ctx, error));
		const project = await projectConfig(ctx.cwd);
		if (project === undefined) return;
		if (ctx.agent.kind === "sub" && isIsolatedSubagent(ctx)) {
			void begin(project.root, project.config).catch(() => {});
		} else if (!(await isMainCheckout(project.root)) && (await findSession(await loadHost(), envIdFor(project.root)))) {
			void begin(project.root, project.config).catch(() => {});
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName in PLUGIN_TOOLS) {
			const availability = await availabilityFor(ctx);
			if (!availableTools(availability).includes(event.toolName)) {
				return { block: true, reason: unavailableBody([event.toolName], availability) };
			}
		}
		const state = stateFor(ctx.cwd);
		if (state === undefined || state.kind === "ready") return undefined;
		if (state.kind === "failed") return { block: true, reason: `remote-build environment failed: ${state.error}` };
		try {
			await state.done;
			return undefined;
		} catch (error) {
			return { block: true, reason: `remote-build environment failed: ${errorMessage(error)}` };
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!(event.toolName in NON_WRITING_TOOLS)) {
			const state = stateFor(ctx.cwd);
			if (state?.kind === "ready") await flush(state.env.host, state.env.mutagenSession);
		}
		if (ctx.sessionManager.getCwd() === reconciledCwd) return undefined;
		try {
			return deltas.afterTools(ctx, await reconcile(ctx));
		} catch (error) {
			warnToolsFailed(ctx, error);
			return undefined;
		}
	});
}

interface Project {
	readonly root: string;
	readonly config: RemoteBuildConfig;
}

function worktreeRootByFs(cwd: string): string | null | undefined {
	if (
		process.env.GIT_DIR !== undefined ||
		process.env.GIT_WORK_TREE !== undefined ||
		process.env.GIT_CEILING_DIRECTORIES !== undefined ||
		process.env.GIT_COMMON_DIR !== undefined
	) {
		return null; // git looks somewhere the walk does not know: let git answer
	}
	let current: string;
	try {
		current = realpathSync.native(cwd);
	} catch {
		return undefined; // no cwd to walk from: no project
	}
	for (;;) {
		const marker = `${current}/.git`;
		let markerStat: Stats;
		try {
			markerStat = statSync(marker);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				const parent = dirname(current);
				if (parent === current) return undefined; // walked past the fs root: not a git work tree
				current = parent;
				continue;
			}
			return null; // unreadable ancestor: let git judge
		}
		if (markerStat.isDirectory()) {
			const usable = isGitDirectory(marker);
			if (usable === null) return null;
			if (usable) return current; // main checkout root
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
			continue;
		}
		const gitdir = parseGitfile(marker);
		if (gitdir === undefined) return null;
		try {
			statSync(gitdir);
		} catch {
			return null;
		}
		return current;
	}
}

function isGitDirectory(gitdir: string): boolean | null {
	const head = join(gitdir, "HEAD");
	let text: string;
	try {
		if (lstatSync(head).isSymbolicLink()) return null;
		text = readFileSync(head, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR"))
			return false;
		return null;
	}
	if (!/^ref:\s*refs\/\S/.test(text) && !/^[0-9a-fA-F]{40}/.test(text)) return false;
	for (const name of ["objects", "refs"]) {
		try {
			if (!statSync(join(gitdir, name)).isDirectory()) return false;
		} catch (error) {
			if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
			return null;
		}
	}
	return true;
}

function parseGitfile(gitfile: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(gitfile, "utf8");
	} catch {
		return undefined;
	}
	const match = /^gitdir: (.+)$/m.exec(text);
	if (match === null) return undefined;
	const target = match[1].trim();
	return isAbsolute(target) ? target : join(dirname(gitfile), target);
}

async function projectConfig(cwd: string): Promise<Project | undefined> {
	const walked = worktreeRootByFs(cwd);
	if (walked === null) {
		let root: string;
		try {
			root = await worktreeRoot(cwd);
		} catch {
			return undefined;
		}
		const config = await loadConfig(root);
		return config === undefined ? undefined : { root, config };
	}
	if (walked === undefined) return undefined; // no `.git` anywhere up the fs root: no project, no subprocess
	const config = await loadConfig(walked);
	return config === undefined ? undefined : { root: walked, config };
}

type Availability =
	| { readonly kind: "project"; readonly cwd: string; readonly tools: readonly string[] }
	| { readonly kind: "outside"; readonly cwd: string }
	| { readonly kind: "invalid"; readonly cwd: string; readonly error: string };

async function availabilityFor(ctx: ExtensionContext): Promise<Availability> {
	const cwd = ctx.sessionManager.getCwd();
	let project: Project | undefined;
	try {
		project = await projectConfig(cwd);
	} catch (error) {
		return { kind: "invalid", cwd, error: humanErrorMessage(error) };
	}
	if (project === undefined) return { kind: "outside", cwd };
	const tools = [...CONTAINER_TOOLS, ctx.agent.name === PREPARER_AGENT_NAME ? "remote_env_build_image" : "remote_env_init"];
	return { kind: "project", cwd, tools };
}

function availableTools(availability: Availability): readonly string[] {
	switch (availability.kind) {
		case "project":
			return availability.tools;
		case "outside":
		case "invalid":
			return [];
		default: {
			const unreachable: never = availability;
			return unreachable;
		}
	}
}

function unavailableBody(tools: readonly string[], availability: Availability): string {
	let reason: string;
	switch (availability.kind) {
		case "project":
			reason = "they do not apply to this agent";
			break;
		case "outside":
			reason = `the current directory ${availability.cwd} is not inside a project whose worktree root has a valid ${CONFIG_PATH}`;
			break;
		case "invalid":
			reason = `${CONFIG_PATH} for the current directory ${availability.cwd} is invalid: ${availability.error}`;
			break;
		default: {
			const unreachable: never = availability;
			return unreachable;
		}
	}
	return `These remote-build tools are listed but unavailable: ${tools.join(", ")}. Reason: ${reason}. Calls to them are refused until the session is in a remote-build project again.`;
}

function isIsolatedSubagent(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "session_init" && "isolated" in entry && entry.isolated === true);
}

function canonicalPath(path: string): string | undefined {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
		throw error;
	}
}

function waitForMove(ctx: ExtensionContext, before: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const deadline = Date.now() + MOVE_TIMEOUT_MS;
	const tick = () => {
		const now = ctx.sessionManager.getCwd();
		if (now !== before) return resolve(now);
		if (Date.now() > deadline) return reject(new RemoteBuildError({ kind: "move-timeout" }));
		setTimeout(tick, 100);
	};
	setTimeout(tick, 100);
	return promise;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
