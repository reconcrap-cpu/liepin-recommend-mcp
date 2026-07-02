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
liepin-mcp chat start --candidate-limit all --job "全部职位" --unread-only false --criteria "聊天筛选条件"
liepin-mcp chat start --candidate-limit all --job "全部职位" --unread-only false
liepin-mcp search start --profile "测试" --job "招聘实习生" --hide-read true --candidate-limit 5 --criteria "搜索筛选条件"
liepin-mcp recommend-chat start --candidate-limit 5 --scan-limit 10 --recommend-criteria "推荐筛选条件" --chat-criteria "聊天筛选条件"
liepin-mcp runs progress --kind chat --include-completed false
```

Doctor/start preflight will automatically handle fixable environment issues: install missing npm dependencies, open Chrome with the configured remote debugging port, and navigate to the target Liepin page (`recommend`, `search`, or `chat`). The operator is only needed for issues that cannot be solved safely by automation, such as Liepin login, captcha/risk pages, or filling real LLM config values.

`recommend/chat/recommend-chat start` now default to production behavior:
- real recommend chat clicks are enabled by default,
- real request-resume clicks are enabled by default.

For chat start, `--candidate-limit` accepts a positive integer or all-candidates expressions such as `all`, `全部`, `所有`, and `扫到底`; all-candidates mode scans until the chat list bottom/platform limit. If `--criteria` is omitted or blank, chat runs enter `collect_cv` mode: they skip LLM screening, treat existing `索要中`/request-message states as already requested, and click `索要简历` only for candidates that have not been requested yet. Chat runs default to the Boss-compatible aggressive rest policy (`rest_level=high`); collect-CV pauses 5-8 seconds after each candidate. Override with `--rest-level low|medium|high`, MCP `human_behavior.restLevel`, or `SOURCING_LIEPIN_CHAT_REST_LEVEL`.

Use `--execute-request-resume false` or a dry-run workflow when you need no-side-effect validation.

Use the MCP tool `liepin_run_progress` to query progress across recommend, search, chat, and recommend-chat runs. Pass `run_id` for one run, or omit it to list recent runs with optional `kind`, `limit`, and `include_completed` filters.

### Long-run robustness

Long-run recovery is enabled by default in the official release:

```sh
liepin-mcp recommend-chat start --candidate-limit 5 --scan-limit 10
liepin-mcp search start --profile "测试" --job "招聘实习生" --hide-read true --candidate-limit 5 --criteria "搜索筛选条件"
liepin-mcp chat start --candidate-limit all --job "全部职位" --unread-only false
```

Modes:
- `recover`: default long-run behavior with heartbeat, timing, additive checkpoint metadata, and bounded safe-boundary recovery.
- `observe`: records heartbeat, candidate timing, phase timing, and additive checkpoint metadata.
- `off`: rollback-safe legacy behavior.

Rollback is immediate: start the next run with `--robustness-mode off` or pin the package back to `@reconcrap/liepin-mcp@0.1.28`.

## Safety Notes

- The automation is designed to preserve list state and avoid refreshes or hard navigation when returning from details.
- Browser automation is background-safe and does not call `Page.bringToFront`.
- Real outreach or resume-request actions should only be run with explicit operator approval.

## Development

```sh
npm install
npm test
```
