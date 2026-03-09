# CLI Tool Template

## Description
A command-line tool built with Bun and TypeScript. Features a lightweight argument parser, structured command registry, and clean output formatting.

## Tech Stack
- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **Validation:** Zod
- **Output:** Supports JSON and human-readable formats

## Features
- Command-based architecture with pluggable handlers
- Built-in --help, --version, --verbose, --json flags
- Lightweight argument parser (no external dependencies)
- Error handling with verbose mode for debugging
- Cross-platform compatible (Linux, macOS, Windows via Bun)

## File Structure
```
src/
├── cli.ts           # Entry point — parses args and dispatches commands
├── args.ts          # Argument parser
├── commands/
│   └── index.ts     # Command registry
```

## Quality Checklist
- [ ] All commands have --help documentation
- [ ] Exit codes are meaningful (0 = success, 1 = error, 2 = usage error)
- [ ] JSON output mode works for all commands
- [ ] Error messages are user-friendly
- [ ] No unhandled promise rejections
