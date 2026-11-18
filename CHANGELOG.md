# Changelog

## [Unreleased]

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

## [0.1.24] - 2026-11-15

### Fixed

- Fixed main-checkout detection on Windows when git and worktree paths used different separators
- Fixed environment lookup to match the current directory under either path separator

## [0.1.23] - 2026-11-12

### Changed

- Replaced per-push patch version bumps with a daily scheduled release that tags `vX.Y.Z` and moves the `release` branch
