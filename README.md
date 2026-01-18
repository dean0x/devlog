# devlog

A background memory extraction system for Claude Code that captures, stores, and manages memories from your development sessions.

## Overview

Devlog monitors your Claude Code sessions via hooks and extracts meaningful memories using a local LLM (Ollama). Memories are organized into short-term and long-term storage with automatic decay and promotion mechanisms.

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
            │  │PostTool  │  │SessionEnd   │  │
            │  │Use       │  │             │  │
            │  └────┬─────┘  └──────┬──────┘  │
            └───────┼───────────────┼─────────┘
                    │               │
                    ▼               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│             GLOBAL EVENT QUEUE (~/.devlog/queue/)                         │
│         pending/*.json → processing → completed                           │
│         Events include project_path for routing                           │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    GLOBAL MEMORY DAEMON (memoryd)                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ Anthropic Proxy ──► Ollama (llama3.2) ──► Memory Extraction        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│  - Watches global queue                                                   │
│  - Routes memories to correct project based on project_path               │
│  - Auto-initializes project .memory/ directories                          │
│  - Manages memory decay/compaction per project                            │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│ Project A       │       │ Project B       │       │ Project C       │
│ /.memory/       │       │ /.memory/       │       │ /.memory/       │
│ ├── short/      │       │ ├── short/      │       │ ├── short/      │
│ │   └── today.md│       │ │   └── today.md│       │ │   └── today.md│
│ └── long/       │       │ └── long/       │       │ └── long/       │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

## Prerequisites

- Node.js >= 20.0.0
- [Ollama](https://ollama.ai/) running locally with `llama3.2` model
- Claude Code CLI installed

## Quick Start (One-Time Global Setup)

```bash
# 1. Build and install globally
cd /path/to/devlog
npm install
npm run build
npm link

# 2. Initialize global devlog
devlog init
# Creates ~/.devlog/ with queue directories and config

# 3. Configure Claude Code hooks
devlog hooks
# Copy the output to ~/.claude/settings.json

# 4. Start the proxy (in background or separate terminal)
devlog proxy &

# 5. Start the global daemon (in background or separate terminal)
devlog daemon &

# That's it! Now use Claude Code in any project:
cd /any/project
claude
# Memories are automatically captured to /any/project/.memory/
```

## Using Devlog

Once set up, devlog works automatically in any project directory:

```bash
# Use Claude Code normally in any project
cd /project-a
claude   # Memories auto-saved to /project-a/.memory/

cd /project-b
claude   # Memories auto-saved to /project-b/.memory/

# View captured memories for current project
devlog read today
devlog read this-week
devlog read this-month

# Check global daemon status
devlog status
```

## Directory Structure

### Global (setup once)

```
~/.devlog/
├── config.json           # Global configuration
├── daemon.status         # Daemon status (running, events processed, etc.)
└── queue/
    ├── pending/          # Events from all projects
    ├── processing/       # Events being processed
    └── failed/           # Failed events
```

### Per-Project (auto-created)

```
/your/project/.memory/
├── short/
│   ├── today.md          # Today's memories
│   ├── this-week.md      # This week's condensed
│   ├── this-month.md     # Monthly summaries
│   └── archive/          # Historical
├── long/
│   ├── conventions.md    # Auto-promoted patterns
│   ├── architecture.md
│   └── rules-of-thumb.md
└── candidates.json       # Promotion candidates
```

## CLI Reference

| Command | Purpose |
|---------|---------|
| `devlog init` | Initialize global ~/.devlog directory (one-time) |
| `devlog proxy` | Start Ollama proxy (port 8082) |
| `devlog daemon` | Start global memory daemon |
| `devlog status` | Check daemon status + current project info |
| `devlog read today` | View today's memories for current project |
| `devlog read this-week` | View this week's memories |
| `devlog read this-month` | View this month's memories |
| `devlog hooks` | Get hook config for settings.json |
| `devlog config` | Show current configuration |

## Memory Storage

### Short-Term Memory

Located in `{project}/.memory/short/`:

- `today.md` - Full detail from today's sessions
- `this-week.md` - Condensed high-confidence memories
- `this-month.md` - Monthly summaries
- `archive/` - Historical archives

Example entry:

```markdown
## 14:32 - Refactored TaskManager to event-driven

**Decision**: Switched from direct repository access to EventBus pattern
**Rationale**: Better testability and extensibility
**Files**: src/services/task-manager.ts, src/core/event-bus.ts
**Confidence**: 0.92
```

### Long-Term Memory

Located in `{project}/.memory/long/`:

- `conventions.md` - Coding conventions observed
- `architecture.md` - Architecture decisions
- `rules-of-thumb.md` - General patterns

These are automatically populated when patterns are observed 3+ times with high confidence.

## Decay Algorithm

Memories are automatically compacted over time:

| Period | Action |
|--------|--------|
| Daily (2 AM) | Yesterday's memories → this-week (filter confidence < 0.7) |
| Weekly (Monday) | Last week → this-month (keep decisions/patterns only) |
| Monthly (1st) | Previous month → archive (generate summary) |

## Configuration

### Global Config File

Edit `~/.devlog/config.json`:

```json
{
  "ollama_base_url": "http://localhost:11434",
  "ollama_model": "llama3.2",
  "proxy_port": 8082
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | from config or 8082 | Port for the Anthropic proxy |
| `OLLAMA_BASE_URL` | from config or http://localhost:11434 | Ollama server URL |
| `OLLAMA_MODEL` | from config or llama3.2 | Ollama model to use |
| `DEVLOG_HOME` | ~/.devlog | Override global directory |
| `DEVLOG_QUEUE_DIR` | ~/.devlog/queue | Override queue directory |
| `BATCH_SIZE` | 5 | Events to process per batch |
| `POLL_INTERVAL` | 5000 | Queue poll interval (ms) |

### Docker Configuration

When running inside a Docker container (e.g., Claude Code in Docker), `localhost` refers to the container, not your host machine where Ollama runs.

**Docker Desktop (Mac/Windows):**
```bash
export OLLAMA_BASE_URL=http://host.docker.internal:11434
devlog proxy
```

**Linux Docker:**
```bash
# Option 1: Add host mapping when starting container
docker run --add-host=host.docker.internal:host-gateway ...

# Option 2: Use host's actual IP
export OLLAMA_BASE_URL=http://192.168.1.x:11434
```

**Ollama also in Docker:**
```bash
# Use Docker networking (same network)
export OLLAMA_BASE_URL=http://ollama:11434
```

## Verification

### Test the Proxy

```bash
curl -X POST http://localhost:8082/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'
```

### Test Hooks

```bash
# Run Claude Code session in any project
cd /any/project
claude -p "Create a file test.txt"

# Check global queue
ls ~/.devlog/queue/pending/
```

### Check Memories

```bash
cd /any/project
devlog read today
```

### Check Status

```bash
devlog status
# Shows global daemon status and current project info
```

## Programmatic Usage

```typescript
import {
  createProxyApp,
  initMemoryStore,
  readShortTermMemory,
  extractMemories,
} from 'devlog';

// Create proxy app
const app = createProxyApp({
  port: 8082,
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  timeout: 120000,
});

// Read memories
const result = await readShortTermMemory(
  { baseDir: '/path/to/project/.memory' },
  'today'
);
if (result.ok) {
  console.log(result.value.memories);
}
```

## Troubleshooting

### Proxy not connecting to Ollama

1. Ensure Ollama is running: `ollama serve`
2. Check the model is available: `ollama list`
3. Verify URL: `curl http://localhost:11434/api/tags`

### Events not appearing in queue

1. Check hook paths in settings.json are absolute
2. Verify hook scripts are executable: `chmod +x dist/hooks/*.sh`
3. Run `devlog status` to see queue stats

### Extraction returning empty memories

1. Ensure daemon is running: `devlog status`
2. Check proxy is accessible
3. Review daemon logs for errors

### Project memories not appearing

1. Verify daemon is routing correctly: `devlog status` shows the project
2. Check `{project}/.memory/` directory was auto-created
3. Run `devlog read today` from the project directory

## Development

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint

# Watch mode
npm run dev:proxy
npm run dev:daemon
```
