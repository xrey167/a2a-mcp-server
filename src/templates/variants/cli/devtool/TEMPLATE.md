# CLI Variant: Developer Tool

## Description
A developer productivity tool with commands for project scaffolding, code generation, linting helpers, and workflow automation.

## Ideal For
- Developer productivity tools
- Build system helpers
- Code generation utilities
- Project management CLIs
- DevOps automation tools

## Additional Features
- Project scaffolding with interactive prompts
- Configuration file management (read/write YAML/JSON/TOML)
- Git integration helpers
- Watch mode for file change detection
- Plugin system for extensibility

## Additional Tech Stack
- **Config:** JSON/YAML file handling
- **Git:** Simple git operations via child_process
- **Watch:** Bun file watcher

## Prompt Enhancement
When generating a devtool CLI, ensure commands follow Unix philosophy: each command does one thing well, supports piping via --json output, and provides clear --help documentation. Include a `config` command for managing tool settings and an `init` command for project setup.

## Quality Checklist
- [ ] init command creates a valid config file
- [ ] config command supports get/set/list/reset operations
- [ ] All commands support --json output for scripting
- [ ] Watch mode properly debounces file changes
- [ ] Git operations validate repository state before acting
