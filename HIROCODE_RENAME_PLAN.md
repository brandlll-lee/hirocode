# Hirocode Rename Plan

This repository started from `pi-mono` and is being migrated into `hirocode` in phases.

## Phase 1

- Initialize a fresh git repository for `hirocode`
- Rebrand top-level repository identity and workspace naming
- Document the migration strategy before touching internal package imports

## Phase 2

- Rename the public CLI brand from `pi` to `hirocode`
- Introduce `hirocode` config directory and migration behavior from `.pi`
- Update user-facing docs, help text, and release assets

## Phase 3

- Migrate internal package scope from `@mariozechner/*` to `@hirocode/*`
- Update workspace dependencies and internal source imports
- Refresh package-lock and publishing metadata

## Phase 4

- Rework product architecture around agent teams
- Add native API/CLI tool registration with MCP fallback
- Benchmark and optimize for terminal-bench@2.0 performance

## Notes

- Phase 1 intentionally avoids changing internal import paths to keep the monorepo buildable during the transition.
- Package-scope migration should be done as one coordinated pass because package names, source imports, examples, docs, and publish metadata all need to move together.
