# Content Generator — Agent Variant

**Pipeline**: agent
**Category**: AI / Content
**Complexity**: Medium

---

## Description

An AI agent specialized in generating, editing, and managing content. Uses Claude for text generation with tools for research, formatting, and publishing.

---

## Ideal For

- Blog post generators
- Social media content agents
- Documentation writers
- Email campaign generators
- Product description writers
- Newsletter curators
- Translation agents

---

## Pre-Configured Features

- Content generation with configurable tone/style
- Research tools (web search, content extraction)
- Template system for consistent formatting
- Draft management (save, edit, publish)
- Multi-format output (markdown, HTML, plain text)
- SEO optimization tools

---

## Usage

**Prompt Enhancement:**
- Add content generation tool with tone, length, and format parameters
- Add web research tool for gathering source material
- Add content template system with variables
- Add draft storage with SQLite persistence
- Add formatting tool (markdown → HTML, text cleanup)
- Add SEO analysis tool (keyword density, readability score)
- Add publish tool for outputting final content to files

---

## Quality Checklist

- [ ] Generated content matches requested tone and length
- [ ] Research tool returns relevant, non-hallucinated sources
- [ ] Templates produce consistent formatting
- [ ] Drafts persist across agent restarts
- [ ] Multiple output formats render correctly
- [ ] SEO suggestions are actionable
- [ ] Agent handles "revise" instructions without losing context
