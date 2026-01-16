# devlog

A background memory extraction system for Claude Code that captures, stores, and manages memories from your development sessions.

## Overview

Devlog monitors your Claude Code sessions via hooks and extracts meaningful memories using a local LLM (Ollama). Memories are organized into short-term and long-term storage with automatic decay and promotion mechanisms.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                      MAIN CLAUDE CODE SESSION                              │
│                    (Your normal development work)                          │
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
│                    EVENT QUEUE (.memory/queue/)                           │
│                    pending/*.json → processing → completed                │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    MEMORY DAEMON (memoryd)                                │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ Claude Code (headless) ──► Anthropic Proxy ──► Ollama (llama3.2)   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│  - Watches event queue                                                    │
│  - Spawns claude -p for extraction tasks                                  │
│  - Manages memory decay/compaction                                        │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
┌───────────────────────────────────┐  ┌───────────────────────────────────────┐
│   SHORT-TERM MEMORY           │  │   LONG-TERM MEMORY                    │
│   .memory/short/              │  │   .memory/long/                       │
│   ├── today.md                │  │   ├── conventions.md                  │
│   ├── this-week.md            │  │   ├── architecture.md                 │
│   └── this-month.md           │  │   └── rules-of-thumb.md               │
└───────────────────────────────┘  └───────────────────────────────────────┘
```

## Prerequisites

- Node.js >= 20.0.0
- [Ollama](https://ollama.ai/) running locally with `llama3.2` model
- Claude Code CLI installed

## How to Use Devlog on Your Own Project

### One-Time Global Setup

```bash
# 1. Build and install globally
cd /workspace/devlog
npm install
npm run build
npm link

# 2. Configure Claude Code hooks (run once)
devlog hooks
# Copy the output to ~/.claude/settings.json
```

### Per-Project Setup

```bash
# 1. Navigate to your project
cd /path/to/your/project

# 2. Initialize memory storage
devlog init

# 3. Start the proxy (Terminal 1)
devlog proxy

# 4. Start the daemon (Terminal 2, in your project dir)
cd /path/to/your/project
devlog daemon

# 5. Use Claude Code normally
claude
```

### View Captured Memories

```bash
cd /path/to/your/project
devlog read today
devlog read this-week
devlog read this-month
```

### Directory Structure Created

```
/your/project/
├── .memory/
│   ├── short/
│   │   ├── today.md          # Today's memories
│   │   ├── this-week.md      # This week's condensed
│   │   ├── this-month.md     # Monthly summaries
│   │   └── archive/          # Historical
│   ├── long/
│   │   ├── conventions.md    # Auto-promoted patterns
│   │   ├── architecture.md
│   │   └── rules-of-thumb.md
│   ├── queue/
│   │   ├── pending/          # Events waiting
│   │   ├── processing/       # Being processed
│   │   └── failed/           # Failed events
│   └── candidates.json       # Promotion candidates
└── ... your project files
```

### Quick Reference

| Command | Purpose |
|---------|---------|
| `devlog init` | Set up .memory in current directory |
| `devlog proxy` | Start Ollama proxy (port 8082) |
| `devlog daemon` | Process events and extract memories |
| `devlog status` | Check daemon status |
| `devlog read today` | View today's memories |
| `devlog hooks` | Get hook config for settings.json |

## Memory Storage

### Short-Term Memory

Located in `.memory/short/`:

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

Located in `.memory/long/`:

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

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | 8082 | Port for the Anthropic proxy |
| `OLLAMA_BASE_URL` | http://localhost:11434 | Ollama server URL |
| `OLLAMA_MODEL` | llama3.2 | Ollama model to use |
| `MEMORY_DIR` | ./.memory | Memory storage directory |
| `QUEUE_DIR` | ./.memory/queue | Event queue directory |
| `BATCH_SIZE` | 5 | Events to process per batch |
| `POLL_INTERVAL` | 5000 | Queue poll interval (ms) |

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
# Run Claude Code session
claude -p "Create a file test.txt"

# Check queue
ls .memory/queue/pending/
```

### Check Memories

```bash
devlog read today
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
  { baseDir: './.memory' },
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
3. Check MEMORY_DIR environment variable

### Extraction returning empty memories

1. Ensure daemon is running
2. Check proxy is accessible
3. Review daemon logs for errors

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
