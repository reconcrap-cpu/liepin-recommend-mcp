# Liepin Recommend MCP

Liepin Recommend MCP is a Node.js MCP/CLI helper for researching and operating Liepin recommend and chat workflows through a Chrome DevTools debugging port.

## Install

```sh
npm install -g @reconcrap/liepin-recommend-mcp
```

## Usage

```sh
liepin-recommend-mcp doctor --json
liepin-recommend-mcp install
liepin-recommend-mcp self-heal --provider-check
liepin-recommend-mcp skill export --format markdown
liepin-recommend-mcp external-agent config
liepin-recommend-mcp research discover --debug-port 9222
```

Chrome must already be running with a remote debugging port, for example `9222`, and the operator must be logged in to Liepin in that browser profile.

## Safety Notes

- The automation is designed to preserve list state and avoid refreshes or hard navigation when returning from details.
- Browser automation is background-safe and does not call `Page.bringToFront`.
- Real outreach or resume-request actions should only be run with explicit operator approval.

## Development

```sh
npm install
npm test
```
