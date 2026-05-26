---
name: "liepin-recommend-pipeline"
description: "Use when users want Liepin recommend-page screening or recommend->chat chaining via @reconcrap/liepin-mcp."
---

# Liepin Recommend Pipeline Skill

## Goal

当用户要在猎聘推荐页执行筛选，或要做“推荐后衔接聊天”的串联流程时，必须走 `@reconcrap/liepin-mcp`。启动前必须确认业务参数；真实操作默认执行，不需要额外问“是否执行真实操作”。

chat-only 任务（只跑聊天页筛选，不经过推荐页）应交给 `liepin-chat` skill，不要在本 skill 里直接走 `liepin_chat_start`。

## Tool Routing

- 启动前检查：`liepin_doctor`（必须传 `target_page="recommend"`, `fix=true`；必要时 `provider_check=true`）
- 推荐页筛选条件选项：`liepin_recommend_filter_options`
- 推荐页筛选：`liepin_recommend_start`
- 推荐后衔接聊天：`liepin_recommend_chat_start`
- 进度/控制：`liepin_run_progress`（统一查询推荐/搜索/chat 进度）/ `liepin_run_status` / `liepin_run_pause` / `liepin_run_resume` / `liepin_run_cancel`
- 环境修复：`liepin_install` / `liepin_self_heal`

## Hard Rules (Must Follow)

- **路由护栏**
  - 推荐页筛选或推荐后串联聊天：只能走本 skill。
  - chat-only 语义（例如“只在聊天页筛选”）：必须切换 `liepin-chat`，不要在这里启动 `liepin_recommend_start` / `liepin_recommend_chat_start`。
  - 如果用户已经给出 `job` + `unread_only` + `criteria` 这组聊天页参数，下一步必须是 `liepin_chat_start`，严禁用 `liepin_recommend_start` 承接。

- **Preflight 强制**
  - 每次新的 `start` 之前必须先做 `liepin_doctor(target_page="recommend", fix=true)` 检查，确认环境可用。
  - doctor 若发现依赖缺失、Chrome debug 端口未打开、或当前不在推荐页，应先自动安装/打开/导航到推荐页，不要要求用户手动打开目标页。
  - `screening-config.json` 的 `baseUrl/apiKey/model` 必须都是真实值，不能是模板占位值（例如 `https://your-llm-endpoint.example.com/v1`、`replace-with-real-api-key`、`your-model-name`）。
  - 当 doctor 提示配置缺失或占位值未替换时，禁止启动 run；先要求用户修改，并在用户明确回复“已修改完成”后重跑 doctor。
  - 只有 doctor 返回无法自动解决的问题时才寻求用户帮助；例如猎聘未登录时，请提示用户在自动打开的 Chrome 中完成登录。
  - 用户反馈已登录后，继续同一任务：重新调用 `liepin_doctor(target_page="recommend", fix=true)`；若登录后仍不在推荐页，doctor 会自动导航，再继续参数确认/启动。

- **参数确认（强制）**
  - 缺少筛选条件时，必须先调用 `liepin_recommend_filter_options`，把返回的可用筛选字段和选项展示给用户选择。
  - `filter` 是猎聘页面筛选条件，不是 AI 筛选标准。不要把 `criteria` / `recommend_criteria` / `chat_criteria` 当作 `filter`。
  - 用户未明确回复前，不能把“已确认”视为 true。
  - 若存在缺参，必须逐项提问并等待回复，不得跳过。
  - 用户明确说“沿用页面当前筛选 / 不额外筛选”时，`filter` 传 `沿用页面当前筛选`。
  - 用户给出筛选条件时，`filter` 可以传 JSON 或自然语言，例如：`学历=本科、硕士; 年龄=22-30; 院校=985、211`。

- **启动门禁（强制）**
  - 在 `liepin_recommend_start` / `liepin_recommend_chat_start` 前，必须完成对应必填参数确认。
  - 禁止把 `candidate_limit/filter/criteria/recommend_criteria/chat_criteria` 留空后直接启动。

- **真实操作默认执行（强制）**
  - 不要再询问“是否执行真实操作”。
  - 推荐到聊天串联默认传或默认使用 `allow_chat_action=true`。
  - 默认执行索要简历：`execute_request_resume=true` 且 `allow_request_resume=true`。
  - 只有用户主动要求 dry-run 或不执行某类动作时，才显式传 false。

- **异步 run 行为**
  - 拿到 `ACCEPTED + run_id` 后默认停止本轮，不自动高频轮询。
  - 只有用户要求查进度时才调用 `liepin_run_progress`；有明确 `run_id` 时传入该 `run_id`。
  - 长跑鲁棒性默认启用 `robustness_mode="recover"`；默认不传即可使用 recover。只有需要复现旧行为时才显式传 `robustness_mode="off"`，需要只记录不恢复时传 `robustness_mode="observe"`。

## Required Inputs

### Recommend Start (`liepin_recommend_start`)

必须确认：

- `candidate_limit`（筛选人数）
- `tab`（如 `推荐` / `最新`）
- `filter`（猎聘页面筛选条件；先提供 `liepin_recommend_filter_options` 的字段/选项让用户选择；若不额外筛选则写“沿用页面当前筛选”）
- `criteria`（开放式筛选条件，自然语言）

### Recommend -> Chat (`liepin_recommend_chat_start`)

必须确认：

- `candidate_limit`（目标通过人选数，不是扫描/处理人数）
- `scan_limit`（是否限制扫描上限；可空）
- `tab`
- `filter`（推荐侧猎聘页面筛选条件；先提供 `liepin_recommend_filter_options` 的字段/选项让用户选择）
- `recommend_criteria`
- `chat_criteria`

可选：`robustness_mode`。正式默认值是 `"recover"`；只有用户要复现旧行为时传 `"off"`，要做 observe 对照时传 `"observe"`。

## Question Style

- 封闭式字段给出明确选项，尤其是 `filter` 的字段和选项。
- 开放式字段（`criteria`）保持自由输入，不要用“严格/宽松”等模板词替代用户原文。
- 有历史已确认值时不重复问，只补缺口。

## Response Style

- 用结构化中文。
- 先给 preflight 结果，再给参数确认清单；参数齐全后直接启动，不额外询问真实操作确认。
