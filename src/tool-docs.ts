export const TOOL_DESCRIPTIONS = {
	container_exec:
		"Open an interactive PTY inside the current remote-build container (reuses the container shell; drive with container_write_stdin or write cterm://<id>). Use `read cterm://` to list container sessions, `write cterm://<id>` to send stdin, and `write cterm://<id>/kill` to terminate one. Note: km always exits 0 (local transport only); read command exit codes from shell output via `echo $?`.",
	container_write_stdin:
		"Send verbatim text, enter, special_key, or raw_base64 to a container PTY (or omit input to poll output; default yield 250 ms; line input also works via `write cterm://<id>`). Note: km always exits 0 (local transport only); read command exit codes from shell output via `echo $?`.",
	remote_env_init:
		"Prepare this worktree's remote build container (resolve/cache image per Dockerfile content, recreate container ending open sessions, run bootstrap). Call before container_exec or after dependency changes; see `rebuild` for image/prepare.",
	remote_env_build_image:
		"Preparer-only: build a candidate image (final stage FROM rb-base-archlinux:latest, empty context so no COPY/ADD), recreate the container, and run single-line bootstrap. Published on final `result: success`; other agents use remote_env_init.",
} as const;

export type PluginToolName = keyof typeof TOOL_DESCRIPTIONS;
