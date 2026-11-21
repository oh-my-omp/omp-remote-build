import { readFileSync } from "node:fs";

export const TOOL_DESCRIPTIONS = {
	container_exec:
		"Open an interactive PTY in the current remote-build container through Komodo. Read `help://container_exec/usage` before opening a container terminal or reading exit status.",
	container_write_stdin:
		"Send characters to a container PTY and/or poll for output. Read `help://container_write_stdin/usage` before sending input, polling output, or interpreting exit status.",
	container_list_sessions:
		"List container PTY sessions for the current remote-build environment. Read `help://container_list_sessions/usage` before listing sessions or interpreting ended/transport status.",
	container_kill_session:
		"Terminate the local km PTY client for a container session. Read `help://container_kill_session/usage` before terminating a client or choosing how to end its remote shell.",
	remote_env_init:
		"Prepare this worktree's remote build container and return an initialization report. Read `help://remote_env_init/usage` before initializing, rebuilding, or recreating an environment.",
	remote_env_build_image:
		"Build a candidate project image and run bootstrap for the preparer subagent. Read `help://remote_env_build_image/usage` before building a candidate or publishing the preparer report.",
} as const;

export type PluginToolName = keyof typeof TOOL_DESCRIPTIONS;

export function usageTopics(tool: PluginToolName): Readonly<Record<string, string>> {
	return { usage: readFileSync(new URL(`./topics/${tool}/usage.md`, import.meta.url), "utf8") };
}
