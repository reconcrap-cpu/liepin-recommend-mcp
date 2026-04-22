# Liepin Recommend MCP Roadmap

## Fresh Instance Startup Protocol
1. Read this file.
2. Read [phase-index.md](./phase-index.md).
3. Read the most recent `PASSED` phase handoff in [phases](./phases/).
4. Read the current target phase's prerequisites and acceptance gate before coding.

## Phase Ordering Rules
- A phase may start only if the immediately previous phase is marked `PASSED`.
- Every selector and page interaction must be validated against live Chrome `9222`.
- Every phase must end with a markdown handoff containing: goal, actual changes, live validation evidence, tests, learnings, pitfalls, next-phase notes.
- If new DOM structures or interaction variants are discovered, update the corresponding research markdown before continuing implementation.

## Runtime Conventions
- Package: `@reconcrap/liepin-recommend-mcp`
- CLI: `liepin-recommend-mcp`
- Runtime home: `~/.liepin-recommend-mcp/`
- Current implementation focus: `P00` through research-heavy early phases. Later product and screening phases stay gated until research phases pass.
