# Harbor Adapter for Hirocode

This adapter gives Harbor a dedicated benchmark entry point for hirocode without changing the existing interactive CLI flow.

## Design

- Keeps benchmark behavior outside the main CLI entry path.
- Uses Harbor's `BaseInstalledAgent` interface, as recommended by the official Harbor docs for headless CLI agents.
- Installs the published `@hirocode/coding-agent` package inside the task container for stability.
- Loads benchmark prompts from this integration package instead of depending on `--benchmark-mode`.
- Isolates state under `/logs/agent/hirocode-home`, so benchmark runs do not mix with user config.
- Disables discovered user resources with `--no-extensions --no-skills --no-prompt-templates --no-themes`.
- Auto-loads a local benchmark bundle only when `integrations/harbor/benchmark_bundle/index.ts` exists, or when `HIROCODE_HARBOR_BUNDLE_DIR` points to one.

## Usage

From the repository root:

```bash
harbor run \
  -d terminal-bench@2.0 \
  --agent-import-path integrations.harbor.hirocode_agent:HirocodeInstalledAgent \
  -m openai/gpt-5.4 \
  -k 5
```

If you want to point the adapter at a local benchmark-only extension bundle before the default location exists:

```bash
HIROCODE_HARBOR_BUNDLE_DIR=/abs/path/to/bundle \
harbor run \
  -d terminal-bench@2.0 \
  --agent-import-path integrations.harbor.hirocode_agent:HirocodeInstalledAgent \
  -m openai/gpt-5.4
```

## Why this does not affect interactive mode

- The adapter lives under `integrations/harbor/`, outside the npm workspaces and outside the normal hirocode runtime.
- It does not patch `packages/coding-agent/src/main.ts` or the interactive TUI code paths.
- The benchmark prompts are injected only by Harbor when this adapter is used.
- Any future benchmark-only extension bundle is loaded explicitly with `--extension` while automatic discovery stays disabled.
