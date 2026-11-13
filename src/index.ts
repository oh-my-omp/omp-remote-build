import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Stats } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { applyActiveTools } from "./active-tools.ts";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { registerContainerTools } from "./container-tools.ts";
import { checkHost, envIdFor, isMainCheckout, prepareEnv, worktreeRoot } from "./environment.ts";
import { loadHost } from "./host.ts";
import { registerInitTools } from "./init.ts";
import { PREPARER_AGENT_NAME } from "./preparer.ts";
import { findSession, flush } from "./mutagen.ts";
import type { EnvState, PreparedEnv, RemoteBuildConfig } from "./types.ts";
import { tr } from "./i18n.ts";
import { humanErrorMessage, RemoteBuildError } from "./diagnostics.ts";
import { createDeltaStream, type Delta } from "./tool-delta.ts";

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
			// Both sides are realpathSync.native results; `relative` handles either separator.
			const inside = relative(root, real);
			if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return state;
		}
		return undefined;
	};

	/** The environment of the worktree containing `cwd`, prepared on demand inside a remote-build git worktree. */
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

	/**
	 * Tool set and prompt cache (oh-my-omp paradigm rule, "启用工具集与缓存"). The tools are registered with
	 * `defaultInactive`. A system lifecycle starts at session start or switch: the plugin then writes the tools
	 * that apply to the session's cwd and role (`availabilityFor`) into the active set, in canonical order, and
	 * those tools become the baseline. Within the lifecycle the active set is not rewritten when the cwd stops
	 * qualifying (`/wt`, `/move`, or omp-config's `wt` tool, which runs `/wt` without an `input` event): baseline
	 * tools that no longer apply are announced in a `omp-remote-build/tools` delta appended to the conversation
	 * and refused in `tool_call`, and the delta is retracted once they apply again, so the system/tools prefix
	 * and its prompt cache survive the move. Only a tool outside the baseline (the session started outside
	 * every opted-in project) widens the baseline with one canonical rewrite. Session start always writes the
	 * set, so the base system prompt is rebuilt with the plugin tools: a resumed session restores the active
	 * set from its transcript without that rebuild.
	 */
	let baseline: ReadonlySet<string> = new Set();
	/** The cwd whose availability the current delta reflects; a tool batch re-evaluates only after a move. */
	let reconciledCwd: string | undefined;
	const deltas = createDeltaStream("omp-remote-build/tools");

	/** Writes the active set with exactly `own` as this plugin's tools; no write when they already match, unless `force`. */
	const writeOwnTools = async (own: ReadonlySet<string>, force: boolean): Promise<void> => {
		const current = pi.getActiveTools();
		const currentOwn = new Set(current.filter(name => name in PLUGIN_TOOLS));
		if (!force && currentOwn.size === own.size && [...own].every(name => currentOwn.has(name))) return;
		await applyActiveTools(pi, [...current.filter(name => !(name in PLUGIN_TOOLS)), ...own]);
	};

	const startLifecycle = async (ctx: ExtensionContext, force: boolean): Promise<void> => {
		const availability = await availabilityFor(ctx);
		const own = new Set(availableTools(availability));
		await writeOwnTools(own, force);
		baseline = own;
		reconciledCwd = availability.cwd;
	};

	/** Widens the baseline when the cwd needs a tool outside it, then returns the delta for the baseline tools. */
	const reconcile = async (ctx: ExtensionContext): Promise<Delta> => {
		const availability = await availabilityFor(ctx);
		const available = availableTools(availability);
		if (available.some(name => !baseline.has(name))) {
			const widened = new Set([...baseline, ...available]);
			await writeOwnTools(widened, false);
			baseline = widened;
		}
		reconciledCwd = availability.cwd;
		const unavailable = [...baseline].filter(name => !available.includes(name));
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

	// /worktree in an opted-in project checks the build host before the native command runs and prepares
	// the new worktree's environment after the move. The tool delta follows at the next prompt or tool batch.
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
		await startLifecycle(ctx, true).catch((error: unknown) => warnToolsFailed(ctx, error));
		const project = await projectConfig(ctx.cwd);
		if (project === undefined) return;
		if (ctx.agent.kind === "sub" && isIsolatedSubagent(ctx)) {
			// Isolated subagent: its own workspace gets its own environment.
			void begin(project.root, project.config).catch(() => {});
		} else if (!(await isMainCheckout(project.root)) && (await findSession(await loadHost(), envIdFor(project.root)))) {
			// Session (re)opened inside a worktree whose environment already exists.
			void begin(project.root, project.config).catch(() => {});
		}
	});

	// A baseline tool the cwd does not qualify for is refused with the reason the delta gives.
	// No tool runs in a worktree whose environment is still preparing or failed.
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

	// Implicit flush after every write-class tool call; after a batch that moved the session, the tool delta.
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

/** An opted-in worktree: its canonical root and the config read from it. */
interface Project {
	readonly root: string;
	readonly config: RemoteBuildConfig;
}

/**
 * The git worktree root containing `cwd`, found by walking up to the first
 * ancestor whose `.git` entry is a usable repository: a directory that passes
 * git's acceptance checks, or a gitfile whose `gitdir` target exists. A `.git`
 * directory that is not a usable repository — missing HEAD, an invalid HEAD, or
 * no `objects`/`refs` directory — is skipped, as git does, and the walk
 * continues above it. Returns:
 * - the root when the walk decides (a usable `.git` directory, or a gitfile
 *   whose target exists);
 * - `undefined` when no usable `.git` exists anywhere up to the fs root — git
 *   would also report no work tree, so the caller can refuse the project
 *   without a subprocess (issue #21 result 1 covers project-external cwds too);
 * - `null` when the walk cannot decide and git's answer must be asked: a git
 *   env override (the real git looks somewhere the walk does not know), an
 *   unreadable ancestor, a symlinked HEAD, or a `.git` file that is not a
 *   parseable gitfile.
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
		if (markerStat.isDirectory()) {
			const usable = isGitDirectory(marker);
			if (usable === null) return null;
			if (usable) return current; // main checkout root
			// Not a git directory: git skips it and keeps looking above.
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
			continue;
		}
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

/**
 * Whether `gitdir` is a directory git would accept as a repository, or `null`
 * when only git can decide. Git accepts a HEAD that is `ref:` pointing into
 * `refs/` (any whitespace after the colon) or a hexadecimal object id, plus
 * `objects/` and `refs/` directories; a symlinked HEAD is left to git.
 */
function isGitDirectory(gitdir: string): boolean | null {
	const head = join(gitdir, "HEAD");
	let text: string;
	try {
		// Git follows a symlinked HEAD itself, including one whose ref is unborn.
		if (lstatSync(head).isSymbolicLink()) return null;
		text = readFileSync(head, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR")) return false;
		return null;
	}
	// Git validates the symbolic ref's `refs/` prefix, and for a detached HEAD
	// accepts a leading hexadecimal object id, inspecting nothing after it.
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

/** What the session's current cwd allows this plugin's tools: the cwd is in an opted-in project, outside every one, or its config is invalid. */
type Availability =
	| { readonly kind: "project"; readonly cwd: string; readonly tools: readonly string[] }
	| { readonly kind: "outside"; readonly cwd: string }
	| { readonly kind: "invalid"; readonly cwd: string; readonly error: string };

/**
 * The plugin tools that apply to `ctx`'s session: none unless the session's current cwd is inside an opted-in
 * project, meaning its worktree root has a valid `.omp/remote-build.json`. Main checkout and linked worktrees
 * both qualify, so moving between them within a project changes nothing. Calls from the main checkout still
 * fail in `ensureEnv`, which reports that environments exist only in git worktrees. The tools are the container
 * tools plus `remote_env_build_image` for the preparer or `remote_env_init` for every other agent. The cwd comes
 * from the session manager: `ctx.cwd` is fixed when the event's context is created.
 */
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

/** Model-facing text: which listed tools are unavailable now and why. */
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
