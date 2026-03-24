# Subagent Extension

Official subprocess-based subagent extension for hirocode. Delegate tasks to specialized subagents with isolated context windows.

This extension registers only `subagent`. Single-task delegation is handled by the built-in `task` tool.

## Features

- **Isolated context**: Each subagent runs in a separate `hirocode` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Built-in task orchestration**: Single/parallel/chain subagent flows run on top of the built-in `task` tool
- **Built-in navigation**: Use the built-in `/subagents` command to jump into delegated child sessions from the current branch

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.hirocode/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.hirocode/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.hirocode/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.hirocode/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.hirocode/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.hirocode/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.hirocode/agent/prompts/$(basename "$f")
done
```

Legacy `.pi/...` locations still work for existing setups, but new installs should use `.hirocode/...`.

## Security Model

This tool executes a separate `hirocode` subprocess with a delegated system prompt and tool/model configuration.

Each delegated task writes to its own child session file instead of using `--no-session`. The parent session stores only a summary plus task linkage metadata.

**Project-local agents** (`.hirocode/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.hirocode/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust. For compatibility, the extension still falls back to legacy `.pi/agents` if `.hirocode/agents` is absent.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Built-in task for single delegation
Use the built-in `task` tool when you only need one delegated child session:

```text
Use the task tool with subagent_type "scout" to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

`subagent` is the orchestration layer. Use it for:

- single `{ agent, task }` delegation when you want subagent-specific UI and summaries
- parallel `{ tasks: [...] }` fan-out
- chain `{ chain: [...] }` sequential workflows with `{previous}` handoff

Use the built-in `task` tool for plain single-task delegation, resume via `task_id`, and direct child-session navigation.

## Child session storage

Subagent runs now execute through the built-in `task` tool, so delegated child sessions use hirocode's standard session storage and navigation model.

For legacy extension-created task runs, the extension still recognizes the older `~/.hirocode/agent/subagents/...` metadata layout when checking nested delegation safeguards.

## Session switching

The built-in `/subagents` command handles child-session navigation for both built-in `task` and extension `subagent` runs.

It now navigates through the persisted parent/root session tree, so you can switch among sibling and descendant child sessions even after entering one of them.

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: [read, grep, find, ls]
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.hirocode/agent/agents/*.md` - User-level (always loaded)
- `.hirocode/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Optional frontmatter:
- `allowSubagents: true` - Opt this agent into nested `task`/`subagent` calls. By default, delegated child sessions cannot spawn more subagents.

Legacy fallbacks still recognized:
- `~/.pi/agent/agents/*.md`
- `.pi/agents/*.md`

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
