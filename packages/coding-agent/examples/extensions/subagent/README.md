# Subagent Extension

Official subprocess-based subagent extension for hirocode. Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `hirocode` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Task alias**: Registers both `subagent` and `task` for Claude/Task-style delegation prompts
- **Persistent transcripts**: Each delegated task gets its own child session file under `~/.hirocode/agent/subagents/`
- **Resume support**: Reuse `task_id` with the `task` alias to continue an existing child session
- **Session navigation**: Use `/subagents` to jump into delegated child sessions from the current branch

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

### Task alias
```
Use the task tool with subagent_type "scout" to find all authentication code
```

### Resume a previous task
```
Use the task tool with task_id "<previous-task-id>" and subagent_type "scout" to continue the authentication scan
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

`task` is a single-task alias with Claude/Task-style parameters:

```json
{
  "description": "Auth code discovery",
  "prompt": "Find all authentication-related code paths",
  "subagent_type": "scout"
}
```

The extension returns `task_id` and `subagent_id` in Task tool results, and includes child task IDs in `subagent` summaries so the parent agent can hand work back to a specific child later. Resume only works for tasks previously created by this extension.

New task runs pre-create the child session with the same id used for `task_id`, so resume tokens now line up with the child session identity. Older runs may still surface a separate `subagent_id`.

## Child session storage

Delegated task transcripts are stored separately from the parent conversation:

```text
~/.hirocode/agent/subagents/<parent-session-id>/
  task-<task-id>.json
  task-<task-id>.jsonl
```

- `task-<task-id>.json` stores task metadata used for resume
- `task-<task-id>.jsonl` is the child hirocode session transcript
- the parent tool result keeps only linkage metadata and the summarized output

## Session switching

`/subagents` switches directly into the selected child session.

If multiple child sessions exist on the current branch, the command first lets you choose which one to open.

If the selected child is still running, you get two options:
- wait until the current parent turn is idle, then switch safely
- or switch immediately and interrupt the current work

This keeps navigation simple while still making it explicit when a direct switch would stop the current top-level turn.

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
