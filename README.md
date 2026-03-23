<!-- OSS_WEEKEND_START -->
# 🏖️ OSS Weekend

**Issue tracker reopens Monday, March 23, 2026.**

OSS weekend runs Friday, March 20, 2026 through Monday, March 23, 2026. New issues are auto-closed during this time. For support, join [Discord](https://discord.com/invite/3cU7Bz4UPx).
<!-- OSS_WEEKEND_END -->

---

<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="hirocode logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

# Hirocode Monorepo

> **Looking for the coding agent foundation?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

This repository is the working base for `hirocode`, a terminal-first AI coding agent focused on agent teams and native API/CLI tools.

The codebase is being rebranded in phases. Current branding updates cover repository identity, the primary CLI name, and the config directory while preserving the current internal package/import structure so development can continue without breaking the workspace.

## Packages

| Package | Description |
|---------|-------------|
| **[@hirocode/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@hirocode/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@hirocode/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@hirocode/mom](packages/mom)** | Slack bot that delegates messages to the hirocode coding agent |
| **[@hirocode/tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@hirocode/web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@hirocode/pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./hirocode-test.sh   # Run hirocode from sources (must be run from repo root)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
