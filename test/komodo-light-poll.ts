/**
 * Acceptance harness for issue #22: `containerRunning` and `runOnce` status
 * polling must use the lightweight `GetDeploymentContainer` read instead of
 * parsing full `InspectDockerContainer` documents.
 *
 * Serves a local Komodo Core stub that records every request type and the
 * response bytes it sends, then drives the real `komodo.ts` exports through:
 *   1. `containerRunning` over running / exited / absent / not_deployed /
 *      paused / restarting / unknown states;
 *   2. `runOnce` polling running → exited, then exactly one inspect for the
 *      exit code, plus a runOnce whose container vanishes mid-run;
 *   3. `ensureContainer` request sequences (kept under test, must not change).
 *
 * Usage:
 *   EXPECT_LIGHT=0 bun test/komodo-light-poll.ts   # behavior + measurements only (baseline)
 *   bun test/komodo-light-poll.ts                  # additionally asserts the light path
 *
 * In baseline mode every status answer is served as a full `InspectDockerContainer`
 * document, matching the old implementation; in light mode the same answers go
 * through `GetDeploymentContainer` (with the one `unknown`-state inspect
 * fallback). Exits 0 when every assertion holds and always prints the request
 * sequence plus per-type response-byte totals so the same load can be compared
 * before and after the change.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBuildError } from "../src/diagnostics.ts";
import { containerRunning, ensureContainer, runOnce } from "../src/komodo.ts";
import type { ContainerSpec, HostConfig } from "../src/types.ts";

const EXPECT_LIGHT = process.env.EXPECT_LIGHT !== "0";

// --- komodo core stub -------------------------------------------------------

interface SeenRequest {
	readonly endpoint: string;
	readonly type: string;
	readonly bytes: number;
}

/** One entry per request, in order. `respond` builds the JSON payload. */
interface Expectation {
	readonly type: string;
	readonly check?: (params: Record<string, unknown>) => void;
	readonly respond: () => unknown;
}

const requests: SeenRequest[] = [];
let queue: Expectation[] = [];
const failures: string[] = [];

/** Marker: the expectation answers HTTP 500 with this top-level `error` message, like Core's missing-resource reply. */
const http500 = (message: string) => ({ __http500: message });

/** Resets the recorded requests and installs a new expectation queue. */
function scenario(name: string, expectations: Expectation[]): void {
	for (const left of queue) failures.push(`${name}: leftover expectation ${left.type}`);
	queue = expectations;
	requests.length = 0;
	console.log(`\n--- scenario ${name} ---`);
}

function finishScenario(name: string): void {
	const sequence = requests.map((request) => request.type).join(", ");
	const bytes = requests.reduce((total, request) => total + request.bytes, 0);
	const byType = new Map<string, { count: number; bytes: number }>();
	for (const request of requests) {
		const entry = byType.get(request.type) ?? { count: 0, bytes: 0 };
		entry.count += 1;
		entry.bytes += request.bytes;
		byType.set(request.type, entry);
	}
	console.log(`sequence: ${sequence}`);
	console.log(`total response bytes: ${bytes}`);
	for (const [type, entry] of byType) console.log(`  ${type}: ${entry.count} req, ${entry.bytes} B`);
	if (queue.length !== 0) {
		failures.push(`${name}: ${queue.length} expectations never used (${queue.map((entry) => entry.type).join(", ")})`);
	}
}

const DEPLOYMENT_ID = "507f1f77bcf86cd799439011";
const UPDATE_ID = "507f191e810c19729de860ea";

function deploymentDoc(name: string, overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		_id: { $oid: DEPLOYMENT_ID },
		name,
		config: {
			server_id: "server-oid-1",
			swarm_id: "",
			image: { type: "Image", params: { image: "img:test" } },
			command: "sleep infinity",
			volumes: "",
			environment: "",
			extra_args: [],
			restart: "unless-stopped",
			skip_secret_interp: true,
			...overrides,
		},
	};
}

/** A fat inspect document (~4 KiB) like a real `InspectDockerContainer` reply. */
function inspectDoc(running: boolean, status: string, exitCode: number): unknown {
	return {
		Id: "deadbeef".repeat(16),
		Name: "/rb-test-abcdef1234",
		State: {
			Status: status,
			Running: running,
			Paused: false,
			Restarting: false,
			OOMKilled: false,
			Dead: status === "dead",
			Pid: running ? 1234 : 0,
			ExitCode: exitCode,
			Error: "",
			StartedAt: "2026-11-07T10:00:00.000000000Z",
			FinishedAt: running ? "0001-01-01T00:00:00Z" : "2026-11-07T10:00:01.000000000Z",
		},
		Config: {
			Hostname: "rb-test", Env: ["PATH=/usr/bin"], Cmd: ["sleep", "infinity"],
			Image: "img:test", Labels: { "com.docker.compose.project": "rb", pad: "x".repeat(1024) },
		},
		Mounts: [{ Type: "bind", Source: "/srv/remote-build/test", Destination: "/workspace", pad: "y".repeat(1024) }],
		NetworkSettings: { IPAddress: "172.17.0.2", Ports: {}, Networks: { bridge: { pad: "z".repeat(1024) } } },
	};
}

/**
 * A status answer on whichever transport the build under test uses, as one or
 * more expectations. `exitCode` is embedded in the baseline's inspect document;
 * `inspected` supplies the inspect answer the light build falls back to for a
 * Core `unknown` state.
 */
function statusExpectations(state: string, exitCode = 0, inspected?: { readonly running: boolean; readonly status: string }): Expectation[] {
	if (EXPECT_LIGHT) {
		if (state === "absent") {
			return [{ type: "GetDeploymentContainer", respond: () => http500(`Did not find any Deployment matching rb-test-abcdef1234`) }];
		}
		const head: Expectation = { type: "GetDeploymentContainer", respond: () => ({ state }) };
		if (state === "unknown" && inspected !== undefined) {
			return [head, { type: "InspectDockerContainer", respond: () => inspectDoc(inspected.running, inspected.status, exitCode) }];
		}
		return [head];
	}
	if (state === "absent" || state === "not_deployed") {
		return [{ type: "InspectDockerContainer", respond: () => http500(`Error response from daemon: No such container: rb-test-abcdef1234`) }];
	}
	if (state === "unknown" && inspected !== undefined) {
		return [{ type: "InspectDockerContainer", respond: () => inspectDoc(inspected.running, inspected.status, exitCode) }];
	}
	return [{ type: "InspectDockerContainer", respond: () => inspectDoc(state === "running" || state === "paused" || state === "restarting", state, exitCode) }];
}

/** `GetDeploymentContainer` on paths that always used it (ensureContainer). */
function stateExpectation(state: string): Expectation {
	return { type: "GetDeploymentContainer", respond: () => ({ state }) };
}

const serverExpectation: Expectation = {
	type: "GetServer",
	respond: () => ({ _id: { $oid: "server-oid-1" } }),
};

const update = (status: "Queued" | "Complete") => ({ _id: { $oid: UPDATE_ID }, status, ...(status === "Complete" ? { success: true } : {}) });

const stub = Bun.serve({
	port: 0,
	fetch: async (req) => {
		const body = (await req.json()) as { type: string; params: Record<string, unknown> };
		const next = queue.shift();
		if (next === undefined || next.type !== body.type) {
			return Response.json({ error: `unexpected request ${body.type}`, trace: [`unexpected request ${body.type}`] }, { status: 500 });
		}
		next.check?.(body.params);
		const payload = next.respond();
		if (typeof payload === "object" && payload !== null && "__http500" in payload && typeof payload.__http500 === "string") {
			return Response.json({ error: payload.__http500, trace: [] }, { status: 500 });
		}
		const encoded = JSON.stringify(payload);
		requests.push({ endpoint: new URL(req.url).pathname, type: body.type, bytes: encoded.length });
		return new Response(encoded, { headers: { "Content-Type": "application/json" } });
	},
});

// --- host config ------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "rb-komodo-"));
const cliConfig = join(dir, "komodo.cli.toml");
writeFileSync(cliConfig, `[[profile]]\nname = "build"\nhost = "${stub.url.origin}"\nkey = "K-test"\nsecret = "S-test"\n`);

const host: HostConfig = {
	ssh: "build-host",
	remoteRoot: "/srv/remote-build",
	komodo: { profile: "build", server: "build-server", cliConfig },
	bin: { km: "km", mutagen: "mutagen" },
};

const spec: ContainerSpec = { name: "rb-test-abcdef1234", image: "img:test", workdir: null, mounts: [], env: {} };
const serviceSpec: ContainerSpec = { name: "rb-svc-abcdef1234", image: "img:test", workdir: null, mounts: [], env: {} };

function check(name: string, condition: boolean, detail: string): void {
	if (condition) console.log(`  ok: ${name}`);
	else {
		failures.push(`${name}: ${detail}`);
		console.log(`  FAIL: ${name}: ${detail}`);
	}
}

// --- scenario 1: containerRunning --------------------------------------------

async function scenarioRunning(): Promise<void> {
	scenario("containerRunning", [
		...statusExpectations("running"),
		...statusExpectations("exited", 7),
		...statusExpectations("absent"),
		...statusExpectations("not_deployed"),
		...statusExpectations("paused"),
		...statusExpectations("restarting"),
		...statusExpectations("unknown", 0, { running: true, status: "running" }),
	]);
	const answers: Record<string, boolean> = {};
	for (const state of ["running", "exited", "absent", "not_deployed", "paused", "restarting", "unknown"]) {
		answers[state] = await containerRunning(host, spec.name);
	}
	finishScenario("containerRunning");
	check("running=true", answers.running === true, `got ${answers.running}`);
	check("exited=false", answers.exited === false, `got ${answers.exited}`);
	check("absent=false", answers.absent === false, `got ${answers.absent}`);
	check("not_deployed=false", answers.not_deployed === false, `got ${answers.not_deployed}`);
	check("paused=true", answers.paused === true, `got ${answers.paused}`);
	check("restarting=true", answers.restarting === true, `got ${answers.restarting}`);
	check("unknown→running=true", answers.unknown === true, `got ${answers.unknown}`);
	const inspects = requests.filter((request) => request.type === "InspectDockerContainer").length;
	check("inspect count", inspects === (EXPECT_LIGHT ? 1 : 5), `got ${inspects}`);
}

// --- scenario 2: runOnce ------------------------------------------------------

function runOncePrologue(): Expectation[] {
	return [
		serverExpectation,
		{ type: "ListFullDeployments", respond: () => [] },
		{ type: "CreateDeployment", respond: () => deploymentDoc(spec.name, { restart: "no" }) },
		{ type: "Deploy", respond: () => update("Queued") },
		{ type: "GetUpdate", respond: () => update("Complete") },
	];
}

async function scenarioRunOnce(): Promise<void> {
	scenario("runOnce", [
		...runOncePrologue(),
		...statusExpectations("running"),
		...statusExpectations("running"),
		...statusExpectations("exited", 7),
		// the light implementation reads ExitCode from one final inspect
		...(EXPECT_LIGHT ? [{ type: "InspectDockerContainer", respond: () => inspectDoc(false, "exited", 7) } satisfies Expectation] : []),
		{
			type: "GetContainerLog",
			check: (params) => {
				if (params.container !== spec.name || params.tail !== 300 || params.timestamps !== false) {
					failures.push(`GetContainerLog params changed: ${JSON.stringify(params)}`);
				}
			},
			respond: () => ({ stdout: "build output\n", stderr: "warn: deprecated\n" }),
		},
	]);

	const result = await runOnce(host, spec, { entrypoint: "echo", argv: ["hi"] }, { timeoutMs: 60_000 });
	finishScenario("runOnce");
	check("exitCode=7", result.exitCode === 7, `got ${result.exitCode}`);
	check("output", result.output === "build output\n[stderr]\nwarn: deprecated", `got ${JSON.stringify(result.output)}`);
	const inspectCount = requests.filter((request) => request.type === "InspectDockerContainer").length;
	const statePolls = requests.filter((request) => request.type === "GetDeploymentContainer").length;
	if (EXPECT_LIGHT) {
		check("exactly one inspect", inspectCount === 1, `got ${inspectCount}`);
		check("three state polls", statePolls === 3, `got ${statePolls}`);
	}
}

async function scenarioRunOnceGone(): Promise<void> {
	scenario("runOnce/disappeared", [
		...runOncePrologue(),
		...statusExpectations("running"),
		...statusExpectations("not_deployed"),
	]);

	let thrown: unknown;
	try {
		await runOnce(host, spec, { entrypoint: "echo", argv: ["hi"] }, { timeoutMs: 60_000 });
	} catch (error) {
		thrown = error;
	}
	finishScenario("runOnce/disappeared");
	check("threw", thrown !== undefined, "no error");
	check("container-disappeared", thrown instanceof RemoteBuildError && thrown.diagnostic.kind === "container-disappeared",
		thrown instanceof Error ? thrown.message : String(thrown));
	check("no log read", !requests.some((request) => request.type === "GetContainerLog"), "log requested");
}

// --- scenario 3: ensureContainer sequences ------------------------------------

async function scenarioEnsure(): Promise<void> {
	const matched = deploymentDoc(serviceSpec.name, {});

	// A: existing config matches and the container is running → early return.
	scenario("ensure/matched+running", [
		serverExpectation,
		{ type: "ListFullDeployments", respond: () => [matched] },
		stateExpectation("running"),
	]);
	await ensureContainer(host, serviceSpec, "ensure");
	finishScenario("ensure/matched+running");
	check("no Deploy", !requests.some((request) => request.type === "Deploy"), "deploy issued");

	// B: existing config matches but the container is not running → deploy.
	scenario("ensure/matched+created", [
		serverExpectation,
		{ type: "ListFullDeployments", respond: () => [matched] },
		stateExpectation("created"),
		{ type: "Deploy", respond: () => update("Queued") },
		{ type: "GetUpdate", respond: () => update("Complete") },
		stateExpectation("running"),
	]);
	await ensureContainer(host, serviceSpec, "ensure");
	finishScenario("ensure/matched+created");
	check("deploy issued", requests.some((request) => request.type === "Deploy"), "no deploy");

	// C: no existing deployment → create + deploy.
	scenario("ensure/fresh", [
		serverExpectation,
		{ type: "ListFullDeployments", respond: () => [] },
		{ type: "CreateDeployment", respond: () => deploymentDoc(serviceSpec.name, {}) },
		{ type: "Deploy", respond: () => update("Queued") },
		{ type: "GetUpdate", respond: () => update("Complete") },
		stateExpectation("running"),
	]);
	await ensureContainer(host, serviceSpec, "ensure");
	finishScenario("ensure/fresh");
	check("create issued", requests.some((request) => request.type === "CreateDeployment"), "no create");
}

// --- run ----------------------------------------------------------------------

async function main(): Promise<void> {
	try {
		await scenarioRunning();
		await scenarioRunOnce();
		await scenarioRunOnceGone();
		await scenarioEnsure();
	} finally {
		stub.stop();
		rmSync(dir, { recursive: true, force: true });
	}
	if (failures.length !== 0) {
		console.error(`\n${failures.length} failure(s):`);
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exit(1);
	}
	console.log("\nall assertions passed");
}

await main();

export {};
