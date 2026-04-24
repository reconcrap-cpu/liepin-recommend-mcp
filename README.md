# Liepin Recommend MCP

Liepin Recommend MCP is a Node.js MCP/CLI helper for researching and operating Liepin recommend and chat workflows through a Chrome DevTools debugging port.

## Install

```sh
npm install -g @reconcrap/liepin-mcp
liepin-mcp install --agent trae-cn
```

`install` will:
- bootstrap runtime folders and `screening-config.json` template,
- merge MCP server config into detected external agent config files (Cursor/Trae/Trae-CN/Claude/OpenClaw),
- mirror bundled skills into detected external `skills` directories.

## Usage

```sh
liepin-mcp doctor --fix --target-page recommend
liepin-mcp install
liepin-mcp install --agent openclaw
liepin-mcp self-heal --target-page recommend --provider-check
liepin-mcp skill export --format markdown
liepin-mcp external-agent config
liepin-mcp research discover --debug-port 9222
liepin-mcp recommend start --candidate-limit 5 --scan-limit 10 --recommend-criteria "推荐筛选条件" --chat-criteria "聊天筛选条件"
liepin-mcp chat start --candidate-limit 5 --scan-limit 10 --recommend-criteria "推荐筛选条件" --chat-criteria "聊天筛选条件"
liepin-mcp recommend-chat start --candidate-limit 5 --scan-limit 10 --recommend-criteria "推荐筛选条件" --chat-criteria "聊天筛选条件"
```

Doctor/start preflight will automatically handle fixable environment issues: install missing npm dependencies, open Chrome with the configured remote debugging port, and navigate to the target Liepin page (`recommend`, `search`, or `chat`). The operator is only needed for issues that cannot be solved safely by automation, such as Liepin login, captcha/risk pages, or filling real LLM config values.

`recommend/chat/recommend-chat start` now default to production behavior:
- real recommend chat clicks are enabled by default,
- real request-resume clicks are enabled by default.

Use `--execute-request-resume false` or a dry-run workflow when you need no-side-effect validation.

## Safety Notes

- The automation is designed to preserve list state and avoid refreshes or hard navigation when returning from details.
- Browser automation is background-safe and does not call `Page.bringToFront`.
- Real outreach or resume-request actions should only be run with explicit operator approval.

## Development

```sh
npm install
npm test
```
