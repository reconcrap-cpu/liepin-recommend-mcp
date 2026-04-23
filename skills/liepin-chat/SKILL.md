---
name: "liepin-chat"
description: "Use when users want chat-only screening on Liepin chat page via liepin-recommend-mcp."
---

# Liepin Chat Skill

## Goal

当用户只在猎聘聊天页执行筛选（chat-only）时，走本 skill 并在启动前严格确认必要参数，禁止缺参直跑。

若用户意图包含“先推荐页筛选，再进入聊天”，必须切换到 `liepin-recommend-pipeline`。

## Tool Routing

- 启动前检查：`liepin_doctor`（必要时 `provider_check=true`）
- 启动聊天筛选：`liepin_chat_start`
- 进度/控制：`liepin_run_status` / `liepin_run_pause` / `liepin_run_resume` / `liepin_run_cancel`
- 环境修复：`liepin_install` / `liepin_self_heal`

## Hard Rules (Must Follow)

- 只要是 chat-only 任务，必须在启动前确认所有必填参数，不能靠默认值直接启动。
- 每次新的 chat start 前必须先通过 doctor，且 `screening-config.json` 的 `baseUrl/apiKey/model` 不能是占位值。
- 禁止 agent 自行补齐 `candidate_limit/filter/criteria` 后直接执行；必须由用户明确给出或确认。
- `liepin_chat_start` 只能在参数齐全且用户明确“确认启动”后调用。
- 拿到 `ACCEPTED + run_id` 后默认停止本轮，不自动高频轮询。

## Required Inputs

必须确认：

- `candidate_limit`（筛选人数）
- `filter`（聊天列表 filter，例如 `有简历`）
- `criteria`（开放式筛选条件，自然语言）

可选但建议确认：

- `row_limit`
- `max_scroll_passes`

## Response Style

- 用结构化中文。
- 缺参时逐项提问并等待回复，不要一次性代填默认值。
- 明确回显即将提交的参数，等待用户确认后再启动。
