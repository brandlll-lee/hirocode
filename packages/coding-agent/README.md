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
  <a href="https://www.npmjs.com/package/@hirocode/coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@hirocode/coding-agent?style=flat-square" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

Hirocode is a terminal coding agent harness with an extensible core. Adapt hirocode to your workflows, not the other way around, without forking the internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [Hirocode Packages](#hirocode-packages) and share them with others via npm or git.

Today the core already includes interactive and headless modes, JSON/RPC integration, session trees with compaction, built-in web/file/shell tools, delegated task sessions via the `task` tool, built-in subagent profiles, and a first-class specification workflow via `/spec`. More advanced workflows like mission orchestration, MCP management, and GitHub automation can already be layered on via extensions and packages while the first-class product surface catches up.

Hirocode runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps. See [openclaw/openclaw](https://github.com/openclaw/openclaw) for a real-world SDK integration.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Hirocode Packages](#hirocode-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g @hirocode/coding-agent
```

The primary CLI command is `hirocode`. The legacy `pi` alias remains available for compatibility.

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
hirocode
```

Or use your existing subscription:

```bash
hirocode
/login  # Then select provider
```

Then just talk to hirocode. By default, hirocode gives the model seven built-in tools: `read`, `bash`, `edit`, `write`, `webfetch`, `websearch`, and `task`. Additional built-in tools like `todowrite`, `grep`, `find`, and `ls` can be enabled explicitly. The legacy `pi` command remains available as a compatibility alias, but `hirocode` is the primary CLI name.

## Capability Matrix

Hirocode's current product surface is intentionally uneven: some capabilities are stable built-ins today, some already exist in core but were under-documented, some are extension-promotable now, and some are still missing as first-class workflows.

### Stable built-in

- Interactive terminal UI, print mode, JSON mode, RPC mode, and SDK embedding
- Session persistence, `/resume`, `/tree`, `/fork`, auto-compaction, HTML export, sharing
- Provider/model selection, OAuth and API-key auth, scoped models, thinking levels
- Built-in tools: `read`, `bash`, `edit`, `write`, `webfetch`, `websearch`, `task`
- First-class specification workflow via `/spec`, including plan extraction, approval, and saved spec artifacts
- Built-in subagent profiles: `general`, `explore`, `planner`, `reviewer`
- Resource discovery for AGENTS.md / CLAUDE.md, skills, prompt templates, themes, and extensions

### Built-in but previously under-documented

- The default active built-in tool set already includes `task`
- Delegated child sessions are built into core and can be inspected with `/subagents`
- The `pi` command and `PI_*` environment variables remain supported as compatibility aliases

### Extension-promotable today

- Permission gates, protected paths, destructive action confirmation, and sandbox adapters
- MCP-style tool integration, custom providers, SSH delegation, custom tool renderers, and custom UI
- Todo workflows, session labeling/bookmarking, custom compaction, and runtime reload flows

### Missing as first-class core workflows

- Built-in autonomy ladder and approval center
- First-class Mission orchestration and Mission Control
- First-class MCP manager and registry UX
- First-class review workflow and GitHub automation surface

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, hirocode maintains a list of tool-capable models, updated with every release. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

**API keys:**
- Anthropic
- OpenAI
- Azure OpenAI
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Kimi For Coding
- MiniMax

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `~/.hirocode/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage, cost, context usage, current model

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (path, tokens, cost) |
| `/agents` | Browse available built-in, user, and project subagents |
| `/spec [request]` | Enter specification mode, review plans, or continue an active spec workflow |
| `/subagents` | Browse delegated child sessions and jump between them |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from the current branch |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit`, `/exit` | Quit hirocode |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.hirocode/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so hirocode can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session.md](docs/session.md) for file format.

### Management

Sessions auto-save to `~/.hirocode/agent/sessions/` organized by working directory.

```bash
hirocode -c                  # Continue most recent session
hirocode -r                  # Browse and select from past sessions
hirocode --no-session        # Ephemeral mode (don't save)
hirocode --session <path>    # Use specific session file or ID
hirocode --fork <path>       # Fork specific session file or ID into a new session
```

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press `l` to label entries as bookmarks

**`/fork`** - Create a new session file from the current branch. Opens a selector, copies history up to the selected point, and places that message in the editor for modification.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.hirocode/agent/settings.json` | Global (all projects) |
| `.hirocode/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

---

## Context Files

Hirocode loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.hirocode/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions, conventions, common commands. All matching files are concatenated.

### System Prompt

Replace the default system prompt with `.hirocode/SYSTEM.md` (project) or `~/.hirocode/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.hirocode/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.hirocode/agent/prompts/`, `.hirocode/prompts/`, or a [hirocode package](#hirocode-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.hirocode/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.hirocode/agent/skills/`, `~/.agents/skills/`, `.hirocode/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [hirocode package](#hirocode-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend hirocode with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (hirocode: ExtensionAPI) {
  hirocode.registerTool({ name: "deploy", ... });
  hirocode.registerCommand("stats", { ... });
  hirocode.on("tool_call", async (event, ctx) => { ... });
}
```

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make hirocode look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.hirocode/agent/extensions/`, `.hirocode/extensions/`, or a [hirocode package](#hirocode-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and hirocode immediately applies changes.

Place in `~/.hirocode/agent/themes/`, `.hirocode/themes/`, or a [hirocode package](#hirocode-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Hirocode Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** Hirocode packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
hirocode install npm:@foo/pi-tools
hirocode install npm:@foo/pi-tools@1.2.3      # pinned version
hirocode install git:github.com/user/repo
hirocode install git:github.com/user/repo@v1  # tag or commit
hirocode install git:git@github.com:user/repo
hirocode install git:git@github.com:user/repo@v1  # tag or commit
hirocode install https://github.com/user/repo
hirocode install https://github.com/user/repo@v1      # tag or commit
hirocode install ssh://git@github.com/user/repo
hirocode install ssh://git@github.com/user/repo@v1    # tag or commit
hirocode remove npm:@foo/pi-tools
hirocode uninstall npm:@foo/pi-tools          # alias for remove
hirocode list
hirocode update                               # skips pinned packages
hirocode config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.hirocode/agent/git/` (git) or global npm. Use `-l` for project-local installs (`.hirocode/git/`, `.hirocode/npm/`). If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `pi` key to `package.json`:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `pi` manifest, hirocode auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@hirocode/coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: AuthStorage.create(),
  modelRegistry: new ModelRegistry(authStorage),
});

await session.prompt("What files are in the current directory?");
```

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
hirocode --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

Hirocode keeps the core small, scriptable, and extensible, but the line between "core" and "workflow" needs to stay honest.

**Core first.** Hirocode already ships with sessions, branching, compaction, built-in shell/file/web tools, delegated task sessions, built-in subagent profiles, and first-class specification mode. Those are not extension-only features and should be described as such.

**Extensions are for product shape, not for hiding reality.** Mission workflows, permission gates, sandbox adapters, MCP integrations, custom providers, and higher-level orchestration can already be built on top of the current runtime. Extension examples remain the proving ground for features that may later move into core.

**Compatibility stays, branding moves forward.** The `pi` CLI name, package manifest conventions, and `PI_*` environment variable aliases remain supported for compatibility, but `hirocode` is the primary product name and the preferred name in new surface area.

**Missing first-class workflows stay explicit.** Hirocode still does not ship first-class mission orchestration, a complete autonomy ladder UX, or a built-in MCP manager. Those remain roadmap items, not hidden features.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the full rationale.

---

## CLI Reference

```bash
hirocode [options] [@files...] [messages...]
```

### Package Commands

```bash
hirocode install <source> [-l]     # Install package, -l for project-local
hirocode remove <source> [-l]      # Remove package
hirocode uninstall <source> [-l]   # Alias for remove
hirocode update [source]           # Update packages (skips pinned)
hirocode list                      # List installed packages
hirocode config                    # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, hirocode also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | hirocode -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path>` | Use specific session file or partial UUID |
| `--fork <path>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>` | Enable specific built-in tools (default: `read,bash,edit,write,webfetch,websearch,task`) |
| `--no-tools` | Disable all built-in tools (extension tools still work) |

Available built-in tools: `read`, `bash`, `edit`, `write`, `task`, `todowrite`, `grep`, `find`, `ls`, `webfetch`, `websearch`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
hirocode @prompt.md "Answer this"
hirocode -p @screenshot.png "What's in this image?"
hirocode @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
hirocode "List all .ts files in src/"

# Non-interactive
hirocode -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | hirocode -p "Summarize this text"

# Different model
hirocode --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
hirocode --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
hirocode --model sonnet:high "Solve this complex problem"

# Limit model cycling
hirocode --models "claude-*,gpt-4o"

# Read-only mode
hirocode --tools read,grep,find,ls -p "Review the code"

# High thinking level
hirocode --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HIROCODE_CODING_AGENT_DIR` | Override config directory (default: `~/.hirocode/agent`) |
| `HIROCODE_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `HIROCODE_SKIP_VERSION_CHECK` | Skip version check at startup |
| `PI_CODING_AGENT_DIR` | Legacy alias for `HIROCODE_CODING_AGENT_DIR` |
| `PI_PACKAGE_DIR` | Legacy alias for `HIROCODE_PACKAGE_DIR` |
| `PI_SKIP_VERSION_CHECK` | Legacy alias for `HIROCODE_SKIP_VERSION_CHECK` |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

---

## License

MIT

## See Also

- [@hirocode/ai](https://www.npmjs.com/package/@hirocode/ai): Core LLM toolkit
- [@hirocode/agent-core](https://www.npmjs.com/package/@hirocode/agent-core): Agent framework
- [@hirocode/tui](https://www.npmjs.com/package/@hirocode/tui): Terminal UI components
