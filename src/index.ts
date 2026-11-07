import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Stats } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { applyActiveTools, canonicalToolOrder } from "./active-tools.ts";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { registerContainerTools } from "./container-tools.ts";
import { checkHost, envIdFor, mainCheckout, prepareEnv, worktreeRoot } from "./environment.ts";
import { loadHost } from "./host.ts";
import { registerInitTools } from "./init.ts";
import { PREPARER_AGENT_NAME } from "./preparer.ts";
import { findSession, flush } from "./mutagen.ts";
import type { EnvState, PreparedEnv, RemoteBuildConfig } from "./types.ts";
import { tr } from "./i18n.ts";
import { humanErrorMessage, RemoteBuildError } from "./diagnostics.ts";

/** `/worktree [branch]` and its registered name `/wt`. */
const WORKTREE_COMMAND = /^\/(?:wt|worktree)(?:\s|$)/;

/** Commands that move the session to another directory: `/worktree`, `/wt` and `/move <path>`. */
const MOVE_COMMAND = /^\/(?:wt|worktree|move)(?:\s|$)/;

/** Upper bound for the native command to move the session into the new worktree. */
const MOVE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tools that cannot change files in the worktree. Every other tool call is treated
 * as a write (edit/write by definition; eval, exec_command, bash, task, ... because
 * their side effects are unknown) and is followed by a Mutagen flush.
 */
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
	// Builds candidates on the build host only; never writes local files.
	remote_env_build_image: true,
};

const CONTAINER_TOOLS = ["container_exec", "container_write_stdin", "container_list_sessions", "container_kill_session"];

/** Every tool this plugin registers; {@link activeToolsFor} decides which of them a session shows. */
const PLUGIN_TOOLS: Record<string, true> = {
	container_exec: true,
	container_write_stdin: true,
	container_list_sessions: true,
	container_kill_session: true,
	remote_env_init: true,
	remote_env_build_image: true,
};

export default function remoteBuild(pi: ExtensionAPI) {
	/** Environment state per worktree root, for this agent session. */
	const envs = new Map<string, EnvState>();

	const begin = (root: string, config: RemoteBuildConfig): Promise<PreparedEnv> => {
		const done = prepareEnv(root, config).then(
			env => {
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
			if (real === root || real.startsWith(`${root}/`)) return state;
		}
		return undefined;
	};

	/** The environment of the worktree containing `cwd`, prepared on demand inside a remote-build git worktree. */
	const ensureEnv = async (cwd: string): Promise<PreparedEnv> => {
		const state = stateFor(cwd);
		if (state === undefined) {
			const project = await projectConfig(cwd);
			if (project === undefined) throw new Error(`${cwd} is not in a remote-build project (no ${CONFIG_PATH})`);
			if (project.root === (await mainCheckout(project.root))) {
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

	/**
	 * Shows this plugin's tools in every directory of an opted-in project (main checkout or linked worktree)
	 * whose config parses, for the session's role; calls made from the main checkout still fail in `ensureEnv`.
	 * The tools are registered with `defaultInactive`, so no session has them active from the factory. This runs at
	 * session start and switch, after `/worktree`, `/wt` or `/move` has moved the session, and before every
	 * agent start. The per-turn run covers moves made without the input box: an extension tool such as
	 * omp-config's `wt` runs `/wt` through `executeBuiltinSlashCommand`, which emits no `input` event, and
	 * `moveSession` emits no event either. The new active set keeps every other active tool, drops plugin
	 * tools that are not wanted, adds the wanted plugin tools, and orders them canonically: builtins first in
	 * `pi.getAllTools()` order, then every other name sorted by code point (`canonicalToolOrder`), so the order
	 * does not depend on extension registration timing. Session start passes `force` and always applies the set, so the base system prompt is
	 * rebuilt with the plugin tools: a resumed session restores the active set from its transcript without that
	 * rebuild. The other call sites apply it only when the set or its order differs from the current active tools,
	 * so their per-turn sync is a no-op while the cwd is unchanged.
	 */
	const syncActiveTools = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
		const wanted = new Set(await activeToolsFor(ctx));
		const current = pi.getActiveTools();
		const kept = current.filter(name => !(name in PLUGIN_TOOLS) || wanted.has(name));
		const enabled = [...wanted].filter(name => !current.includes(name));
		const next = canonicalToolOrder(pi.getAllTools(), [...kept, ...enabled]);
		if (!force && next.length === current.length && next.every((name, i) => name === current[i])) return;
		await applyActiveTools(pi, next);
	};
	const syncActiveToolsLogged = (ctx: ExtensionContext, force: boolean): Promise<void> =>
		syncActiveTools(ctx, force).catch((error: unknown) => {
			ctx.ui.notify(`${tr("remote-build: updating tools failed: ", "remote-build：更新工具失败：")}${humanErrorMessage(error)}`, "warning");
		});

	pi.on("session_switch", async (_event, ctx) => {
		await syncActiveToolsLogged(ctx, false);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await syncActiveToolsLogged(ctx, false);
		return undefined;
	});

	// /worktree and /move: once the session has moved, show the tools that apply there.
	// /worktree in an opted-in project also checks the build host before the native command
	// runs and prepares the new worktree's environment after the move.
	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();
		if (!MOVE_COMMAND.test(text)) return undefined;
		const source = WORKTREE_COMMAND.test(text) ? await projectConfig(ctx.cwd) : undefined;
		if (source !== undefined) {
			try {
				await checkHost();
			} catch (error) {
				ctx.ui.notify(`${tr("remote-build: build host check failed, worktree not created: ", "remote-build：构建主机检查失败，未创建 worktree：")}${humanErrorMessage(error)}`, "error");
				return { handled: true };
			}
		}
		void waitForMove(ctx, ctx.sessionManager.getCwd()).then(
			async moved => {
				await syncActiveToolsLogged(ctx, false);
				if (source === undefined) return;
				const root = await worktreeRoot(moved);
				ctx.ui.setStatus("remote-build", `${tr("remote-build: preparing ", "remote-build：正在准备 ")}${root}`);
				try {
					const env = await begin(root, source.config);
					ctx.ui.notify(`${tr("remote-build: ready ", "remote-build：已就绪 ")}${env.container} <- ${root}`, "info");
				} catch (error) {
					ctx.ui.notify(`${tr("remote-build: environment failed for ", "remote-build：环境失败：")}${root}: ${humanErrorMessage(error)}`, "error");
				} finally {
					ctx.ui.setStatus("remote-build", undefined);
				}
			},
			(error: unknown) => {
				// A failed /move or a /worktree outside a remote-build project changes nothing here.
				if (source !== undefined) ctx.ui.notify(`${tr("remote-build: ", "remote-build：")}${humanErrorMessage(error)}`, "warning");
			},
		);
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncActiveToolsLogged(ctx, true);
		const project = await projectConfig(ctx.cwd);
		if (project === undefined) return;
		if (ctx.agent.kind === "sub" && isIsolatedSubagent(ctx)) {
			// Isolated subagent: its own workspace gets its own environment.
			void begin(project.root, project.config).catch(() => {});
		} else if (project.root !== (await mainCheckout(project.root)) && (await findSession(await loadHost(), envIdFor(project.root)))) {
			// Session (re)opened inside a worktree whose environment already exists.
			void begin(project.root, project.config).catch(() => {});
		}
	});

	// No tool runs in a worktree whose environment is still preparing or failed.
	pi.on("tool_call", async (_event, ctx) => {
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

	// Implicit flush after every write-class tool call.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName in NON_WRITING_TOOLS) return undefined;
		const state = stateFor(ctx.cwd);
		if (state?.kind !== "ready") return undefined;
		await flush(state.env.host, state.env.mutagenSession);
		return undefined;
	});
}

/** An opted-in worktree: its canonical root and the config read from it. */
interface Project {
	readonly root: string;
	readonly config: RemoteBuildConfig;
}

/**
 * The git worktree root containing `cwd`, found by walking up until the first
 * ancestor with a `.git` entry (directory for a main checkout, file for a
 * linked worktree), then confirming that entry resolves to a usable repository:
 * a worktree's gitfile must point at an existing `gitdir`. Returns:
 * - the root when the walk decides (a `.git` directory, or a gitfile whose
 *   target exists);
 * - `undefined` when no `.git` exists anywhere up to the fs root — git would
 *   also report no work tree, so the caller can refuse the project without a
 *   subprocess (issue #21 result 1 covers project-external cwds too);
 * - `null` when the walk cannot decide and git's answer must be asked: a git
 *   env override (the real git looks somewhere the walk does not know), an
 *   unreadable ancestor, or a `.git` file that is not a parseable gitfile.
 *
 * `cwd` is canonicalized first, so the returned root matches what
 * `realpathSync.native(<git rev-parse --show-toplevel>)` returned before, and
 * a symlinked cwd finds the repository behind the link.
 */
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
		if (markerStat.isDirectory()) return current; // main checkout root
		// `.git` file: a linked worktree's gitfile. An unparseable one or a
		// gitdir target that has vanished is the walk's horizon: git judges.
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

/** `gitdir: <path>` value of a worktree gitfile, resolved against the file's directory; undefined when unparseable. */
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
		// The fs walk could not decide (unreadable ancestor, malformed gitfile):
		// let git judge, as before. Rare bounds — a plain non-git cwd or a dead
		// gitfile never reach here when the walk can answer them itself.
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

/**
 * The plugin tools to show in `ctx`'s session: none unless the session's current cwd is inside an opted-in
 * project, meaning its worktree root has a valid `.omp/remote-build.json`. Main checkout and linked worktrees
 * both qualify, so moving between them within a project does not change the tool set and the prompt cache
 * stays valid. Calls from the main checkout still fail in `ensureEnv`, which reports that environments exist
 * only in git worktrees. The tools are the container tools plus `remote_env_build_image` for the preparer or
 * `remote_env_init` for every other agent. The cwd comes from the session manager: `ctx.cwd` is fixed when the
 * event's context is created.
 */
async function activeToolsFor(ctx: ExtensionContext): Promise<string[]> {
	let project: Project | undefined;
	try {
		project = await projectConfig(ctx.sessionManager.getCwd());
	} catch {
		return []; // invalid config: ensureEnv would reject every call
	}
	if (project === undefined) return [];
	return [...CONTAINER_TOOLS, ctx.agent.name === PREPARER_AGENT_NAME ? "remote_env_build_image" : "remote_env_init"];
}

/**
 * True when any `session_init` entry of the session carries `isolated` — not only
 * the first: a forked/tan session appends its own `session_init` mid-tree
 * (`session-manager.ts` `appendSessionInit` parents it at the current leaf, and
 * `extractSessionInit` documents several per file). The host's read-only surface
 * (`ReadonlySessionManager`) exposes the whole entry set only through
 * `getEntries()`/`getTree()`/`getBranch()`, each of which materializes more than
 * the scan needs (`getEntries` copies the array; `getTree` allocates a node per
 * entry; `getBranch` would narrow the answer to one branch, changing the
 * semantics), so the iteration cost stays linear in the entry count. Issue
 * oh-my-omp/omp-remote-build#21 decides row 3: keep the semantics, keep
 * `getEntries()`, and record that the host offers no smaller entry point.
 */
function isIsolatedSubagent(ctx: ExtensionContext): boolean {
	return ctx.sessionManager
		.getEntries()
		.some(entry => entry.type === "session_init" && "isolated" in entry && entry.isolated === true);
}

/**
 * Canonical form of `path`, or `undefined` when it no longer exists (e.g. the session's worktree was
 * removed): a missing path lies in no prepared worktree. `path` may differ in letter case from git's
 * root on case-insensitive file systems, so the comparison uses the real path.
 */
function canonicalPath(path: string): string | undefined {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
		throw error;
	}
}

/** Resolves with the session cwd once the native command has moved the session away from `before`. */
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
