Open an interactive PTY in the current remote-build container through Komodo, optionally sending initial input.

The result contains a session ID and output. Drive that session with `container_write_stdin`; read `help://container_write_stdin/usage` before sending input or polling. The container working directory is set by deployment, not this tool.

Komodo reuses the terminal named `shell` per container. Reuse an existing session instead of opening competing clients; `container_list_sessions` lists this environment's sessions.

`km` always exits 0; this is only the local transport's exit code. Read command exit codes from the container shell output, for example by sending `echo $?` immediately after the command.
