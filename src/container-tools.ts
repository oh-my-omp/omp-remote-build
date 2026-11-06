import { readFileSync } from "node:fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail, z } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { CollectResult } from "omp-unified-exec/src/collect.ts";
import { waitForExitOrDeadline } from "omp-unified-exec/src/long-wait.ts";
import { sanitizeOutputText } from "omp-unified-exec/src/output-safety.ts";
import { requireBunRuntime } from "omp-unified-exec/src/pty.ts";
import { ExecSession } from "omp-unified-exec/src/session.ts";
import { SessionStore } from "omp-unified-exec/src/session-store.ts";
import { unescapeChars } from "omp-unified-exec/src/unescape.ts";
import { containerRunning, execArgv } from "./komodo.ts";
import type { PreparedEnv } from "./types.ts";
import { tr } from "./i18n.ts";

const EXIT_NOTE = "km always exits 0; this is only the local transport's exit code. Read command exit codes from the container shell output, e.g. echo $? immediately after the command.";
const encoder = new TextEncoder();
const yieldSchema = z.number().int().min(250).max(30_000).optional().describe("Attachment window in milliseconds, not a command timeout; 250–30000.");
const sessionIdSchema = z.number().int().positive().describe("Session ID returned by container_exec, scoped to the current environment.");
const execSchema = z.object({
	input: z.string().optional().describe("Optional initial shell input. C-style escapes are decoded, including \\n, \\x03 and \\x1b; no newline is appended."),
	yield_time_ms: yieldSchema,
});
const writeSchema = z.object({
	session_id: sessionIdSchema,
	chars: z.string().optional().describe("Input with C-style escapes (\\n, \\r, \\t, \\xHH, \\uHHHH, \\u{H…}, \\e, \\0, \\\\). Unknown escapes are preserved. Omit or pass empty string to poll."),
	yield_time_ms: yieldSchema,
});
const killSchema = z.object({ session_id: sessionIdSchema });
const listSchema = z.object({});

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
	return session.hasExited
		? { status: "exited", km_exit_code: session.exitCode, signal: session.signal }
		: { status: "running" };
}

/** What one tool result shows of the session's output. */
interface Observed {
	readonly text: string;
	/** Always 0 for terminal screens; retained in the container tool result shape. */
	readonly omittedBytes: number;
	/** `unchanged`: the tty screen is exactly as last reported. */
	readonly screen: "changed" | "unchanged";
	/** Scrolled-off rows were evicted from the emulator history before being reported; they are only in the log. */
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

function liveObserved(session: ExecSession): Observed {
	return { text: session.liveSnapshot()?.text ?? "", omittedBytes: 0, screen: "changed", historyMayBeTruncated: false };
}

function sessionResult(session: ExecSession, seen: Observed): AgentToolResult<SessionDetails> {
	const truncated = truncateTail(sanitizeOutputText(seen.text), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const details: SessionDetails = {
		session_id: session.id,
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
	const lines = [
		`[${details.transport.status}] session_id: ${session.id}`,
		`log_path: ${session.logPath}`,
		`note: ${EXIT_NOTE}`,
	];
	if (details.transport.status === "exited") {
		lines.push(`km_exit_code: ${details.transport.km_exit_code}`, `signal: ${details.transport.signal ?? "none"}`);
	}
	if (session.failureMessage) lines.push(`failure: ${sanitizeOutputText(session.failureMessage)}`);
	if (seen.historyMayBeTruncated) lines.push(`history: older scrolled-off lines are only in ${session.logPath}`);
	lines.push("---", details.output || (seen.screen === "unchanged" ? "(screen unchanged since the last call)" : "(no output)"));
	if (truncated.truncated) lines.push(`\n[Output truncated to the last ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes. Full output: ${session.logPath}]`);
	return { content: [{ type: "text", text: lines.join("\n") }], details };
}

/** Stream parsed screen changes without consuming poll observations. */
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
): Promise<AgentToolResult<SessionDetails>> {
	session.touch();
	const stream = onUpdate ? streamScreen(session, onUpdate) : undefined;
	try {
		return sessionResult(session, observed(await session.collect({ deadlineMs: Date.now() + yieldMs, externalAbort: signal })));
	} finally {
		stream?.stop();
	}
}

function sendInput(session: ExecSession, input: string | undefined): void {
	if (input && !session.write(encoder.encode(unescapeChars(input)))) {
		throw new Error(`Container session ${session.id} stdin is closed; poll without chars to read its final output.`);
	}
}

/**
 * `graceful`: SIGTERM, then SIGKILL after 2 s (container_kill_session).
 * `immediate`: SIGKILL at once, because omp aborts session_shutdown handlers after 2 s.
 */
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
	if (!session.hasExited) throw new Error(`Container session ${session.id} km client is still running after SIGKILL; the session remains available for another kill attempt.`);
}

/** Register one agent-session-owned PTY store on top of omp-unified-exec's PTY sessions. */
export function registerContainerTools(pi: ExtensionAPI, ensureEnv: (cwd: string) => Promise<PreparedEnv>): void {
	const store = new SessionStore({ maxSessions: 64, lruProtectedCount: 8 });
	let lifecycle: "active" | "shutdown" = "active";
	const getSession = (id: number, env: PreparedEnv): ExecSession => {
		const session = store.get(id);
		if (!session || session.cwd !== env.root) throw new Error(`Unknown container session ${id} in environment ${env.root}.`);
		return session;
	};

	pi.on("session_shutdown", async () => {
		lifecycle = "shutdown";
		// Keep ownership until each local transport confirms exit. Killing km may leave the remote shell alive.
		await Promise.all(store.values().map(async (session) => {
			await terminateSession(session, "immediate");
			await session.releaseForShutdown();
			store.remove(session.id);
		}));
	});

	const execTool = {
		name: "container_exec",
		defaultInactive: true,
		label: tr("Container exec", "容器执行"),
		description: "Open an interactive PTY in the current remote-build container through Komodo.\n\nTopics — read the one a call needs before making it:\n- `xd://container_exec/usage` — before opening a container terminal or interpreting its exit status",
		docTopics: () => ({ usage: readFileSync(new URL("./topics/container_exec/usage.md", import.meta.url), "utf8") }),
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
			const session = ExecSession.spawn(store.allocateId(), {
				command: execArgv(env.host, env.container, env.config.shell),
				title: tr(`Container ${env.container}`, `容器 ${env.container}`),
				cwd: env.root,
				env: process.env,
				cols: 120,
				rows: 30,
			});
			if (session.failureMessage) throw new Error(`Could not open container PTY: ${session.failureMessage}`);
			store.insert(session);
			sendInput(session, params.input);
			return collectSession(session, params.yield_time_ms ?? 10_000, signal, onUpdate);
		},
	} satisfies ToolDefinition<typeof execSchema> & { docTopics(): Readonly<Record<string, string>> };
	pi.registerTool(execTool);

	const writeTool = {
		name: "container_write_stdin",
		defaultInactive: true,
		label: tr("Container stdin", "容器标准输入"),
		description: "Send characters to a container PTY and/or poll for output.\n\nTopics — read the one a call needs before making it:\n- `xd://container_write_stdin/usage` — before sending input, polling output, or interpreting exit status",
		docTopics: () => ({ usage: readFileSync(new URL("./topics/container_write_stdin/usage.md", import.meta.url), "utf8") }),
		parameters: writeSchema,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = writeSchema.parse(rawParams);
			const env = await ensureEnv(ctx.cwd);
			const session = getSession(params.session_id, env);
			sendInput(session, params.chars);
			const result = await collectSession(session, params.yield_time_ms ?? 250, signal, onUpdate);
			if (session.hasExited && session.outputClosed.isClosed) {
				await session.release();
				store.remove(session.id);
			}
			return result;
		},
	} satisfies ToolDefinition<typeof writeSchema> & { docTopics(): Readonly<Record<string, string>> };
	pi.registerTool(writeTool);

	const listTool = {
		name: "container_list_sessions",
		defaultInactive: true,
		label: tr("Container sessions", "容器会话"),
		description: "List container PTY sessions for the current remote-build environment.\n\nTopics — read the one a call needs before making it:\n- `xd://container_list_sessions/usage` — before listing sessions or interpreting ended sessions and transport status",
		docTopics: () => ({ usage: readFileSync(new URL("./topics/container_list_sessions/usage.md", import.meta.url), "utf8") }),
		parameters: listSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			listSchema.parse(rawParams);
			const env = await ensureEnv(ctx.cwd);
			const sessions = store.values().filter((session) => session.cwd === env.root).map((session) => ({
				session_id: session.id,
				transport: transportState(session),
				command: sanitizeOutputText(session.displayCommand),
				cwd: session.cwd,
				log_path: session.logPath,
				started_at_ms: session.startedAt,
				failure_message: session.failureMessage,
			}));
			return {
				content: [{ type: "text", text: `${JSON.stringify(sessions, null, 2)}\n${EXIT_NOTE}` }],
				details: { sessions },
			};
		},
	} satisfies ToolDefinition<typeof listSchema> & { docTopics(): Readonly<Record<string, string>> };
	pi.registerTool(listTool);

	const killTool = {
		name: "container_kill_session",
		defaultInactive: true,
		label: tr("Kill container session", "终止容器会话"),
		description: "Terminate the local km PTY client for a container session.\n\nTopics — read the one a call needs before making it:\n- `xd://container_kill_session/usage` — before terminating a client or choosing how to end its remote shell",
		docTopics: () => ({ usage: readFileSync(new URL("./topics/container_kill_session/usage.md", import.meta.url), "utf8") }),
		parameters: killSchema,
		async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
			const params = killSchema.parse(rawParams);
			const env = await ensureEnv(ctx.cwd);
			const session = getSession(params.session_id, env);
			await terminateSession(session, "graceful");
			const result = await collectSession(session, 500, undefined, onUpdate);
			await session.release();
			store.remove(session.id);
			return result;
		},
	} satisfies ToolDefinition<typeof killSchema> & { docTopics(): Readonly<Record<string, string>> };
	pi.registerTool(killTool);
}
