#!/bin/bash
# Session-End Hook
#
# Called by Claude Code when a session ends.
# Triggers a full session summary extraction.
#
# Environment variables from Claude Code:
#   CLAUDE_SESSION_ID - Current session identifier
#   CLAUDE_TRANSCRIPT_PATH - Path to session transcript

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find the project root (two levels up from dist/hooks/)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default memory directory is the current working directory where Claude Code runs
MEMORY_DIR="${MEMORY_DIR:-$(pwd)}"

# Read stdin (may contain session summary data)
STDIN_DATA=$(cat)

# Build event JSON
EVENT_JSON=$(node -e "
  const input = process.argv[1] ? JSON.parse(process.argv[1]) : {};
  const event = {
    event_type: 'session_end',
    session_id: process.env.CLAUDE_SESSION_ID || 'unknown',
    transcript_path: process.env.CLAUDE_TRANSCRIPT_PATH || '',
    conversation_summary: input.summary || ''
  };
  console.log(JSON.stringify(event));
" "${STDIN_DATA:-'{}'}" 2>/dev/null)

# Enqueue the event
if [ -n "$EVENT_JSON" ]; then
  echo "$EVENT_JSON" | MEMORY_DIR="$MEMORY_DIR" node "$PROJECT_ROOT/dist/hooks/enqueue.js" 2>/dev/null || true
fi
