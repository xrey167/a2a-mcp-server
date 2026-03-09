# Dev Tools — MCP Server Variant

**Pipeline**: mcp-server
**Category**: Developer Experience
**Complexity**: Medium

---

## Description

An MCP server that provides developer-focused tools: code analysis, file manipulation, linting, formatting, git operations, or project scaffolding utilities.

---

## Ideal For

- Code formatters / linters
- Git workflow tools
- Project scaffolding utilities
- Documentation generators
- Test runners / coverage tools
- Dependency analyzers

---

## Pre-Configured Features

- File system tools (read, write, list, search)
- Shell command execution with timeout
- Output parsing and structured results
- Working directory management
- Tool chaining support (output of one feeds another)

---

## Usage

**Prompt Enhancement:**
- Add file system tools with path validation (no directory traversal)
- Add shell execution with configurable timeout and working directory
- Add output parsing that extracts structured data from CLI output
- Add tool for searching files by content (grep-like)
- Add tool for analyzing project structure (package.json, configs)
- Ensure all file paths are validated against allowed directories

---

## Quality Checklist

- [ ] File operations validate paths (no ../ traversal)
- [ ] Shell commands respect timeout limits
- [ ] Output is structured (not raw stdout dumps)
- [ ] Error messages include actionable context
- [ ] Tools handle missing files/directories gracefully
- [ ] Working directory is properly scoped
- [ ] No arbitrary code execution without sandboxing
