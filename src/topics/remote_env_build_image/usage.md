Preparer-only: build a candidate project image from a Dockerfile, recreate this worktree's container from it, and run the bootstrap command.

The Dockerfile's final stage must be `FROM rb-base-archlinux:latest`. The build context is empty, so `COPY` and `ADD` are not allowed. Bootstrap is a single-line idempotent shell command, or an empty string for none.

The last successful candidate is published to `.omp/remote-build.Dockerfile` and `.omp/remote-build.json` when the preparer's final report has `result: success`. The tool returns the build and bootstrap output. Other agents must use `remote_env_init`; read `help://remote_env_init/usage` before initializing an environment.
