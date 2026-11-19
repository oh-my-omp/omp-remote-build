import { RemoteBuildError } from "./diagnostics.ts";
import type { ContainerSpec, HostConfig, ImageBuildSpec, OnceResult } from "./types.ts";

interface Endpoint {
	readonly host: string;
	readonly key: string;
	readonly secret: string;
}

interface ManagedConfig {
	readonly server_id: string;
	readonly swarm_id: string;
	readonly image: { readonly type: "Image"; readonly params: { readonly image: string } };
	readonly command: string;
	readonly volumes: string;
	readonly environment: string;
	readonly extra_args: readonly string[];
	readonly restart: "unless-stopped" | "no";
	readonly skip_secret_interp: true;
}

interface Deployment {
	readonly id: string;
	readonly name: string;
	readonly config: {
		readonly server: string;
		readonly swarm: string;
		readonly image: string | null;
		readonly command: string;
		readonly volumes: string;
		readonly environment: string;
		readonly extraArgs: readonly string[];
		readonly restart: string;
		readonly skipSecretInterp: boolean;
	};
}

type Request =
	| { readonly endpoint: "read"; readonly type: "ListServers"; readonly params: Record<string, never> }
	| { readonly endpoint: "read"; readonly type: "GetServer"; readonly params: { readonly server: string } }
	| {
			readonly endpoint: "read";
			readonly type: "ListFullDeployments";
			readonly params: { readonly query: { readonly names: readonly string[] } };
	  }
	| { readonly endpoint: "read"; readonly type: "GetDeploymentContainer"; readonly params: { readonly deployment: string } }
	| { readonly endpoint: "read"; readonly type: "GetUpdate"; readonly params: { readonly id: string } }
	| { readonly endpoint: "read"; readonly type: "InspectDockerImage"; readonly params: { readonly server: string; readonly image: string } }
	| {
			readonly endpoint: "read";
			readonly type: "InspectDockerContainer";
			readonly params: { readonly server: string; readonly container: string };
	  }
	| {
			readonly endpoint: "read";
			readonly type: "GetContainerLog";
			readonly params: { readonly server: string; readonly container: string; readonly tail: number; readonly timestamps: false };
	  }
	| {
			readonly endpoint: "write";
			readonly type: "CreateDeployment";
			readonly params: { readonly name: string; readonly config: ManagedConfig };
	  }
	| {
			readonly endpoint: "write";
			readonly type: "UpdateDeployment";
			readonly params: { readonly id: string; readonly config: ManagedConfig };
	  }
	| {
			readonly endpoint: "execute";
			readonly type: "Deploy";
			readonly params: { readonly deployment: string; readonly stop_signal: null; readonly stop_time: null };
	  };

type Update =
	| { readonly id: string; readonly status: "Queued" | "InProgress" }
	| { readonly id: string; readonly status: "Complete"; readonly success: boolean };

type ContainerProcess =
	| { readonly kind: "service" }
	| { readonly kind: "once"; readonly entrypoint: string | null; readonly argv: readonly string[] };

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RemoteBuildError({ kind: "komodo-shape", field, expected: "object" });
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
	if (typeof value !== "string") throw new RemoteBuildError({ kind: "komodo-shape", field, expected: "string" });
	return value;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new RemoteBuildError({ kind: "komodo-shape", field, expected: "boolean" });
	return value;
}

function number(value: unknown, field: string): number {
	if (typeof value !== "number") throw new RemoteBuildError({ kind: "komodo-shape", field, expected: "number" });
	return value;
}

function array(value: unknown, field: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new RemoteBuildError({ kind: "komodo-shape", field, expected: "array" });
	return value;
}

function mongoId(value: unknown): string {
	return string(record(record(value, "resource")._id, "_id").$oid, "_id.$oid");
}

async function loadEndpoint(host: HostConfig): Promise<Endpoint> {
	const path = host.komodo.cliConfig;
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(await Bun.file(path).text());
	} catch {
		// TOML diagnostics may contain the original line, including a credential.
		throw new RemoteBuildError({ kind: "km-config-read", path });
	}
	const profiles = array(record(parsed, "km CLI config").profile ?? [], "km CLI config [[profile]]").map((entry) =>
		record(entry, "[[profile]]"),
	);
	const fields = profiles.find(
		(entry) => entry.name === host.komodo.profile || (Array.isArray(entry.aliases) && entry.aliases.includes(host.komodo.profile)),
	);
	if (fields === undefined) throw new RemoteBuildError({ kind: "km-profile-missing", path, profile: host.komodo.profile });
	const required = (name: "host" | "key" | "secret"): string => {
		const value = fields[name];
		if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
			throw new RemoteBuildError({ kind: "km-profile-field", profile: host.komodo.profile, field: name });
		}
		return value;
	};
	const url = required("host");
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new RemoteBuildError({ kind: "km-profile-url", profile: host.komodo.profile, reason: "url" });
	}
	if (
		(parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
		parsedUrl.username ||
		parsedUrl.password ||
		parsedUrl.search ||
		parsedUrl.hash
	) {
		throw new RemoteBuildError({ kind: "km-profile-url", profile: host.komodo.profile, reason: "components" });
	}
	return { host: url.replace(/\/+$/, ""), key: required("key"), secret: required("secret") };
}

async function send(endpoint: Endpoint, operation: Request): Promise<Response> {
	try {
		return await fetch(`${endpoint.host}/${operation.endpoint}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": endpoint.key, "x-api-secret": endpoint.secret },
			body: JSON.stringify({ type: operation.type, params: operation.params }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		throw new RemoteBuildError({ kind: "komodo-network", operation: operation.type, host: endpoint.host });
	}
}

function failure(operation: Request, response: Response): Error {
	return new RemoteBuildError({ kind: "komodo-http", operation: operation.type, status: response.status });
}

async function json(operation: Request, response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new RemoteBuildError({ kind: "komodo-json", operation: operation.type });
	}
}

async function request(endpoint: Endpoint, operation: Request): Promise<unknown> {
	const response = await send(endpoint, operation);
	if (!response.ok) {
		// Error bodies and execution logs may echo environment values; never expose them.
		await response.body?.cancel();
		throw failure(operation, response);
	}
	return json(operation, response);
}

async function requestOrAbsent(endpoint: Endpoint, operation: Request, absent: RegExp): Promise<unknown | undefined> {
	const response = await send(endpoint, operation);
	if (response.ok) return json(operation, response);
	if (response.status === 500) {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			body = undefined;
		}
		if (typeof body === "object" && body !== null) {
			if ("error" in body && typeof body.error === "string" && absent.test(body.error)) return undefined;
			if ("trace" in body && Array.isArray(body.trace) && body.trace.some((entry) => typeof entry === "string" && absent.test(entry)))
				return undefined;
		}
		throw failure(operation, response);
	}
	await response.body?.cancel();
	throw failure(operation, response);
}

function parseDeployment(value: unknown): Deployment {
	const resource = record(value, "Deployment");
	const config = record(resource.config, "Deployment.config");
	const image = record(config.image, "Deployment.config.image");
	let imageName: string | null;
	switch (image.type) {
		case "Image":
			imageName = string(record(image.params, "image.params").image, "image.params.image");
			break;
		case "Build":
			imageName = null;
			break;
		default:
			throw new RemoteBuildError({ kind: "komodo-variant", variant: "image" });
	}
	return {
		id: mongoId(resource),
		name: string(resource.name, "Deployment.name"),
		config: {
			server: string(config.server_id, "server_id"),
			swarm: string(config.swarm_id, "swarm_id"),
			image: imageName,
			command: string(config.command, "command"),
			volumes: string(config.volumes, "volumes"),
			environment: string(config.environment, "environment"),
			extraArgs: array(config.extra_args, "extra_args").map((arg) => string(arg, "extra_args entry")),
			restart: string(config.restart, "restart"),
			skipSecretInterp: boolean(config.skip_secret_interp, "skip_secret_interp"),
		},
	};
}

function parseUpdate(value: unknown): Update {
	const update = record(value, "Update");
	const id = mongoId(update);
	switch (update.status) {
		case "Queued":
		case "InProgress":
			return { id, status: update.status };
		case "Complete":
			return { id, status: "Complete", success: boolean(update.success, "Update.success") };
		default:
			throw new RemoteBuildError({ kind: "komodo-variant", variant: "update" });
	}
}

function shellWord(value: string): string {
	if (/[\r\n\0]/.test(value) || value.includes(" #")) {
		throw new RemoteBuildError({ kind: "komodo-value", reason: "shell" });
	}
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandWord(value: string): string {
	if (/[\r\n\0]/.test(value)) throw new RemoteBuildError({ kind: "komodo-value", reason: "command" });
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function managedConfig(spec: ContainerSpec, process: ContainerProcess, server: string): ManagedConfig {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(spec.name)) throw new RemoteBuildError({ kind: "komodo-value", reason: "name" });
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]*$/.test(spec.image)) throw new RemoteBuildError({ kind: "komodo-value", reason: "image" });
	if (spec.workdir !== null && !spec.workdir.startsWith("/")) throw new RemoteBuildError({ kind: "komodo-value", reason: "workdir" });
	const volumes = spec.mounts.map((mount) => {
		const separator = mount.indexOf(":");
		if (separator <= 0 || separator === mount.length - 1 || mount.slice(0, separator).includes("=")) {
			throw new RemoteBuildError({ kind: "komodo-value", reason: "volume" });
		}
		return `${shellWord(mount.slice(0, separator))}:${shellWord(mount.slice(separator + 1))}`;
	});
	const environment = Object.keys(spec.env)
		.sort()
		.map((name) => {
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new RemoteBuildError({ kind: "komodo-value", reason: "env" });
			return `${name}=${shellWord(spec.env[name]!)}`;
		})
		.join("\n");
	const extraArgs = spec.workdir === null ? [] : ["--workdir", shellWord(spec.workdir)];
	if (process.kind === "once" && process.entrypoint !== null) extraArgs.push("--entrypoint", shellWord(process.entrypoint));
	return {
		server_id: server,
		swarm_id: "",
		image: { type: "Image", params: { image: spec.image } },
		command: process.kind === "service" ? "sleep infinity" : process.argv.map(commandWord).join(" "),
		volumes: volumes.length === 0 ? "" : `${volumes.join("\n")}\n`,
		environment: environment ? `${environment}\n` : "",
		extra_args: extraArgs,
		restart: process.kind === "service" ? "unless-stopped" : "no",
		skip_secret_interp: true,
	};
}

function matches(current: Deployment["config"], desired: ManagedConfig): boolean {
	return (
		current.server === desired.server_id &&
		current.swarm === desired.swarm_id &&
		current.image === desired.image.params.image &&
		current.command === desired.command &&
		current.volumes === desired.volumes &&
		current.environment === desired.environment &&
		current.restart === desired.restart &&
		current.skipSecretInterp === desired.skip_secret_interp &&
		current.extraArgs.length === desired.extra_args.length &&
		current.extraArgs.every((arg, index) => arg === desired.extra_args[index])
	);
}

async function containerState(endpoint: Endpoint, deployment: string): Promise<string> {
	const response = record(
		await request(endpoint, { endpoint: "read", type: "GetDeploymentContainer", params: { deployment } }),
		"GetDeploymentContainer",
	);
	return string(response.state, "GetDeploymentContainer.state");
}

async function containerStateOrAbsent(endpoint: Endpoint, deployment: string): Promise<string | undefined> {
	const response = await requestOrAbsent(
		endpoint,
		{
			endpoint: "read",
			type: "GetDeploymentContainer",
			params: { deployment },
		},
		/Did not find any Deployment matching/,
	);
	return response === undefined ? undefined : string(record(response, "GetDeploymentContainer").state, "GetDeploymentContainer.state");
}

async function deploy(endpoint: Endpoint, deployment: string): Promise<void> {
	let update = parseUpdate(
		await request(endpoint, {
			endpoint: "execute",
			type: "Deploy",
			params: { deployment, stop_signal: null, stop_time: null },
		}),
	);
	const deadline = Date.now() + 10 * 60_000;
	while (update.status !== "Complete") {
		if (Date.now() >= deadline) throw new RemoteBuildError({ kind: "deployment-timeout", deployment, update: update.id });
		await Bun.sleep(1_000);
		update = parseUpdate(await request(endpoint, { endpoint: "read", type: "GetUpdate", params: { id: update.id } }));
	}
	if (!update.success) throw new RemoteBuildError({ kind: "deployment-failed", deployment, update: update.id });
}

async function waitRunning(endpoint: Endpoint, deployment: string): Promise<void> {
	const runningDeadline = Date.now() + 60_000;
	let state = await containerState(endpoint, deployment);
	while (state !== "running") {
		if (Date.now() >= runningDeadline) throw new RemoteBuildError({ kind: "deployment-not-running", deployment, state });
		await Bun.sleep(1_000);
		state = await containerState(endpoint, deployment);
	}
}

async function upsertDeployment(
	endpoint: Endpoint,
	host: HostConfig,
	spec: ContainerSpec,
	process: ContainerProcess,
): Promise<{ deployment: Deployment; fresh: boolean }> {
	const server = await request(endpoint, { endpoint: "read", type: "GetServer", params: { server: host.komodo.server } });
	const desired = managedConfig(spec, process, mongoId(server));
	const resources = array(
		await request(endpoint, {
			endpoint: "read",
			type: "ListFullDeployments",
			params: { query: { names: [spec.name] } },
		}),
		"ListFullDeployments",
	).map(parseDeployment);
	const existing = resources.find((deployment) => deployment.name === spec.name);
	if (existing === undefined) {
		return {
			deployment: parseDeployment(
				await request(endpoint, { endpoint: "write", type: "CreateDeployment", params: { name: spec.name, config: desired } }),
			),
			fresh: true,
		};
	}
	if (matches(existing.config, desired)) return { deployment: existing, fresh: false };
	return {
		deployment: parseDeployment(
			await request(endpoint, { endpoint: "write", type: "UpdateDeployment", params: { id: existing.id, config: desired } }),
		),
		fresh: true,
	};
}

export async function ensureContainer(host: HostConfig, spec: ContainerSpec, mode: "ensure" | "redeploy"): Promise<void> {
	const endpoint = await loadEndpoint(host);
	const { deployment, fresh } = await upsertDeployment(endpoint, host, spec, { kind: "service" });
	if (mode === "ensure" && !fresh && (await containerState(endpoint, deployment.id)) === "running") return;
	await deploy(endpoint, deployment.id);
	await waitRunning(endpoint, deployment.id);
}

async function inspectContainer(endpoint: Endpoint, host: HostConfig, container: string): Promise<Record<string, unknown> | undefined> {
	const response = await requestOrAbsent(
		endpoint,
		{
			endpoint: "read",
			type: "InspectDockerContainer",
			params: { server: host.komodo.server, container },
		},
		/No such container/,
	);
	return response === undefined ? undefined : record(record(response, "InspectDockerContainer").State, "State");
}

export async function runOnce(
	host: HostConfig,
	spec: ContainerSpec,
	command: { readonly entrypoint: string | null; readonly argv: readonly string[] },
	options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<OnceResult> {
	const endpoint = await loadEndpoint(host);
	const { deployment } = await upsertDeployment(endpoint, host, spec, { kind: "once", ...command });
	await deploy(endpoint, deployment.id);
	const deadline = Date.now() + options.timeoutMs;
	let exitState: Record<string, unknown> | undefined;
	for (;;) {
		if (options.signal?.aborted) throw new RemoteBuildError({ kind: "container-aborted", name: spec.name });
		const state = await containerStateOrAbsent(endpoint, deployment.id);
		if (state === undefined || state === "not_deployed") throw new RemoteBuildError({ kind: "container-disappeared", name: spec.name });
		let status = state;
		if (status === "unknown") {
			const inspected = await inspectContainer(endpoint, host, spec.name);
			if (inspected === undefined) throw new RemoteBuildError({ kind: "container-disappeared", name: spec.name });
			status = string(inspected.Status, "State.Status");
			if (status === "exited" || status === "dead") exitState = inspected;
		}
		if (status === "exited" || status === "dead") break;
		if (Date.now() >= deadline)
			throw new RemoteBuildError({ kind: "container-timeout", name: spec.name, minutes: Math.round(options.timeoutMs / 60_000) });
		await Bun.sleep(2_000);
	}
	const state = exitState ?? (await inspectContainer(endpoint, host, spec.name));
	if (state === undefined) throw new RemoteBuildError({ kind: "container-disappeared", name: spec.name });
	const log = record(
		await request(endpoint, {
			endpoint: "read",
			type: "GetContainerLog",
			params: { server: host.komodo.server, container: spec.name, tail: 300, timestamps: false },
		}),
		"GetContainerLog",
	);
	const stdout = string(log.stdout, "GetContainerLog.stdout");
	const stderr = string(log.stderr, "GetContainerLog.stderr");
	return {
		exitCode: number(state.ExitCode, "State.ExitCode"),
		output: [stdout.trimEnd(), stderr && `[stderr]\n${stderr.trimEnd()}`].filter((part) => part !== "").join("\n"),
	};
}

export async function buildImage(
	host: HostConfig,
	spec: ImageBuildSpec,
	options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<OnceResult> {
	return runOnce(
		host,
		{
			name: spec.name,
			image: "docker:cli",
			workdir: null,
			mounts: ["/var/run/docker.sock:/var/run/docker.sock", `${spec.contextPath}:/ctx:ro`],
			env: {},
		},
		{
			entrypoint: "docker",
			argv: ["build", "--progress=plain", "--tag", spec.image, "--file", `/ctx/${spec.dockerfile}`, "/ctx"],
		},
		options,
	);
}

export async function imageExists(host: HostConfig, image: string): Promise<boolean> {
	const endpoint = await loadEndpoint(host);
	const response = await requestOrAbsent(
		endpoint,
		{
			endpoint: "read",
			type: "InspectDockerImage",
			params: { server: host.komodo.server, image },
		},
		/No such image/,
	);
	return response !== undefined;
}

export async function containerRunning(host: HostConfig, name: string): Promise<boolean> {
	const endpoint = await loadEndpoint(host);
	const state = await containerStateOrAbsent(endpoint, name);
	if (state === undefined || state === "not_deployed") return false;
	if (state === "unknown") {
		const inspected = await inspectContainer(endpoint, host, name);
		return inspected !== undefined && boolean(inspected.Running, "State.Running");
	}
	return state === "running" || state === "paused" || state === "restarting" || state === "stopping" || state === "removing";
}

export function execArgv(host: HostConfig, container: string, shell: string): string[] {
	return [host.bin.km, "-c", host.komodo.cliConfig, "-p", host.komodo.profile, "exec", "--server", host.komodo.server, container, shell];
}

export async function komodoReachable(host: HostConfig): Promise<void> {
	const endpoint = await loadEndpoint(host);
	array(await request(endpoint, { endpoint: "read", type: "ListServers", params: {} }), "ListServers");
}
