# Chat Screen Input Taxonomy

## Verification Commands
- `node src/cli.js research chat-states --limit 40 --filter 有简历`
- `node src/cli.js research chat-screen-inputs --limit 10 --filter 有简历`

## Current Validated Output
- File:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\chat-screen-inputs-1776766919422.json`
- Summary:
  - `schemaVersion = liepin_chat_screen_input_v1`
  - `observedRows = 30`
  - `screenableRows = 10`
  - `uniqueScreenableCandidates = 10`
  - `allHaveRequestResumeButton = true`
  - `allMissingRequiredSourceIds = []`

## Observed Chat States

### `索要简历`
- Example action labels:
  - `索要手机`
  - `索要微信`
  - `索要简历`
- Screening status:
  - `screenable`
- Phase note:
  - This is the only chat state that should invoke LLM screening in production.

### `索要中`
- Example action labels:
  - `索要中`
  - or exact fallback text `已向对方索要`
- Screening status:
  - `skip`
- Phase note:
  - Must move on directly without LLM screening.

### `看简历`
- Example action labels:
  - `手机号`
  - `索要微信`
  - `看简历`
- Screening status:
  - `skip`
- Phase note:
  - Already has accessible resume detail; per user rule, this should not enter chat screening.

### System row: `收到简历 已为您筛选出投递人选`
- Current normalized state in tooling:
  - `浏览简历`
- Screening status:
  - `skip`
- Caveat:
  - This row can duplicate inside `有简历` filter and should not be treated as a normal candidate conversation without extra guarding.

## `ChatScreenInput` Schema
- Schema version:
  - `liepin_chat_screen_input_v1`
- Required audited source ids:
  - `conversation_row`
  - `chat_header`
  - `header_resume_summary`
  - `message_list`
  - `action_bar`
- Additional validated source ids:
  - `header_basic_info`
  - `header_user_info`
  - `header_ext_info`
  - `header_ext_content`

## Source Definitions
- `conversation_row`:
  - Left conversation list item text and stable `rowKey`.
- `chat_header`:
  - Full active chat header text.
- `header_basic_info`:
  - Candidate name/activity/job-seeking status/location/age/degree/graduation or experience summary.
- `header_user_info`:
  - Candidate info subset excluding name/activity when DOM provides it separately.
- `header_resume_summary`:
  - Recent company/job, school/major, communication job, and job expectation.
- `header_ext_info` / `header_ext_content`:
  - Redundant DOM sources for resume summary; retained for drift resilience.
- `message_list`:
  - Visible conversation messages and read/unread labels.
- `action_bar`:
  - Visible chat actions such as `索要手机`, `索要微信`, `索要简历`, `约面试`.

## Current `resume/detail` Input Shape
- Verified from live `看简历 -> resume/detail`:
  - `job_intent`
  - `work_experience`
  - `education`
  - `certificates`
  - `languages`
  - `extra_info`
- Newly observed after sampler hardening:
  - `project_experience`
  - `skills`
  - `attachment_resume`
  - gated attachment controls such as `预览` / `下载`

## Learnings
- `有简历` filter can still show candidates whose active action is `索要简历`; the button state is the source of truth for chat screening.
- `索要简历` candidates can expose a `查看简历` string in the header, but the bottom action bar still indicates full resume is not acquired.
- P13 collected 10 unique `索要简历` candidates without clicking any request button.

## Gaps / Next
- P14 formalized state classification:
  - `索要简历` => screenable
  - `索要中`, `看简历`, `浏览简历`, system row, `UNKNOWN` => skip
- Latest audit:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\chat-policy-audit-1776767095859.json`
  - 30 rows, 11 screenable, 19 skip, 0 violations.
