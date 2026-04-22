# Selector Ledger

## Verification Commands
- `node src/cli.js doctor --json`
- `node src/cli.js research discover --debug-port 9222`
- `node src/cli.js research acquisition-probe --debug-port 9222`
- `node src/cli.js research chat-states --limit 12 --filter 有简历`

## Verified Live Selectors

### Recommend
- Candidate card: `[class*="newResumeItemWrap"]`
- Tab label: `.ant-lpt-segmented-item-label` with exact text match on `推荐` / `最新`
- Modal root: `[class*="resume-detail-modal-wrap"]`
- Modal printable body: `[class*="resume-detail-modal-wrap"] .resume-detail-content-body.printable-content`
- Next candidate: `.button-turn-next`
- Close button: `[class*="resume-detail-modal-wrap"] [class*="closeBtn"]`
- Open chat button: `[class*="resume-detail-modal-wrap"] [class*="xpath-open-im-btn"]`
- Recommend welcome popover after direct chat: `.popover-welcome-msg-body`, `.ant-lpt-popover.popover-welcom-msg`
- Recommend sent-greeting modal: `.im-ui-recommend-chat-modal`
- Recommend sent-greeting modal close: `.im-ui-recommend-chat-modal .ant-im-modal-close`
- Recommend same-page basic chat modal: `.im-ui-basic-chat-modal`, `.im-ui-chat-modal-container`
- Recommend basic chat header name: `.im-ui-basic-chat-header-name`
- Recommend basic chat header basic info: `.im-ui-basic-chat-header-basic-info-content`
- Recommend basic chat jump button: `.im-ui-basic-chat-header-jump-btn`
- Recommend basic chat request resume button: `.im-ui-action-button.action-item.action-resume`
- Filter entry button: `button` with exact text `筛选`
- Filter drawer root: `.ant-lpt-drawer-open`
- Filter drawer body: `.ant-lpt-drawer-body`
- Filter group: `.filterItems--XYlh8`
- Filter group title: `.itemTitle--y3zfr`
- Filter tag option: `.ant-lpt-tag-checkable`
- Filter checked class: `ant-lpt-tag-checkable-checked`
- Filter reset button: `.ant-lpt-drawer-open button` with exact text `重置`
- Filter apply button: `.ant-lpt-drawer-open button` with exact text `确定`
- Filter drawer close: `.ant-lpt-drawer-close`
- Age filter inputs: `.filterItems--XYlh8 input`, placeholders `最低` / `最高`

### Chat
- Conversation row: `.im-ui-contact-list-item.im-ui-contact-item`
- Top segmented filter label: `.ant-im-segmented-item-label`
- Resume action button: `.im-ui-action-button.action-item.action-resume`
- Generic action buttons: `.im-ui-action-button.action-item`
- State fallback scan: `button, a, span, div` with exact text extraction for `索要简历` / `索要中` / `看简历` / `浏览简历` / `已向对方索要`
- Chat container: `.im-ui-chat-container`
- Chat header: `.im-ui-pro-chat-header`
- Header basic info: `.im-ui-pro-chat-header-basic-info-content`
- Header user info: `.im-ui-pro-chat-header-user-info`
- Header resume summary: `.im-ui-pro-chat-header-resume-content`
- Header extension info: `.im-ui-pro-chat-header-ext-info`
- Header extension content: `.im-ui-pro-chat-header-ext-content`
- Message list: `.im-ui-message-list-wrapper.im-ui-chat-list, .im-ui-msg-list-content`
- Action bar: `.chatwin-action, .im-ui-chat-input, .actions-left`
- Request-resume confirmation title: `.ant-im-modal-confirm-title` with text `确定向对方索要简历吗？`
- Request-resume confirmation root: nearest ancestor with class `ant-im-modal`
- Request-resume confirm button: `.ant-im-modal button` whose compact text is `确定` (rendered text observed as `确 定`)
- Request-resume cancel button: `.ant-im-modal button` whose compact text is `取消` (rendered text observed as `取 消`)

### Resume Detail
- Printable root: `[class*="resume-detail-page-wrap"].printable-content`
- Fallback printable root: `.printable-content`
- Section headers: `[class*="header"]`
- Individual info block: `[class*="individualInfo"]`
- Portfolio wrap: `[class*="xpath-portfolio-wrap"]`
- Continue chat button: `[class*="xpath-open-im-btn"]`

## Verified Network Evidence

### Recommend modal open
- `https://api-lpt.liepin.com/api/com.liepin.recruitbff.lpt.recommend.get-recommend-resumes`
- `https://api-lpt.liepin.com/api/com.liepin.rresume.usere.pc.get-resume-detail`
- `https://api-lpt.liepin.com/api/com.liepin.im.b.get-chat-btn-list`
- `https://api-lpt.liepin.com/api/com.liepin.rresume.operatorrecord.get-resume-recruit-record`

### Chat `看简历 -> resume/detail`
- `https://api-lpt.liepin.com/api/com.liepin.im.contact.get-resume-card`
- `https://api-lpt.liepin.com/api/com.liepin.im.b.common.get-resume-id`
- `https://api-lpt.liepin.com/api/com.liepin.rresume.usere.pc.get-resume-detail`
- `https://api-lpt.liepin.com/api/com.liepin.rapply.e.get-record-res-detail`

### Chat `索要简历`
- `https://api-lpt.liepin.com/api/com.liepin.im.b.askfor.send-askfor-request`
- Successful request changes the same candidate's action state from `索要简历` to `索要中`.
- Successful request inserts chat text `我想要一份你的简历，你是否同意？`.

## P08 Acquisition Decision
- v1 parser primary source is readable DOM `printable-content` for both:
  - recommend modal
  - chat `resume/detail`
- Network endpoints are retained as evidence and possible fallback, but v1 does not reconstruct CVs from network payloads.
- v1 does not use image OCR and does not automatically preview/download attachment or portfolio gated content.
- Chat acquisition probe must reactivate the selected candidate row before clicking `看简历`; scanning the list changes the active conversation.

## P13 Chat Screen Input Decision
- For `索要简历` candidates, v1 chat screening input is built from DOM only:
  - left conversation row
  - active chat header
  - header resume summary
  - visible message list
  - action bar
- `data-tlg-ext.to_imid` is the stable row key for dedupe.
- Do not click `索要简历` during input discovery or dry-run screening.

## P15 Chat Action Decision
- `none` is a no-op and must leave the same `rowKey` in `索要简历`.
- `request_resume` must click `索要简历`, then confirm the modal by clicking the real primary `button`.
- Post-action verification must use stable `rowKey`, not row index, because successful requests can reorder the conversation list.
- CDP coordinate clicks did not reliably trigger the confirmation business logic on this page; exact DOM `button.click()` on the real confirm button did.
- If the Ant confirmation modal leaves a visible animation residue after action completion, reload the chat page to clear it before continuing.

## P17 Recommend Filter Decision
- v1 supported native filters:
  - `graduation_year`: `毕业年份`, tag options `不限`, `2026`, `2027`, `2028`, `2029`, `2030及以后`
  - `education`: `学历要求`, tag options `不限`, `初中及以下`, `高中`, `中专/中技`, `大专`, `本科`, `硕士`, `MBA/EMBA`, `博士`
  - `salary_range`: `薪资范围（单选）`, predefined tag options `不限`, `5K以下`, `5-8K`, `8-10K`, `10-15K`, `15-20K`, `20-30K`, `30-50K`, `50K以上`
  - `age`: `年龄`, two input fields
  - `school_tier`: `院校`, tag options `不限`, `985`, `211`, `双一流院校`, `海外名校`
  - `job_status`: `求职状态`, tag options `不限`, `离校，正在找工作`, `在校，可即刻到岗`, `在校，看看机会`, `在校，暂时不找工作`
- v1 excludes salary `自定义` because the extra custom salary flow was not validated.
- Filter group title matching must tolerate `薪资范围` and `薪资范围（单选）`.
- P17 only validates drawer set/clear/active state and does not click `确定`; application/effect validation is P18.

## Infinite Scroll Decision
- Added audit commands:
  - `node src/cli.js research chat-scroll-audit --filter 有简历 --max-passes 40 --idle-passes 3`
  - `node src/cli.js research recommend-scroll-audit --max-passes 80 --idle-passes 3`
- Chat list scroll container is discovered from `.im-ui-contact-list-item.im-ui-contact-item` ancestors; live probe selected an element with `scrollHeight=652`, `clientHeight=579`, and reached `scrollTop=73`.
- Chat live audit evidence:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\chat-scroll-audit-20260421-194041.json`
  - `bottomConfirmed=true`
  - `falseBottomDetected=false`
  - `maxPassesReached=false`
  - `initialItemCount=30`
  - `finalItemCount=30`
  - `uniqueItemCount=22`
- Infinite scroll bottom is accepted only after:
  - list reports `atBottom=true`
  - several idle passes show no scroll/content progress
  - two up/down probes return to bottom with no item count, unique count, or signature change
- Recommend page has delayed lazy loading near the bottom; do not accept `atBottom=true` after short waits as sufficient.
- Recommend page terminal text observed live:
  - `我也是有底线的`
  - DOM classes: `infiniteScrollEndWrap--EROop`, `infiniteScrollEnd--B1xXF`
- `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-scroll-audit-20260421-194816.json` is superseded and was a false positive: it stopped at 40 candidates.
- Corrected recommend evidence:
  - failure proving more content existed: `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-scroll-audit-terminal-20260421-200828.json`, `finalItemCount=960`, `maxPassesReached=true`
  - pass at real bottom: `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-scroll-audit-terminal-pass-20260421-201538.json`, `finalItemCount=969`, terminal signal `我也是有底线的`
- Use `textContent` for list signatures in infinite scroll audits. `innerText` can trigger expensive layout work on the Liepin chat page and previously caused CDP `Runtime.evaluate` timeouts.
- The CDP helper must clear per-call timeout timers on successful responses. Otherwise every live command can appear to hang for 30 seconds even when Chrome returned immediately.
- Async helpers that keep a CDP page client open must `return await` inside `try/finally`; returning a promise directly lets `finally` disconnect the socket before the audit finishes.
- Recommend live audit evidence:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-scroll-audit-terminal-pass-20260421-201538.json`
  - `bottomConfirmed=true`
  - `terminalSignalConfirmed=true`
  - `falseBottomDetected=false`
  - `maxPassesReached=false`
  - `finalItemCount=969`
  - `uniqueItemCount=969`

## P18 Recommend Filter Execution Decision
- P18 live command:
  - `node src/cli.js research recommend-filter-execute --debug-port 9222 --preset p17`
- Latest passing evidence:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-filter-execute-p17-20260421-194931.json`
- The filter entry button must be matched by prefix `筛选`, not exact text:
  - no active filters: `筛选`
  - active filters: `筛选·6`
- P18 executor starts by opening the drawer and clicking `重置` so leftover filters from interrupted runs are cleared before applying a new plan.
- P18 applies the P17 preset, clicks drawer `确定`, then reopens the drawer, clicks `重置`, clicks `确定`, and verifies clean restore.
- Live effect evidence:
  - before applying filters: 20 recommend cards
  - after applying 6 filters: 11 recommend cards
  - after restore: 20 recommend cards
- Drawer selected state after restore must be empty: `drawerBeforeRestoreApply.selected=[]`.

## P19 Recommend Traversal Decision
- P19 live command:
  - `node src/cli.js research recommend-traversal-audit --debug-port 9222 --steps 10 --tab 推荐 --step-delay-ms 3500`
- Latest passing evidence:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-traversal-audit-20260421-202447.json`
- Validated flow:
  - switch `推荐 -> 最新 -> 推荐`
  - open a recommend card detail modal
  - read modal summary/hash
  - click `.button-turn-next` for 9 further candidates
  - close modal and clear `#preview`
- Passing summary:
  - `requestedSteps=10`
  - `traversedSteps=10`
  - `uniqueSnapshots=10`
  - `tabSwitchCount=3`
  - `closeVerified=true`
  - `failures=[]`
- Recommend tab active class remains `.ant-lpt-segmented-item-selected`, but it can lag immediately after click. Treat tab switch as valid if either:
  - active label matches requested label
  - clicked tab changed the card list and the new list has cards
- Recommend modal close can leave animation/hash residue. Close verification should wait for modal/printable absence or invisibility, then clear `#preview`.
- P19 selector confirmations:
  - card: `[class*="newResumeItemWrap"]`
  - tab label: `.ant-lpt-segmented-item-label`
  - active tab item class: `ant-lpt-segmented-item-selected`
  - modal root: `[class*="resume-detail-modal-wrap"]`
  - modal printable: `[class*="resume-detail-modal-wrap"] .resume-detail-content-body.printable-content`
  - next button: `.button-turn-next`
  - close button: `[class*="resume-detail-modal-wrap"] [class*="closeBtn"]`

## P20 Recommend Dry-Run Screening Decision
- P20 live command:
  - `node src/cli.js research recommend-dry-run-screening --debug-port 9222 --candidate-limit 20 --tab 推荐 --step-delay-ms 5500 --mock-llm --mock-decision pass --mock-post-action chat`
- Latest passing evidence:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-dry-run-screening-p20-20260421-002.json`
- Validated flow:
  - open recommend card detail modal
  - read `[class*="resume-detail-modal-wrap"] .resume-detail-content-body.printable-content`
  - parse through `liepin_cv_v1`
  - build `liepin_screen_input_v1`
  - audit all parsed sections against payload manifest
  - call structured recommend LLM contract `{ decision, post_action }`
  - click `.button-turn-next` for the next candidate
  - close modal with `[class*="resume-detail-modal-wrap"] [class*="closeBtn"]`
- Passing summary:
  - `processedCandidates=20`
  - `llmCalls=20`
  - `uniqueTextHashes=20`
  - `uniqueStructures=14`
  - `coveragePassed=true`
  - `actionClicks=0`
  - `closeVerified=true`
  - `violations=[]`
- P20 deliberately used mock `pass/chat` so a would-be chat decision still produced zero action clicks in dry-run.
- P20 fixed snapshot `candidateLabel` extraction to use the first raw `innerText` line, not normalized full text.
- P20 introduced no new selectors beyond the P19 recommend modal selectors.

## P21 Recommend Action Decision
- P21 live commands:
  - `node src/cli.js research recommend-action --debug-port 9222 --action none --tab 推荐 --start-index 0 --step-delay-ms 5500`
  - `node src/cli.js research recommend-action --debug-port 9222 --action chat --tab 推荐 --start-index 0 --step-delay-ms 5500`
- Latest passing evidence:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-action-none-p21-20260421-002.json`
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-action-chat-p21-20260421-idx0-pass4.json`
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-action-chat-p21-20260421-idx1.json`
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-action-chat-p21-20260421-idx2.json`
- `none` passed with:
  - `actionClicks=0`
  - `modalStableAfterNone=true`
  - `closeVerified=true`
- `chat` passed on 3 real candidates:
  - `候选人B`
  - `候选人C`
  - `候选人D`
- P21 chat success criteria:
  - `entryKind=recommend_basic_chat_modal`
  - candidate name appears in `.im-ui-basic-chat-header-name` / `.im-ui-basic-chat-header-basic-info-content`
  - `.im-ui-basic-chat-header-jump-btn` contains `跳转沟通页`
  - action bar contains `索要简历`
- Recommend direct chat flow variants:
  - First click can show lightweight welcome popover `.popover-welcome-msg-body` with `已向候选人发送消息`.
  - First click can show `.im-ui-recommend-chat-modal` with `已向{candidate}发送打招呼语`.
  - After either success feedback, the open chat button changes from `立即沟通` to `继续沟通`.
  - Clicking `继续沟通` opens same-page `.im-ui-basic-chat-modal`.
- Do not require `/chat/im` navigation for P21; the same-page basic chat modal is the verified chat entry for P22.
- Early P21 failed probes proved that a failed verification can still send the greeting message; future real action tests need explicit authorization.

## Drift And Risk Notes
- 高频 recommend 详情抓取会触发猎聘风控，当前实测曾把 recommend tab 重定向到：
  - `https://safe.liepin.com/page/liepin/captchaPage_PC?...backurl=https://api-lpt.liepin.com/api/com.liepin.rresume.usere.pc.get-resume-bright-risk`
- 通过验证码回到 recommend 后，旧的 `safe.liepin.com` tab 可能仍留在 Chrome target list 中。当前实现会同时返回：
  - `riskPageDetected=true`
  - `riskBlocked=false`
  - 前提是正常 recommend target 已恢复。
- Recommend sampler 当前默认每次打开/翻页之间等待 `3500ms`，并且如果当前 recommend target 自身跳到风控页会立即停止。
- `有简历` 过滤下会出现系统行 `收到简历 已为您筛选出投递人选`，并且当前 DOM 中可能重复出现，不可直接当普通候选人会话处理。
- 任何 future selector drift 或 captcha/risk page 发现，都需要先补这里再继续改代码。
