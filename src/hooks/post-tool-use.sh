#!/bin/bash
# Post-Tool-Use Hook
#
# Called by Claude Code after each tool execution.
# Captures tool usage and queues for memory extraction.
#
# Environment variables from Claude Code:
#   CLAUDE_SESSION_ID - Current session identifier
#   CLAUDE_TRANSCRIPT_PATH - Path to session transcript
#
# Stdin: JSON with tool execution details:
#   { "tool_name": "...", "tool_input": {...}, "tool_result": "..." }

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find the project root (two levels up from dist/hooks/)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default memory directory is the current working directory where Claude Code runs
MEMORY_DIR="${MEMORY_DIR:-$(pwd)}"

# Read stdin
STDIN_DATA=$(cat)

# Skip if no data
if [ -z "$STDIN_DATA" ]; then
  exit 0
fi

# Parse tool name from stdin (basic extraction)
TOOL_NAME=$(echo "$STDIN_DATA" | node -e "
  let data = '';
  process.stdin.on('data', chunk => data += chunk);
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      console.log(parsed.tool_name || 'unknown');
    } catch {
      console.log('unknown');
    }
  });
" 2>/dev/null || echo "unknown")

# Skip certain tools that aren't useful for memory extraction
case "$TOOL_NAME" in
  "Read"|"Glob"|"Grep"|"WebSearch"|"WebFetch")
    # These are read-only tools, less interesting for memory
    # We could optionally log them but they add noise
    exit 0
    ;;
esac

# Build event JSON
EVENT_JSON=$(node -e "
  const input = JSON.parse(process.argv[1]);
  const event = {
    event_type: 'tool_use',
    session_id: process.env.CLAUDE_SESSION_ID || 'unknown',
    transcript_path: process.env.CLAUDE_TRANSCRIPT_PATH || '',
    tool_name: input.tool_name || 'unknown',
    tool_input: input.tool_input,
    tool_result: typeof input.tool_result === 'string'
      ? input.tool_result.slice(0, 5000)
      : JSON.stringify(input.tool_result).slice(0, 5000)
  };
  console.log(JSON.stringify(event));
" "$STDIN_DATA" 2>/dev/null)

# Enqueue the event
if [ -n "$EVENT_JSON" ]; then
  echo "$EVENT_JSON" | MEMORY_DIR="$MEMORY_DIR" node "$PROJECT_ROOT/dist/hooks/enqueue.js" 2>/dev/null || true
fi
