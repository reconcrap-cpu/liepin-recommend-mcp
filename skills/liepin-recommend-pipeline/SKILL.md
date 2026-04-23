---
name: "liepin-recommend-pipeline"
description: "Use when users want Liepin recommend-page screening or recommend->chat chaining via liepin-recommend-mcp."
---

# Liepin Recommend Pipeline Skill

## Goal

当用户要在猎聘推荐页执行筛选，或要做“推荐后衔接聊天”的串联流程时，必须走 `liepin-recommend-mcp` 并执行“先确认参数 -> 再启动 run”。

chat-only 任务（只跑聊天页筛选，不经过推荐页）应交给 `liepin-chat` skill，不要在本 skill 里直接走 `liepin_chat_start`。

## Tool Routing

- 启动前检查：`liepin_doctor`（必要时 `provider_check=true`）
- 推荐页筛选：`liepin_recommend_start`
- 推荐后衔接聊天：`liepin_recommend_chat_start`
- 进度/控制：`liepin_run_status` / `liepin_run_pause` / `liepin_run_resume` / `liepin_run_cancel`
- 环境修复：`liepin_install` / `liepin_self_heal`

## Hard Rules (Must Follow)

- **路由护栏**
  - 推荐页筛选或推荐后串联聊天：只能走本 skill。
  - chat-only 语义（例如“只在聊天页筛选”）：必须切换 `liepin-chat`，不要在这里启动 `liepin_recommend_start` / `liepin_recommend_chat_start`。

- **Preflight 强制**
  - 每次新的 `start` 之前必须先做 `liepin_doctor` 检查，确认环境可用。
  - `screening-config.json` 的 `baseUrl/apiKey/model` 必须都是真实值，不能是模板占位值（例如 `https://your-llm-endpoint.example.com/v1`、`replace-with-real-api-key`、`your-model-name`）。
  - 当 doctor 提示配置缺失或占位值未替换时，禁止启动 run；先要求用户修改，并在用户明确回复“已修改完成”后重跑 doctor。

- **确认不可代填（强制）**
  - 禁止 agent 自行补默认参数并直接启动。
  - 用户未明确回复前，不能把“已确认”视为 true。
  - 若存在缺参，必须逐项提问并等待回复，不得跳过。

- **启动门禁（强制）**
  - 在 `liepin_recommend_start` / `liepin_recommend_chat_start` 前，必须完成对应必填参数确认，并做一次最终确认。
  - 禁止把 `candidate_limit/filter/criteria/recommend_criteria/chat_criteria/allow_chat_action/allow_request_resume` 留空后直接启动。

- **副作用确认（强制）**
  - 涉及真实点击推荐沟通：必须显式确认并传 `allow_chat_action=true`。
  - 涉及真实索要简历：必须显式确认并传 `allow_request_resume=true`。

- **异步 run 行为**
  - 拿到 `ACCEPTED + run_id` 后默认停止本轮，不自动高频轮询。
  - 只有用户要求查进度时才调用 `liepin_run_status`。

## Required Inputs

### Recommend Start (`liepin_recommend_start`)

必须确认：

- `candidate_limit`（筛选人数）
- `tab`（如 `推荐` / `最新`）
- `filter`（筛选口径；若不额外筛选也要明确写“沿用页面当前筛选”）
- `criteria`（开放式筛选条件，自然语言）

### Recommend -> Chat (`liepin_recommend_chat_start`)

必须确认：

- `candidate_limit`
- `scan_limit`（是否限制扫描上限；可空）
- `tab`
- `filter`（推荐侧筛选口径）
- `recommend_criteria`
- `chat_criteria`
- 是否执行真实聊天点击（若是，`allow_chat_action=true`）
- 是否执行真实索要简历（若是，`execute_request_resume=true` 且 `allow_request_resume=true`）

## Question Style

- 封闭式字段给出明确选项（例如是否执行真实操作）。
- 开放式字段（`criteria`）保持自由输入，不要用“严格/宽松”等模板词替代用户原文。
- 有历史已确认值时不重复问，只补缺口。

## Response Style

- 用结构化中文。
- 先给 preflight 结果，再给参数确认清单，最后等待用户明确“确认启动”后再调用 start。
