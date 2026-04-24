---
name: "liepin-search"
description: "Use when users want Liepin search-page screening/outreach via @reconcrap/liepin-mcp."
---

# Liepin Search Skill

## Goal

当用户要在猎聘搜索页执行“快捷搜索 profile -> 简历筛选 -> 符合则立即沟通”的流程时，必须走本 skill。

本流程会真实点击“立即沟通”，并在开聊职位弹窗中选择用户指定岗位后确认。真实操作默认执行，不需要额外询问“是否真的执行”。

推荐页任务应交给 `liepin-recommend-pipeline`；chat-only 任务应交给 `liepin-chat`。

## Tool Routing

- 启动前检查：`liepin_doctor`（搜索页不要求推荐页或聊天页；必要时 `provider_check=true`）
- 搜索页可选项：`liepin_search_options`
- 搜索页筛选并沟通：`liepin_search_start`
- 进度/控制：`liepin_run_status` / `liepin_run_pause` / `liepin_run_resume` / `liepin_run_cancel`
- 环境修复：`liepin_install` / `liepin_self_heal`

## Hard Rules (Must Follow)

- **Preflight 强制**
  - 每次新的 `liepin_search_start` 前必须先做 `liepin_doctor` 检查，确认 Chrome debug port、LLM config、风控状态可用。
  - `screening-config.json` 的 `baseUrl/apiKey/model` 必须都是真实值，不能是模板占位值。
  - 如果 doctor 发现风控/验证码页，禁止启动 run。

- **选项发现强制**
  - 启动前必须调用 `liepin_search_options`。
  - 必须把返回的所有 `profiles[].title` 列出来让用户选择 `profile`。
  - 必须把返回的所有 `jobs[].title` 列出来让用户选择 `job`。
  - 不要自己编造 profile 或 job；只能用 `liepin_search_options` 返回的值，或用户明确给出的可匹配简称。

- **参数确认强制**
  - `profile`：快捷搜索 profile。
  - `job`：用于搜索页职位选择与“请选择开聊职位”弹窗。
  - `candidate_limit`：目标通过并完成沟通的人数，不是扫描人数。
  - `criteria`：AI 简历筛选标准，自然语言，必须由用户给出。
  - `scan_limit` 默认不要传；不传表示不限制扫描上限，只受目标通过人数或最后一页限制。只有用户明确要求限制扫描人数时才传。

- **真实操作默认执行**
  - 默认允许 `allow_chat_action=true`。
  - 不要再询问“是否点击立即沟通”。
  - 只有用户主动要求 dry-run 或不要触达候选人时，才不要启动正式 `liepin_search_start`。

- **异步 run 行为**
  - `liepin_search_start` 是 async workflow。拿到 `ACCEPTED + run_id` 后默认停止本轮，不自动高频轮询。
  - 只有用户要求查进度时才调用 `liepin_run_status`。

## What The Workflow Does

`liepin_search_start` 会：

- 连接猎聘搜索页。
- 选择用户指定职位，并确保职位下拉中的 checkbox 全部 unticked。
- 点击用户指定快捷搜索 profile。
- 逐个打开搜索结果候选人详情 modal。
- 抽取完整简历，交给 LLM 根据 `criteria` 判断。
- 若 LLM 返回 `pass + chat`，点击“立即沟通”，选择用户指定岗位并确认。
- 关闭候选人详情 modal，继续下一位。
- 翻页直到达到 `candidate_limit` 或 next page disabled。

## Example Start Arguments

```json
{
  "debug_port": 9223,
  "profile": "测试",
  "job": "招聘实习生",
  "candidate_limit": 3,
  "criteria": "必须有 HR 实习经验",
  "allow_chat_action": true
}
```

不要传 `scan_limit`，除非用户明确要求扫描上限。

## Response Style

- 用中文。
- 先给 preflight 结果，再列出 `liepin_search_options` 的 profile/job 选项。
- 参数齐全后直接启动，不额外询问真实操作确认。
- 启动成功后回传 `run_id`，提醒用户可用 `liepin_run_status` 查进度。
