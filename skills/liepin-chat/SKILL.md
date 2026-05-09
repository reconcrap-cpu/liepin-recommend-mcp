---
name: "liepin-chat"
description: "Use when users want chat-only screening on Liepin chat page via @reconcrap/liepin-mcp."
---

# Liepin Chat Skill

## Goal

当用户只在猎聘聊天页执行筛选（chat-only）时，走本 skill 并在启动前严格确认必要参数，禁止缺参直跑。

若用户意图包含“先推荐页筛选，再进入聊天”，必须切换到 `liepin-recommend-pipeline`。

## Tool Routing

- 启动前检查：`liepin_doctor`（必须传 `target_page="chat"`, `require_chat_page=true`, `fix=true`；必要时 `provider_check=true`）
- 聊天页可选项：`liepin_chat_options`（用于岗位列表和当前“未读”状态）
- 启动聊天筛选：`liepin_chat_start`（chat-only 参数确认完成后唯一允许调用的启动工具）
- 进度/控制：`liepin_run_progress`（统一查询推荐/搜索/chat 进度）/ `liepin_run_status` / `liepin_run_pause` / `liepin_run_resume` / `liepin_run_cancel`
- 环境修复：`liepin_install` / `liepin_self_heal`

## Hard Rules (Must Follow)

- 只要是 chat-only 任务，必须在启动前确认所有必填参数，不能靠默认值直接启动。
- 每次新的 chat start 前必须先通过 `liepin_doctor(target_page="chat", require_chat_page=true, fix=true)`，且 `screening-config.json` 的 `baseUrl/apiKey/model` 不能是占位值。
- doctor 若发现依赖缺失、Chrome debug 端口未打开、或当前不在聊天页，应先让 doctor 自动修复/打开/导航，不要要求用户手动打开目标页。
- 只有 doctor 返回无法自动解决的问题时才寻求用户帮助；例如猎聘未登录时，请提示用户在自动打开的 Chrome 中完成登录。
- 用户反馈已登录后，继续同一任务：重新调用 `liepin_doctor(target_page="chat", require_chat_page=true, fix=true)`；若登录后仍不在聊天页，doctor 会自动导航，再继续参数确认/启动。
- chat 页面只有一个页面筛选开关：是否只扫“未读”（`unread_only`）。不要询问推荐页筛选项、日期范围、3 天内等 chat 页面不存在的 filter，也不要调用 `liepin_recommend_filter_options`。
- 不要把页面筛选和 AI 筛选标准混在一起：`criteria` 仍然必须由用户给出，用于判断候选人是否符合要求。
- 禁止 agent 自行补齐 `candidate_limit/job/unread_only/criteria` 后直接执行；必须由用户明确给出或确认。
- `liepin_chat_start` 只能在参数齐全且用户明确“确认启动”后调用。
- 用户确认 `candidate_limit/job/unread_only/criteria` 后，必须调用 `liepin_chat_start`，严禁调用 `liepin_recommend_start` 或 `liepin_recommend_chat_start`。
- 如果下一步准备调用的工具名不是 `liepin_chat_start`，立即停止并改为 `liepin_chat_start`。
- 拿到 `ACCEPTED + run_id` 后默认停止本轮，不自动高频轮询；用户要求查进度时优先调用 `liepin_run_progress`，有明确 `run_id` 时传入该 `run_id`。
- 用户要求长时间无人值守、鲁棒性 canary、性能对比或 heartbeat 时，传 `robustness_mode="observe"`；默认不传或传 `off` 以保持当前稳定行为。

## Required Inputs

必须确认：

- `candidate_limit`（筛选人数）
- `job`（聊天页岗位；先用 `liepin_chat_options` 读取可选岗位）
- `unread_only`（是否只扫“未读”：true/false）
- `criteria`（开放式筛选条件，自然语言）

`candidate_limit` 可以是正整数，也可以是全量扫描表达。用户说 `all`、`全部`、`所有`、`扫到底`、`扫完`、`扫完所有人选`、`扫描全部候选人`、`直到列表底部` 等意思时，传给 `liepin_chat_start` 的 `candidate_limit` 使用 `"all"` 或用户原词，表示扫完所有可见候选人直到列表底部/平台上限；不要再要求用户改成具体整数。

可选但建议确认：

- `scan_limit`
- `max_chars`
- `robustness_mode`：仅在用户要测试长跑鲁棒性/性能 canary 时传 `"observe"`。

## Response Style

- 用结构化中文。
- 缺参时逐项提问并等待回复，不要一次性代填默认值。
- 明确回显即将提交给 `liepin_chat_start` 的参数，等待用户确认后再启动。
