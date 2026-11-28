# Changelog

## [Unreleased]

## [0.3.0] - 2026-11-28

### Breaking Changes

- Changed `remote_env_build_image` so omitting a bootstrap command is expressed explicitly with `no_bootstrap: true` instead of `bootstrap: ""`; `bootstrap` and `no_bootstrap` are mutually exclusive and one of them must be provided

### Changed

- Registered all four plugin tools (`container_exec`, `container_write_stdin`, `remote_env_init`, `remote_env_build_image`) through the shared `omompTool` entry (`omomp-shared/tool-entry.ts` from `oh-my-omp/shared@960ad19`) so blank strings, empty arrays/objects, and `null` are normalized as omitted before validation while `container_exec.input` and `container_write_stdin.text` preserve whitespace verbatim

## [0.2.0] - 2026-11-27

### Breaking Changes

- Komodo credentials now come from the km connection list (`komodo.endpoint` names `<endpointsDir>/<endpoint>.toml` with `host`/`bao_path`/`key_field`/`secret_field`) and OpenBao via `bao-exec run --path <bao_path> -- printenv <field>`; `komodo.profile` and `komodo.cliConfig` are rejected as unknown fields and no `komodo.cli.toml` is read — migrate `<agentDir>/remote-build.json`

### Fixed

- Fixed the plugin failing to load on omp 19.2.0 by importing output truncation (`truncateTail`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`) from `@oh-my-pi/pi-coding-agent/tools/streaming-output`, where 19.2.0 moved it from `@oh-my-pi/pi-tui`; container tool output keeps the same tail and truncation limits

## [0.1.28] - 2026-11-24

### Changed

- Switched the container PTY layer from `omp-unified-exec` to its renamed successor `omp-actual-terminal` (peer dependency and imports); install `https://github.com/oh-my-omp/omp-actual-terminal#release` alongside this plugin

## [0.1.27] - 2026-11-22

### Changed

- Migrated all tool doc topic pointers from `xd://` to `help://` and shortened all six tool descriptions to fit within omp 19.1.0's 200-character external command description cap with their `help://<tool>/usage` link
- Updated the shared copy of `context-delta.ts` to oh-my-omp/shared@3d09cd4.

## [0.1.26] - 2026-11-21

### Changed

- Updated the shared copy of `context-delta.ts` to oh-my-omp/shared@80068ad.

## [0.1.25] - 2026-11-19

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

## [0.1.24] - 2026-11-15

### Fixed

- Fixed main-checkout detection on Windows when git and worktree paths used different separators
- Fixed environment lookup to match the current directory under either path separator

## [0.1.23] - 2026-11-12

### Changed

- Replaced per-push patch version bumps with a daily scheduled release that tags `vX.Y.Z` and moves the `release` branch
