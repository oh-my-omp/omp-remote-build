Terminate the local `km` PTY client with SIGTERM, escalating to SIGKILL after two seconds.

This does not stop or delete the container; the reused remote shell may remain alive. Prefer sending `exit\n` with `container_write_stdin` to end the shell itself. Read `help://container_write_stdin/usage` before sending input.

`km` always exits 0; this is only the local transport's exit code. Read command exit codes from the container shell output, for example by sending `echo $?` immediately after the command.
