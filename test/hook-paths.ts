/**
 * Acceptance harness for issue #21: the per-turn hook path (`before_agent_start`
 * → `syncActiveTools` → `projectConfig`) must not spawn a child process, and
 * `isIsolatedSubagent` must keep its "any `session_init` with `isolated`"
 * judgment (the host's read-only surface offers no smaller entry, recorded in
 * `src/index.ts`).
 *
 * Loads the plugin's real default export from the checkout given as argv[1],
 * registers it against a stub `pi` API, then drives the captured handlers with
 * realistic `ExtensionContext`s whose `sessionManager` stub counts the entry
 * materializations each judgment performs.
 *
 * Hermetic by construction: `PI_CODING_AGENT_DIR` points at a fixture agent dir
 * holding a host config whose Komodo endpoint is `http://127.0.0.1:1` (instant
 * ECONNREFUSED), whose `mutagen`/`km` binaries are exit-0 stubs, and whose `ssh`
 * target is an unresolvable fixture hostname (`stub-host`), so the real ssh
 * binary fails in local name resolution without reaching any host. Nothing
 * consults the machine's real host config, a reachable Komodo, or a Mutagen
 * daemon. (A runtime `PATH` override is not used for stubbing: Bun.spawn
 * resolves programs from the process's launch PATH.)
 *
 * Bounded by construction: every scenario runs under a hard wall-clock budget and
 * a scenario that overruns exits non-zero instead of hanging; the awaits that
 * depend on the plugin's fire-and-forget work gate on an observed event with a
 * deadline, never on a blind sleep; the process exits explicitly so a pending
 * plugin timer cannot hold the harness open.
 *
 * Usage:
 *   EXPECT_LIGHT=0 bun test/hook-paths.ts <checkout>   # baseline: behavior + spawn census
 *   bun test/hook-paths.ts <checkout>                  # additionally asserts the fix's goals
 *
 * Scenarios (issue #21 acceptance rows 1-4):
 *   1. 24 turns x 4 cwds (opted-in main checkout, linked worktree, nested repo,
 *      non-git dir) through `before_agent_start`: spawn census = 0;
 *   2. edge matrix: non-git dir, dead gitfile, symlinked cwd; active sets per
 *      fixture identical to the pre-change verdicts;
 *   3. isolated judgment over four session shapes plus a non-subagent context,
 *      recording `getEntries`/`getChildren`/`getTree` per judgment;
 *   4. `/worktree` in and outside an opted-in project: the host check runs only
 *      inside (ssh spawn observed) and `session_start` branches on the isolated
 *      flag (ssh only for the isolated subagent).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdirSync as mkdir, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ReadonlySessionManager, SessionEntry } from "@oh-my-pi/pi-coding-agent";

const EXPECT_LIGHT = process.env.EXPECT_LIGHT !== "0";
const ROOT = process.argv[2];
if (ROOT === undefined) throw new Error("usage: bun test/hook-paths.ts <checkout>");

const CONFIG_PATH = ".omp/remote-build.json";
/** Turns evaluated per fixture in scenario 1. */
const TURNS = 24;
/** Wall-clock budget per scenario; exceeding it is a harness failure, never a hang. */
const SCENARIO_BUDGET_MS = 30_000;
/** Deadline for observing the plugin's fire-and-forget work in a gated await. */
const OBSERVE_DEADLINE_MS = 10_000;
const CONTAINER = ["container_exec", "container_write_stdin", "container_list_sessions", "container_kill_session"];
const PROJECT_CONFIG = { workdir: "/workspace", shell: "bash", ignore: ["*.log"], env: { CARGO_TARGET_DIR: "/workspace/target" } };

// --- fixture root and hermetic host environment ------------------------------

const fixtureRoot = join(tmpdir(), `rb21-${process.pid}-${Date.now().toString(36)}`);
const binDir = join(fixtureRoot, "bin");
const agentDir = join(fixtureRoot, "agent");
mkdirSync(binDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

/** Exit-0 stubs for the binaries the plugin launches by absolute path. */
function stub(name: string): string {
	const path = join(binDir, name);
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	execFileSync("chmod", ["+x", path]);
	return path;
}
stub("mutagen");
stub("km");
// The plugin resolves `<agent dir>/remote-build.json` through the host package;
// point it at a fixture dir so the machine's real build host is never consulted.
process.env.PI_CODING_AGENT_DIR = agentDir;

const kmCliConfig = join(fixtureRoot, "komodo.cli.toml");
writeFileSync(kmCliConfig, `[[profile]]\nname = "stub"\nhost = "http://127.0.0.1:1"\nkey = "K-test"\nsecret = "S-test"\n`);
writeFileSync(
	join(agentDir, "remote-build.json"),
	JSON.stringify({
		ssh: "stub-host",
		remoteRoot: "/srv/remote-build",
		komodo: { profile: "stub", server: "stub-server", cliConfig: kmCliConfig },
		bin: { km: join(binDir, "km"), mutagen: join(binDir, "mutagen") },
	}),
);

// --- spawn census ------------------------------------------------------------

interface SpawnRecord {
	readonly program: string;
	readonly args: readonly string[];
}

let spawns: SpawnRecord[] = [];
let censusArmed = false;

const realSpawn = Bun.spawn.bind(Bun);
(Bun as unknown as { spawn: unknown }).spawn = function censusSpawn(args: string[], options?: unknown) {
	if (censusArmed) spawns.push({ program: args[0] ?? "<unknown>", args });
	return realSpawn(args, options as never);
} as typeof Bun.spawn;

const resetSpawns = (): void => {
	spawns = [];
};
const spawnedProgram = (program: string): boolean => spawns.some(record => record.program === program);
/** True when a `git` call carried `flag` (e.g. `--git-common-dir` from `mainCheckout`). */
const spawnedGitWith = (flag: string): boolean => spawns.some(record => record.program === "git" && record.args.includes(flag));

// --- git fixtures ------------------------------------------------------------

const git = (repo: string, ...argv: string[]): string => execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8" });

function initRepo(path: string): void {
	mkdir(path, { recursive: true });
	git(path, "init", "-q", "-b", "main");
	git(path, "config", "user.email", "t@example.com");
	git(path, "config", "user.name", "t");
	writeFileSync(join(path, "README.md"), "fixture\n");
	git(path, "add", ".");
	git(path, "commit", "-qm", "init");
}

function writeConfig(at: string): void {
	mkdirSync(join(at, ".omp"), { recursive: true });
	writeFileSync(join(at, CONFIG_PATH), JSON.stringify(PROJECT_CONFIG));
}

// --- stub pi API + realistic sessionManager stub ------------------------------

interface Registered {
	readonly handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>;
	readonly tools: string[];
	active: string[];
	allTools: () => { name: string; sourceInfo: { source: string } }[];
}

function makePi(): Registered {
	const registered: Registered = {
		handlers: new Map(),
		tools: [],
		active: [],
		allTools: () => [],
	};
	registered.allTools = () => [
		{ name: "read", sourceInfo: { source: "builtin" } },
		{ name: "edit", sourceInfo: { source: "builtin" } },
		...registered.tools.map(name => ({ name, sourceInfo: { source: "extension" } })),
	];
	const pi = {
		on: (event: string, handler: unknown) => {
			registered.handlers.set(event, handler as never);
		},
		registerTool: (tool: { name: string }) => {
			registered.tools.push(tool.name);
		},
		getActiveTools: () => [...registered.active],
		setActiveTools: (names: string[]) => {
			registered.active = [...names];
			return Promise.resolve();
		},
		getAllTools: registered.allTools,
	} as unknown as ExtensionAPI;
	plugin(pi);
	return registered;
}

/** Entry shapes the judgment scans; `isolated` marks a session_init contract. */
interface TreeSpec {
	readonly entries: { id: string; parentId: string | null; type: string; isolated?: boolean }[];
}

interface CtxCounts {
	getEntries: number;
	getChildren: number;
	getTree: number;
}

interface Notification {
	readonly message: string;
	readonly level: string;
}

interface HarnessCtx {
	readonly ctx: ExtensionContext;
	readonly counts: CtxCounts;
	readonly notifications: Notification[];
	/** Resolves once `getCwd` has reported a move; never resolves without `moveTo`. */
	readonly movedSeen: Promise<void>;
}

/**
 * A context whose `sessionManager` mirrors the host's replica-allocating reads
 * (`getEntries` returns a fresh array, `getChildren`/`getTree` fresh arrays).
 * With `moveTo`, the first `getCwd` reports `cwd` (the `/worktree` waiter's
 * "before" value) and every later call reports `moveTo`, so the waiter resolves
 * on its first tick instead of polling for its ten-minute timeout.
 */
function makeCtx(opts: { cwd: string; tree?: TreeSpec; subagent?: boolean; moveTo?: string }): HarnessCtx {
	const tree: Record<string, { parentId: string | null; type: string; isolated?: boolean }> = {};
	for (const entry of opts.tree?.entries ?? []) tree[entry.id] = { parentId: entry.parentId, type: entry.type, isolated: entry.isolated };
	const all: SessionEntry[] = Object.entries(tree).map(
		([id, node]) =>
			({
				type: node.type,
				id,
				parentId: node.parentId,
				timestamp: "",
				isolated: node.isolated,
			}) as unknown as SessionEntry,
	);
	const childrenOf = (parentId: string | null): SessionEntry[] => all.filter(entry => entry.parentId === parentId);
	const counts: CtxCounts = { getEntries: 0, getChildren: 0, getTree: 0 };
	const { promise: movedSeen, resolve: resolveMoved } = Promise.withResolvers<void>();
	let cwdCalls = 0;
	const notifications: Notification[] = [];
	const sessionManager = {
		getCwd: () => {
			cwdCalls++;
			if (opts.moveTo !== undefined && cwdCalls > 1) {
				resolveMoved();
				return opts.moveTo;
			}
			return opts.cwd;
		},
		getEntries: () => {
			counts.getEntries++;
			return [...all];
		},
		getEntry: (id: string) => all.find(entry => entry.id === id),
		getChildren: (parentId: string) => {
			counts.getChildren++;
			return childrenOf(parentId);
		},
		getLeafEntry: () => all[all.length - 1],
		getBranch: () => childrenOf(null),
		getTree: () => {
			counts.getTree++;
			return childrenOf(null).map(entry => ({ entry, children: [] }));
		},
		getHeader: () => null,
	} as unknown as ReadonlySessionManager;
	const context = {
		cwd: opts.cwd,
		sessionManager,
		agent: { name: "test-agent", kind: opts.subagent ? "sub" : "main", depth: opts.subagent ? 1 : 0 },
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: () => {},
		},
	} as unknown as ExtensionContext;
	return { ctx: context, counts, notifications, movedSeen };
}

// the plugin loads after the hermetic environment is in place
const { default: plugin } = (await import(`${ROOT}/src/index.ts`)) as { default: (pi: ExtensionAPI) => void };

// --- assertions and bounded scenario runner ----------------------------------

const failures: string[] = [];

function check(name: string, condition: boolean, detail: string): void {
	if (condition) console.log(`  ok: ${name}`);
	else {
		failures.push(`${name}: ${detail}`);
		console.log(`  FAIL: ${name}: ${detail}`);
	}
}

const call = async (registered: Registered, event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> => {
	const handler = registered.handlers.get(event);
	if (handler === undefined) throw new Error(`handler not registered: ${event}`);
	return handler(payload, ctx);
};

/** Runs `body` under a hard wall clock; a scenario that overruns exits non-zero instead of hanging. */
async function scenario(name: string, body: () => Promise<void>): Promise<void> {
	const started = Date.now();
	const timer = setTimeout(() => {
		console.error(`\nSCENARIO TIMEOUT: "${name}" exceeded ${SCENARIO_BUDGET_MS}ms — harness aborted`);
		process.exit(1);
	}, SCENARIO_BUDGET_MS);
	try {
		await body();
	} finally {
		clearTimeout(timer);
	}
	console.log(`  (${name}: ${Date.now() - started}ms)`);
}

/** Waits until `condition` holds, failing at `OBSERVE_DEADLINE_MS`; never waits unconditionally. */
async function observed(what: string, condition: () => boolean): Promise<boolean> {
	const deadline = Date.now() + OBSERVE_DEADLINE_MS;
	while (!condition()) {
		if (Date.now() > deadline) {
			console.log(`  FAIL: ${what} was not observed within ${OBSERVE_DEADLINE_MS}ms`);
			failures.push(`${what}: not observed`);
			return false;
		}
		await Bun.sleep(10);
	}
	return true;
}

const expectedFull = [...CONTAINER, "remote_env_init"];
/** The host's canonical order: requested builtins in registry order, then extension names sorted by code point. */
const canonical = (names: string[], all: { name: string; sourceInfo: { source: string } }[]): string => {
	const requested = new Set(names);
	const builtins = [...new Set(all.filter(tool => tool.sourceInfo.source === "builtin" && requested.has(tool.name)).map(tool => tool.name))];
	const builtinSet = new Set(builtins);
	return [...builtins, ...[...requested].filter(name => !builtinSet.has(name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))].join(",");
};

// --- scenarios ---------------------------------------------------------------

/** Row 1: no child process on the per-turn path, active sets unchanged. */
async function perTurnCensus(registered: Registered, dirs: { repoMain: string; wt: string; plain: string; nested: string }): Promise<void> {
	const contexts = [dirs.repoMain, dirs.wt, dirs.plain, dirs.nested].map(cwd => makeCtx({ cwd }).ctx);
	resetSpawns();
	censusArmed = true;
	try {
		for (let turn = 0; turn < TURNS; turn++) {
			for (const ctx of contexts) {
				await call(registered, "before_agent_start", { type: "before_agent_start", prompt: "x", systemPrompt: [] }, ctx);
			}
		}
	} finally {
		censusArmed = false;
	}
	console.log(`\n--- scenario 1: per-turn re-eval, ${TURNS} turns x 4 cwds ---`);
	console.log(`spawns: ${spawns.length}`);
	const byProgram = new Map<string, number>();
	for (const record of spawns) byProgram.set(record.program, (byProgram.get(record.program) ?? 0) + 1);
	for (const [program, count] of byProgram) console.log(`  ${program}: ${count}`);
	if (EXPECT_LIGHT) check("no spawns on per-turn path", spawns.length === 0, `got ${spawns.length} spawns`);
	else console.log("  (baseline mode: the zero-spawn goal is the change under test, not asserted here)");

	console.log("\n--- scenario 2b: active set per fixture (row 1 expectation) ---");
	for (const one of [
		{ name: "main checkout", cwd: dirs.repoMain, expect: "full" },
		{ name: "worktree", cwd: dirs.wt, expect: "full" },
		{ name: "plain dir", cwd: dirs.plain, expect: "none" },
		{ name: "nested repo", cwd: dirs.nested, expect: "full" },
	]) {
		registered.active = ["read", "edit"];
		await call(registered, "session_switch", { type: "session_switch", reason: "new" }, makeCtx({ cwd: one.cwd }).ctx);
		const withKeep = one.expect === "none" ? ["read", "edit"] : ["read", "edit", ...expectedFull];
		const expected = canonical(withKeep, registered.allTools());
		check(`${one.name} active set`, registered.active.join(",") === expected, `got ${registered.active.join(",")}`);
	}
}

/** Rows 1 (negative) and 2: each edge cwd keeps its pre-change verdict. */
async function edgeMatrix(
	registered: Registered,
	edges: { nonGit: string; deadGitfile: string; linkDir: string; linkSrc: string },
): Promise<void> {
	for (const one of [
		{ name: "non-git dir", cwd: edges.nonGit, expect: "none" },
		{ name: "dead gitfile", cwd: edges.deadGitfile, expect: "none" },
		{ name: "symlinked cwd", cwd: edges.linkDir, expect: "full" },
	]) {
		registered.active = [];
		await call(registered, "session_switch", { type: "session_switch", reason: "new" }, makeCtx({ cwd: one.cwd }).ctx);
		const expected = canonical(one.expect === "none" ? [] : expectedFull, registered.allTools());
		check(`${one.name}: verdict`, registered.active.join(",") === expected, `got ${registered.active.join(",")}`);
	}
	// sanity: the symlink target really is an opted-in repo (a broken fixture would
	// make the "full" expectation vacuous)
	const parsed: unknown = JSON.parse(readFileSync(join(edges.linkSrc, CONFIG_PATH), "utf8"));
	check("symlink target is opted in", typeof parsed === "object" && parsed !== null, `config unreadable at ${edges.linkSrc}`);
}

/** Row 3: four session shapes plus a non-subagent context; verdict + entry-read census. */
async function isolatedJudgment(registered: Registered): Promise<void> {
	const shapes: { name: string; tree: TreeSpec; subagent: boolean; expectIsolated: boolean }[] = [
		{ name: "single isolated init", tree: { entries: [{ id: "0", parentId: null, type: "session_init", isolated: true }] }, subagent: true, expectIsolated: true },
		{ name: "single plain init", tree: { entries: [{ id: "0", parentId: null, type: "session_init" }] }, subagent: true, expectIsolated: false },
		{ name: "no init", tree: { entries: [{ id: "0", parentId: null, type: "message" }, { id: "1", parentId: "0", type: "message" }] }, subagent: true, expectIsolated: false },
		{
			name: "late isolated init on a sibling branch",
			tree: {
				entries: [
					{ id: "0", parentId: null, type: "message" },
					{ id: "1", parentId: "0", type: "session_init" },
					{ id: "2", parentId: "0", type: "message" },
					{ id: "3", parentId: "0", type: "session_init", isolated: true },
					{ id: "4", parentId: "0", type: "message" },
				],
			},
			subagent: true,
			expectIsolated: true,
		},
		{ name: "non-subagent context", tree: { entries: [{ id: "0", parentId: null, type: "session_init", isolated: true }] }, subagent: false, expectIsolated: false },
	];

	for (const [index, shape] of shapes.entries()) {
		const repo = join(fixtureRoot, `iso-repo-${index}`);
		initRepo(repo);
		writeConfig(repo);
		const wt = join(fixtureRoot, `iso-wt-${index}`);
		git(repo, "worktree", "add", "-q", "-b", `iso-branch-${index}`, wt);
		writeConfig(wt);
		const harness = makeCtx({ cwd: wt, tree: shape.tree, subagent: shape.subagent });
		resetSpawns();
		censusArmed = true;
		try {
			await call(registered, "session_start", { type: "session_start" }, harness.ctx);
			// The isolated branch starts preparing an environment in the background
			// (checkHost → ssh). Gate on that observable event, not on a sleep: a
			// subagent whose judgment is false instead runs mainCheckout
			// (`git --git-common-dir`), which is equally observable.
			await observed(`${shape.name}: session_start settled`, () => spawnedProgram("ssh") || spawnedGitWith("--git-common-dir"));
		} finally {
			censusArmed = false;
		}
		check(
			`${shape.name}: isolated judgment`,
			shape.subagent && shape.expectIsolated ? spawnedProgram("ssh") : !spawnedProgram("ssh"),
			`spawns: ${spawns.map(record => record.program).join(",")}`,
		);
		console.log(`    ${shape.name}: getEntries=${harness.counts.getEntries} getChildren=${harness.counts.getChildren} getTree=${harness.counts.getTree}`);
		if (EXPECT_LIGHT) {
			check(
				`${shape.name}: judgment reads the entries once (host has no smaller entry)`,
				shape.subagent ? harness.counts.getEntries === 1 : harness.counts.getEntries === 0,
				`got ${harness.counts.getEntries}`,
			);
		}
	}
}

/** Row 4: `/worktree` host check and `session_start` branch decisions. */
async function hookSequences(registered: Registered, dirs: { repoMain: string; plain: string }): Promise<void> {
	// inside an opted-in project: checkHost runs (ssh spawn) → Komodo unreachable →
	// command refused with an error notification, before any move waiter is armed
	resetSpawns();
	censusArmed = true;
	const inside = makeCtx({ cwd: dirs.repoMain });
	const insideResult = (await call(registered, "input", { type: "input", text: "/worktree feature-branch", source: "interactive" }, inside.ctx)) as
		| { handled?: boolean }
		| undefined;
	censusArmed = false;
	check("/worktree in project: host check ran (ssh spawn)", spawnedProgram("ssh"), `spawns: ${spawns.map(record => record.program).join(",")}`);
	check("/worktree in project: command refused", insideResult?.handled === true, `result: ${JSON.stringify(insideResult)}`);
	check(
		"/worktree in project: refusal reported as an error",
		inside.notifications.some(note => note.level === "error"),
		`notifications: ${JSON.stringify(inside.notifications)}`,
	);

	// outside a project: no host check, no refusal, and the move waiter still runs
	// to completion (the simulated move resolves it on its first tick)
	resetSpawns();
	censusArmed = true;
	const outside = makeCtx({ cwd: dirs.plain, moveTo: dirs.repoMain });
	const outsideResult = (await call(registered, "input", { type: "input", text: "/worktree elsewhere", source: "interactive" }, outside.ctx)) as
		| { handled?: boolean }
		| undefined;
	const moved = await Promise.race([outside.movedSeen.then(() => true), Bun.sleep(OBSERVE_DEADLINE_MS).then(() => false)]);
	censusArmed = false;
	check("/worktree outside project: not refused", outsideResult?.handled !== true, `result: ${JSON.stringify(outsideResult)}`);
	check("/worktree outside project: no host check", !spawnedProgram("ssh"), `spawns: ${spawns.map(record => record.program).join(",")}`);
	check("/worktree outside project: move waiter observed the move", moved, "the waiter never reported a move");
	if (EXPECT_LIGHT) {
		check(
			"/worktree outside project: waiter spawned no child",
			spawns.length === 0,
			`spawns: ${spawns.map(record => `${record.program} ${record.args.slice(1).join(" ")}`).join(" | ")}`,
		);
	} else {
		console.log(`    waiter spawns (baseline): ${spawns.map(record => record.program).join(",") || "none"}`);
	}
}

// --- run ---------------------------------------------------------------------

async function main(): Promise<number> {
	const repoMain = join(fixtureRoot, "opted-main");
	initRepo(repoMain);
	writeConfig(repoMain);
	const nested = join(repoMain, "nested");
	initRepo(nested);
	writeConfig(nested);
	const plain = join(fixtureRoot, "plain");
	mkdirSync(plain, { recursive: true });
	const wt = join(fixtureRoot, "wt-one");
	git(repoMain, "worktree", "add", "-q", "-b", "branch-wt", wt);
	writeConfig(wt);
	const nonGit = join(fixtureRoot, "non-git");
	mkdirSync(nonGit, { recursive: true });
	const deadGitfile = join(fixtureRoot, "dead-gitfile");
	mkdirSync(deadGitfile, { recursive: true });
	writeFileSync(join(deadGitfile, ".git"), `gitdir: ${join(fixtureRoot, "vanished")}\n`);
	writeConfig(deadGitfile);
	const linkSrc = join(fixtureRoot, "link-src");
	initRepo(linkSrc);
	writeConfig(linkSrc);
	const linkDir = join(fixtureRoot, "link-dir");
	symlinkSync(linkSrc, linkDir, "dir");

	const registered = makePi();
	check(
		"plugin registers its hooks",
		registered.handlers.has("before_agent_start") && registered.handlers.has("session_start"),
		`handlers: ${[...registered.handlers.keys()].join(",")}`,
	);

	await scenario("per-turn census and active sets", () => perTurnCensus(registered, { repoMain, wt, plain, nested }));
	await scenario("edge matrix", () => edgeMatrix(registered, { nonGit, deadGitfile, linkDir, linkSrc }));
	await scenario("isolated judgment", () => isolatedJudgment(registered));
	await scenario("hook sequences", () => hookSequences(registered, { repoMain, plain }));

	if (failures.length !== 0) {
		console.error(`\n${failures.length} failure(s):`);
		for (const failure of failures) console.error(`  - ${failure}`);
		return 1;
	}
	console.log("\nall assertions passed");
	return 0;
}

let exitCode = 1;
try {
	exitCode = await main();
} finally {
	rmSync(fixtureRoot, { recursive: true, force: true });
	// Explicit exit: the plugin may hold timers (the /worktree waiter) that would
	// otherwise keep the process alive after the scenarios have finished.
	process.exit(exitCode);
}
