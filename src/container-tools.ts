import { z } from "@oh-my-pi/omptype/zod";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	type InternalWriteResult,
	type ProtocolHandler,
	type ResolveContext,
	type SchemeSpec,
	type WriteContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@oh-my-pi/pi-coding-agent/tools/streaming-output";
import type { CollectResult } from "omp-actual-terminal/src/collect.ts";
import { waitForExitOrDeadline } from "omp-actual-terminal/src/long-wait.ts";
import { sanitizeOutputText } from "omp-actual-terminal/src/output-safety.ts";
import { requireBunRuntime } from "omp-actual-terminal/src/pty.ts";
import { ExecSession } from "omp-actual-terminal/src/session.ts";
import { SessionStore } from "omp-actual-terminal/src/session-store.ts";
import { tr } from "../omomp-shared/i18n.ts";
import { registerInternalScheme } from "../omomp-shared/internal-url.ts";
import { containerRunning, execTransport } from "./komodo.ts";
import { TOOL_DESCRIPTIONS } from "./tool-docs.ts";
import type { PreparedEnv } from "./types.ts";

const EXIT_NOTE =
	"km always exits 0; this is only the local transport's exit code. Read command exit codes from the container shell output, e.g. echo $? immediately after the command.";
const encoder = new TextEncoder();
const ctermHandlerBrand = Symbol.for("omp-remote-build.cterm-handler");

const SPECIAL_KEYS = ["ctrl-c", "ctrl-d", "ctrl-z", "esc", "tab", "up", "down", "left", "right", "backspace", "delete"] as const;

type SpecialKey = (typeof SPECIAL_KEYS)[number];

const SPECIAL_KEY_BYTES: Readonly<Record<SpecialKey, string>> = {
	"ctrl-c": "\x03",
	"ctrl-d": "\x04",
	"ctrl-z": "\x1a",
	esc: "\x1b",
	tab: "\t",
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	backspace: "\x7f",
	delete: "\x1b[3~",
};

const yieldSchema = z
	.number()
	.int()
	.min(250)
	.max(30_000)
	.optional()
	.describe("Attachment window in milliseconds, not a command timeout; 250–30000.");
const sessionIdSchema = z.number().int().positive().describe("Session ID returned by container_exec, scoped to the current environment.");
const execSchema = z.object({
	input: z.string().optional().describe("Optional initial shell input written verbatim (include trailing newline to execute)."),
	yield_time_ms: yieldSchema,
});
const writeSchema = z.object({
	session_id: sessionIdSchema,
	text: z
		.string()
		.optional()
		.describe("Verbatim UTF-8 text to write to stdin (no backslash escaping). Mutually exclusive with raw_base64."),
	enter: z
		.boolean()
		.optional()
		.describe("Append Enter (\\r) after text/special_key, or send Enter alone. Mutually exclusive with raw_base64."),
	special_key: z
		.enum(SPECIAL_KEYS)
		.optional()
		.describe(
			"Control or navigation key (ctrl-c, ctrl-d, ctrl-z, esc, tab, up, down, left, right, backspace, delete). Mutually exclusive with raw_base64.",
		),
	raw_base64: z.string().optional().describe("Raw bytes encoded as base64. Mutually exclusive with text, enter, and special_key."),
	yield_time_ms: yieldSchema,
});

type TransportState =
	| { readonly status: "running" }
	| { readonly status: "exited"; readonly km_exit_code: number | null; readonly signal: NodeJS.Signals | null };

interface SessionDetails {
	readonly session_id: number;
	readonly transport: TransportState;
	readonly output: string;
	readonly log_path: string;
	readonly cwd: string;
	readonly command: string;
	readonly output_bytes_total: number;
	readonly omitted_bytes: number;
	readonly truncated: boolean;
	readonly failure_message: string | null;
	readonly note: string;
}

function transportState(session: ExecSession): TransportState {
	return session.hasExited ? { status: "exited", km_exit_code: session.exitCode, signal: session.signal } : { status: "running" };
}

interface Observed {
	readonly text: string;
	readonly omittedBytes: number;
	readonly screen: "changed" | "unchanged";
	readonly historyMayBeTruncated: boolean;
}

function observed(collected: CollectResult): Observed {
	switch (collected.kind) {
		case "none":
			return { text: "", omittedBytes: 0, screen: "changed", historyMayBeTruncated: false };
		case "screen": {
			const observation = collected.observation;
			return observation.kind === "rendered"
				? { text: observation.text, omittedBytes: 0, screen: "changed", historyMayBeTruncated: observation.historyMayBeTruncated }
				: { text: "", omittedBytes: 0, screen: "unchanged", historyMayBeTruncated: false };
		}
		case "final-screen":
			return {
				text: collected.projection.screenLines.join("\n"),
				omittedBytes: 0,
				screen: "changed",
				historyMayBeTruncated: collected.projection.historyMayBeTruncated,
			};
	}
	return assertNever(collected);
}

function assertNever(value: never): never {
	throw new Error(`Unexpected collection result: ${String(value)}`);
}

function sessionNumber(session: ExecSession): number {
	return Number(session.id);
}

function liveObserved(session: ExecSession): Observed {
	return { text: session.liveSnapshot()?.text ?? "", omittedBytes: 0, screen: "changed", historyMayBeTruncated: false };
}

function sessionResult(session: ExecSession, seen: Observed): AgentToolResult<SessionDetails> {
	const truncated = truncateTail(sanitizeOutputText(seen.text), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const details: SessionDetails = {
		session_id: sessionNumber(session),
		transport: transportState(session),
		output: truncated.content,
		log_path: session.logPath,
		cwd: session.cwd,
		command: sanitizeOutputText(session.displayCommand),
		output_bytes_total: session.totalBytesSeen,
		omitted_bytes: seen.omittedBytes,
		truncated: truncated.truncated === true,
		failure_message: session.failureMessage,
		note: EXIT_NOTE,
	};
	const lines = [`[${details.transport.status}] session_id: ${session.id}`, `log_path: ${session.logPath}`, `note: ${EXIT_NOTE}`];
	if (details.transport.status === "exited") {
		lines.push(`km_exit_code: ${details.transport.km_exit_code}`, `signal: ${details.transport.signal ?? "none"}`);
	}
	if (session.failureMessage) lines.push(`failure: ${sanitizeOutputText(session.failureMessage)}`);
	if (seen.historyMayBeTruncated) lines.push(`history: older scrolled-off lines are only in ${session.logPath}`);
	lines.push("---", details.output || (seen.screen === "unchanged" ? "(screen unchanged since the last call)" : "(no output)"));
	if (truncated.truncated)
		lines.push(`\n[Output truncated to the last ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes. Full output: ${session.logPath}]`);
	return { content: [{ type: "text", text: lines.join("\n") }], details };
}

function streamScreen(session: ExecSession, onUpdate: AgentToolUpdateCallback<SessionDetails>): { stop(): void } {
	let lastEmitAt = 0;
	let timer: NodeJS.Timeout | undefined;
	const emit = () => {
		lastEmitAt = Date.now();
		try {
			onUpdate(sessionResult(session, liveObserved(session)));
		} catch {
			// A transient UI update failure must not interrupt the session.
		}
	};
	const unsubscribe = session.onScreenChange(() => {
		if (timer !== undefined) return;
		const remaining = 250 - (Date.now() - lastEmitAt);
		if (remaining <= 0) {
			emit();
		} else {
			timer = setTimeout(() => {
				timer = undefined;
				emit();
			}, remaining);
		}
	});
	return {
		stop() {
			unsubscribe();
			clearTimeout(timer);
		},
	};
}

async function collectSession(
	session: ExecSession,
	yieldMs: number,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SessionDetails> | undefined,
	store: SessionStore,
): Promise<AgentToolResult<SessionDetails>> {
	session.touch();
	const stream = onUpdate ? streamScreen(session, onUpdate) : undefined;
	try {
		const result = sessionResult(session, observed(await session.collect({ deadlineMs: Date.now() + yieldMs, externalAbort: signal })));
		if (session.hasExited && session.outputClosed.isClosed) store.remove(session.id);
		return result;
	} finally {
		stream?.stop();
	}
}

function resolveWriteBytes(params: z.infer<typeof writeSchema>): Uint8Array | undefined {
	const hasText = typeof params.text === "string" && params.text.length > 0;
	const hasEnter = params.enter === true;
	const hasSpecialKey = params.special_key !== undefined;
	const hasB64 = typeof params.raw_base64 === "string" && params.raw_base64.length > 0;
	if (hasB64 && (hasText || hasEnter || hasSpecialKey)) {
		throw new Error("container_write_stdin: `raw_base64` cannot be combined with `text`, `enter`, or `special_key`.");
	}
	if (hasB64) {
		const b64 = params.raw_base64!.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("container_write_stdin: `raw_base64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	const combined =
		(params.text ?? "") + (params.special_key !== undefined ? SPECIAL_KEY_BYTES[params.special_key] : "") + (hasEnter ? "\r" : "");
	return combined.length > 0 ? encoder.encode(combined) : undefined;
}

function sendRawBytes(session: ExecSession, bytes: Uint8Array | undefined): void {
	if (bytes && bytes.length > 0 && !session.write(bytes)) {
		throw new Error(`Container session ${session.id} stdin is closed; omit input to read its final output.`);
	}
}

async function terminateSession(session: ExecSession, mode: "graceful" | "immediate"): Promise<void> {
	switch (mode) {
		case "graceful":
			session.terminate();
			await waitForExitOrDeadline({ exited: session.exited, durationMs: 2_000 });
			if (!session.hasExited) session.kill("SIGKILL");
			break;
		case "immediate":
			session.kill("SIGKILL");
			break;
	}
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 500 });
	if (!session.hasExited)
		throw new Error(
			`Container session ${session.id} km client is still running after SIGKILL; the session remains available for another kill attempt.`,
		);
}

function registerContainerUrls(
	store: SessionStore,
	ensureEnv: (cwd: string) => Promise<PreparedEnv>,
	getSession: (id: number, env: PreparedEnv) => ExecSession,
): void {
	const router = InternalUrlRouter.instance();
	const resolveCwd = (context?: ResolveContext | WriteContext): string => {
		const cwd = context?.cwd ?? context?.session?.cwd;
		if (!cwd) throw new Error("cterm:// requires a working directory (context.cwd).");
		return cwd;
	};
	const spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
		write: {
			via: "handler",
			payload: "verbatim",
			scope: "workspace",
			tier: () => "exec",
			cancels: (url) => (url.rawPathname ?? url.pathname).endsWith("/kill"),
		},
	};
	const handler: ProtocolHandler & { readonly [ctermHandlerBrand]: true } = {
		[ctermHandlerBrand]: true,
		scheme: "cterm",
		spec,
		async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
			const host = url.rawHost || url.hostname;
			const path = url.rawPathname ?? url.pathname;
			if (!host) {
				if (path !== "" && path !== "/") {
					throw new Error(`Invalid cterm:// URL: ${url.href}. Use cterm:// or cterm://<id>.`);
				}
				const env = await ensureEnv(resolveCwd(context));
				const sessions = store
					.values()
					.filter((session) => session.cwd === env.root)
					.map((session) => ({
						session_id: sessionNumber(session),
						url: `cterm://${session.id}`,
						transport: transportState(session),
						command: sanitizeOutputText(session.displayCommand),
						cwd: session.cwd,
						log_path: session.logPath,
						started_at_ms: session.startedAt,
						failure_message: session.failureMessage,
					}));
				return {
					url: url.href,
					content: `${JSON.stringify(sessions, null, 2)}\n${EXIT_NOTE}`,
					contentType: "text/plain",
					immutable: true,
					isDirectory: true,
				};
			}
			if (path === "/kill") {
				throw new Error(
					`cterm://${host}/kill is write-only; reading it did not stop anything. Call write with ${JSON.stringify({ path: `cterm://${host}/kill`, content: "" })} to terminate, or read cterm://${host} for output.`,
				);
			}
			if (path !== "" && path !== "/") {
				throw new Error(`Invalid cterm:// URL: ${url.href}. Use cterm://, cterm://<id>, or write cterm://<id>/kill.`);
			}
			if (!/^\d+$/.test(host)) {
				throw new Error(`Invalid container session id: ${host}`);
			}
			const env = await ensureEnv(resolveCwd(context));
			const session = getSession(Number(host), env);
			const result = await collectSession(session, 50, context?.signal, undefined, store);
			const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			return { url: url.href, content: text, contentType: "text/plain", immutable: true };
		},
		async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
			const host = url.rawHost || url.hostname;
			const path = url.rawPathname ?? url.pathname;
			if (!host) {
				throw new Error("cterm:// is read-only; write to cterm://<id> or cterm://<id>/kill.");
			}
			if (!/^\d+$/.test(host)) {
				throw new Error(`Invalid container session id: ${host}`);
			}
			const id = Number(host);
			if (path === "" || path === "/") {
				const env = await ensureEnv(resolveCwd(context));
				const session = getSession(id, env);
				const data = /[\r\n]$/.test(content) ? content : `${content}\r`;
				sendRawBytes(session, encoder.encode(data));
				const result = await collectSession(session, 250, context?.signal, undefined, store);
				return { content: result.content, details: { touchesNoFiles: true } };
			}
			if (path !== "/kill") {
				throw new Error(`Unsupported cterm:// write target "${url.href}"; use cterm://<id> or cterm://<id>/kill.`);
			}
			const env = await ensureEnv(resolveCwd(context));
			const session = getSession(id, env);
			await terminateSession(session, "graceful");
			const result = await collectSession(session, 500, context?.signal, undefined, store);
			await session.release();
			store.remove(session.id);
			return { content: result.content, details: { touchesNoFiles: true } };
		},
	};
	const existing = router.getHandler("cterm");
	if (existing !== undefined && ctermHandlerBrand in existing && existing[ctermHandlerBrand] === true) {
		router.unregister("cterm");
	}
	const outcome = registerInternalScheme(router, "omp-remote-build/cterm", handler);
	if (outcome.kind !== "registered") {
		throw new Error(`omp-remote-build: failed to register cterm:// (${outcome.reason})`);
	}
}

export function registerContainerTools(pi: ExtensionAPI, ensureEnv: (cwd: string) => Promise<PreparedEnv>): void {
	const store = new SessionStore({ maxSessions: 64, lruProtectedCount: 8 });
	let lifecycle: "active" | "shutdown" = "active";
	let nextSessionNumber = 1;
	const getSession = (id: number, env: PreparedEnv): ExecSession => {
		const session = store.get(String(id));
		if (!session || session.cwd !== env.root) throw new Error(`Unknown container session ${id} in environment ${env.root}.`);
		return session;
	};

	registerContainerUrls(store, ensureEnv, getSession);

	pi.on("session_shutdown", async () => {
		lifecycle = "shutdown";
		// Keep ownership until each local transport confirms exit. Killing km may leave the remote shell alive.
		await Promise.all(
			store.values().map(async (session) => {
				await terminateSession(session, "immediate");
				await session.releaseForShutdown();
				store.remove(session.id);
			}),
		);
	});

	const execTool = {
		name: "container_exec",
		loadMode: "essential" as const,
		defaultInactive: true,
		label: tr("Container exec", "容器执行"),
		description: TOOL_DESCRIPTIONS.container_exec,
		parameters: execSchema,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = execSchema.parse(rawParams);
			const env = await ensureEnv(ctx.cwd);
			if (lifecycle === "shutdown") throw new Error("Remote-build session is shutting down; no new container PTYs can be opened.");
			if (signal?.aborted) throw new Error("Container exec was cancelled before opening the PTY.");
			try {
				requireBunRuntime();
			} catch (error) {
				throw new Error(`Container PTY unavailable: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!(await containerRunning(env.host, env.container))) {
				throw new Error(`Container ${env.container} is not running. Call remote_env_init to prepare this worktree's environment.`);
			}
			const transport = await execTransport(env.host, env.container, env.config.shell);
			const session = ExecSession.spawn(String(nextSessionNumber++), {
				command: transport.argv,
				shell: env.config.shell,
				title: tr(`Container ${env.container}`, `容器 ${env.container}`),
				cwd: env.root,
				env: { ...process.env, ...transport.env },
				cols: 120,
				rows: 30,
			});
			if (session.failureMessage) throw new Error(`Could not open container PTY: ${session.failureMessage}`);
			store.insert(session);
			sendRawBytes(session, params.input ? encoder.encode(params.input) : undefined);
			return collectSession(session, params.yield_time_ms ?? 10_000, signal, onUpdate, store);
		},
	} satisfies ToolDefinition<typeof execSchema>;
	pi.registerTool(execTool);

	const writeTool = {
		name: "container_write_stdin",
		loadMode: "essential" as const,
		defaultInactive: true,
		label: tr("Container stdin", "容器标准输入"),
		description: TOOL_DESCRIPTIONS.container_write_stdin,
		parameters: writeSchema,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = writeSchema.parse(rawParams);
			const bytes = resolveWriteBytes(params);
			const env = await ensureEnv(ctx.cwd);
			const session = getSession(params.session_id, env);
			sendRawBytes(session, bytes);
			return collectSession(session, params.yield_time_ms ?? 250, signal, onUpdate, store);
		},
	} satisfies ToolDefinition<typeof writeSchema>;
	pi.registerTool(writeTool);
}
