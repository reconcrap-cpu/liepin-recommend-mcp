---
name: "liepin-recommend-pipeline"
description: "Use when users want Liepin recommend/chat screening workflows via liepin-recommend-mcp."
---

# Liepin Recommend Pipeline Skill

## Goal

当用户要在猎聘推荐页/聊天页执行筛选流程时，统一走 `liepin-recommend-mcp`，优先使用异步 run 命令并通过 `runs status/list` 跟踪进度。

## Routing Rules

- 推荐页筛选：`recommend start`
- 聊天页筛选：`chat start`
- 推荐后联动聊天：`recommend-chat start`
- 环境修复：`doctor` / `self-heal`

## Safety Rules

- 真实沟通点击前，必须显式确认并传 `--allow-chat-action`。
- 真实索要简历前，必须显式确认并传 `--allow-request-resume`。
- 未准备好配置时，先执行 `install`，并补齐 `screening-config.json` 的 `baseUrl/apiKey/model`。

## Bootstrap

- 安装/补齐运行资产：`liepin-recommend-mcp install`
- 健康检查：`liepin-recommend-mcp doctor --debug-port 9222`
- 自愈：`liepin-recommend-mcp self-heal`

## External Agents

- `install` 会自动将 MCP 配置写入已检测到的 Cursor/Trae(含 trae-cn)/Claude/OpenClaw 配置路径。
- `install` 会自动镜像 skill 到上述客户端的 `skills` 目录（若目录存在或显式指定 `--agent`）。
- 可用环境变量自定义落盘路径：
  - `LIEPIN_MCP_CONFIG_TARGETS`
  - `LIEPIN_EXTERNAL_SKILL_DIRS`
