# devlog

A background knowledge extraction system for Claude Code that captures, consolidates, and manages project knowledge from your development sessions.

## Overview

Devlog monitors your Claude Code sessions via hooks and extracts meaningful knowledge using a local LLM (Ollama). Knowledge is organized into categories (conventions, architecture, decisions, gotchas) and consolidated over time.

**Setup once, works everywhere** - The global daemon architecture means you configure devlog once and it automatically works across all your projects.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                      CLAUDE CODE SESSIONS                                  │
│                    (Any project, anywhere)                                 │
└────────────────────────────┬───────────────────────────────────────────────┘
                             │
            ┌────────────────┼────────────────┐
            │    Claude Code Hooks            │
            │  ┌──────────┐  ┌─────────────┐  │
            │  │PostTool  │  │Stop         │  │
            │  │Use       │  │(session end)│  │
            │  └────┬─────┘  └──────┬──────┘  │
            └───────┼───────────────┼─────────┘
                    │               │
                    ▼               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    SESSION SIGNAL ACCUMULATION                            │
│  Hooks extract signals from each turn:                                    │
│  - Files touched (Edit/Write tools)                                       │
│  - Decisions made (pattern matching)                                      │
│  - Problems discovered                                                    │
│  - Goals stated                                                           │
│  Signals stored in: {project}/.memory/working/session-*.json              │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    GLOBAL MEMORY DAEMON (memoryd)                         │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ Session Consolidation ──► Ollama (llama3.2) ──► Knowledge Files    │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│  - Discovers registered projects                                          │
│  - Monitors session staleness (idle timeout)                              │
│  - Consolidates sessions to knowledge when complete                       │
│  - Pre-computes catch-up summaries (instant queries!)                     │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│ Project A       │       │ Project B       │       │ Project C       │
│ /.memory/       │       │ /.memory/       │       │ /.memory/       │
│ ├── knowledge/  │       │ ├── knowledge/  │       │ ├── knowledge/  │
│ │   ├── conv... │       │ │   ├── conv... │       │ │   ├── conv... │
│ │   ├── arch... │       │ │   ├── arch... │       │ │   ├── arch... │
│ │   ├── deci... │       │ │   ├── deci... │       │ │   ├── deci... │
│ │   └── gotc... │       │ │   └── gotc... │       │ │   └── gotc... │
│ ├── working/    │       │ ├── working/    │       │ ├── working/    │
│ └── index.md    │       │ └── index.md    │       │ └── index.md    │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

## Prerequisites

- Node.js >= 20.0.0
- [Ollama](https://ollama.ai/) running locally with `llama3.2` model
- Claude Code CLI installed

## Quick Start

```bash
# 1. Install devlog
npm install -g devlog
# Or build from source:
cd /path/to/devlog && npm install && npm run build && npm link

# 2. Run setup (creates config, registers hooks)
devlog setup --yes

# 3. Start the daemon
devlog daemon &

# 4. Use Claude Code normally - knowledge is captured automatically!
cd /any/project
claude
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `devlog setup [--yes]` | Initialize devlog (creates ~/.devlog, registers hooks) |
| `devlog daemon` | Start the background memory daemon |
| `devlog status` | Show daemon status and registered projects |
| `devlog catch-up` | Get instant summary of recent session activity |
| `devlog knowledge` | Show consolidated knowledge for current project |
| `devlog hooks` | Output hook configuration for manual setup |

## Directory Structure

### Global (created by setup)

```
~/.devlog/
├── config.json           # Global configuration
├── daemon.pid            # Daemon process ID
└── projects.json         # Registered project paths
```

### Per-Project (auto-created)

```
/your/project/.memory/
├── knowledge/            # Consolidated knowledge (markdown)
│   ├── conventions.md    # How things are done
│   ├── architecture.md   # Structural decisions
│   ├── decisions.md      # Explicit choices with rationale
│   └── gotchas.md        # Warnings and edge cases
├── working/              # Ephemeral session data
│   ├── session-*.json    # Active session signals
│   ├── catch-up-state.json
│   └── catch-up-summary.json
└── index.md              # Auto-generated table of contents
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Ollama model for extraction |
| `DEVLOG_HOME` | `~/.devlog` | Override global directory |
| `DEVLOG_DEBUG` | unset | Set to `1` for debug logging |

### Docker / Container Setup

When running Claude Code inside a container, `localhost` refers to the container, not your host machine where Ollama runs.

**Docker Desktop (Mac/Windows):**
```bash
export OLLAMA_BASE_URL=http://host.docker.internal:11434
```

**Linux Docker:**
```bash
# Option 1: Add host mapping when starting container
docker run --add-host=host.docker.internal:host-gateway ...

# Option 2: Use host's actual IP
export OLLAMA_BASE_URL=http://192.168.1.x:11434
```

**Ollama also in Docker (same network):**
```bash
export OLLAMA_BASE_URL=http://ollama:11434
```

## How It Works

### Signal Extraction

The `PostToolUse` hook tracks files modified during a session. The `Stop` hook (triggered when Claude pauses) extracts signals from the conversation:

- **file_touched**: Files edited or created
- **decision_made**: Choices with rationale (detected via patterns)
- **problem_discovered**: Issues identified in conversation
- **goal_stated**: User intentions

### Session Consolidation

When a session becomes stale (no activity for 5 minutes), the daemon:

1. Loads existing project knowledge for context
2. Analyzes accumulated signals
3. Calls Ollama to determine the consolidation action:
   - `create_section` - New knowledge
   - `extend_section` - Add detail to existing
   - `confirm_pattern` - Reinforce existing (increment observations)
   - `skip` - No valuable knowledge

### Catch-Up Summaries

The daemon pre-computes summaries in the background. When you run `devlog catch-up`, results are instant because they're already computed. The dirty flag system ensures summaries stay fresh.

## Troubleshooting

### Daemon not starting

```bash
# Check if already running
devlog status

# Check for stale PID file
cat ~/.devlog/daemon.pid
ps aux | grep memoryd

# Remove stale PID and restart
rm ~/.devlog/daemon.pid
devlog daemon
```

### No knowledge being captured

1. Verify hooks are registered:
   ```bash
   cat ~/.claude/settings.json | grep devlog
   ```

2. Check daemon is running:
   ```bash
   devlog status
   ```

3. Verify Ollama is accessible:
   ```bash
   curl http://localhost:11434/api/tags
   ```

### Catch-up returns empty

- First run takes time to compute
- Wait for session to be "stale" (5 min idle)
- Check daemon logs for extraction errors

### Docker: Ollama connection refused

Set `OLLAMA_BASE_URL` to reach host machine:
```bash
export OLLAMA_BASE_URL=http://host.docker.internal:11434
```

## Known Limitations

1. **Session ID**: Claude Code doesn't currently pass `CLAUDE_SESSION_ID` environment variable to hooks, so all sessions appear as "unknown". Knowledge is still captured correctly per-project.

2. **Ollama Required**: LLM-based features (knowledge extraction, catch-up summaries) require Ollama running locally.

3. **First Run Latency**: The initial catch-up query may be slow while the summary is being computed. Subsequent queries are instant.

4. **Pattern Detection**: Signal extraction uses heuristic pattern matching. Not all decisions/problems will be detected automatically.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Type check
npm run typecheck

# Lint
npm run lint

# Run tests
npm test

# Watch mode for daemon development
npm run dev:daemon
```

## License

MIT
