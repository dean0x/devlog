# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-20

### Added

- **Session-based knowledge consolidation**: Signals accumulate during Claude Code sessions and are consolidated when sessions become stale
- **Knowledge storage system**: Organized markdown files for conventions, architecture, decisions, and gotchas
- **Catch-up pre-computation**: Background computation of summaries for instant `devlog catch-up` queries
- **Project discovery mechanism**: Daemon automatically discovers and processes registered projects
- **Claude Code hooks**: PostToolUse (file tracking) and Stop (signal extraction) hooks
- **CLI commands**:
  - `devlog setup` - One-time initialization
  - `devlog daemon` - Start background daemon
  - `devlog status` - Show daemon and project status
  - `devlog catch-up` - Get instant session summary
  - `devlog knowledge` - View consolidated knowledge
  - `devlog hooks` - Output hook configuration

### Architecture

- Session signals stored in `.memory/working/session-*.json`
- Knowledge consolidated to `.memory/knowledge/*.md`
- Pre-computed summaries in `.memory/working/catch-up-*.json`
- Global daemon polls registered projects for stale sessions
- Direct Ollama integration via `ollama-js` library

### Technical

- TypeScript with strict mode
- Result pattern for error handling
- ESLint v9 flat config
- Vitest for testing
- Cross-platform temp directory support

### Known Limitations

- `CLAUDE_SESSION_ID` not passed by Claude Code (all sessions appear as "unknown")
- Requires Ollama running locally for LLM features
- First catch-up query may be slow (computing in background)

[0.1.0]: https://github.com/user/devlog/releases/tag/v0.1.0
