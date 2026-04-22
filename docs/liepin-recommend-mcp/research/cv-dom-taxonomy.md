# CV DOM Taxonomy

## Latest Validated Survey
- Phase: `P07`
- Command:
  - `node src/cli.js research cv-survey --minimum 50 --batch 10 --per-pass 5 --rounds 8`
- Output:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\cv-structure-survey-1776759213165.json`
- Summary:
  - `sampledCount = 60`
  - `uniqueStructureCount = 19`
  - `minimumSamples = 50`
  - `meetsMinimumSamples = true`
  - `stableAfterFinalBatch = true`
  - `stopReason = minimum_met_and_stable_batch_reached`

## Terminal Stability Evidence
| Batch | Accepted Through | New Structures |
| --- | ---: | ---: |
| 1 | 10 | 8 |
| 2 | 20 | 3 |
| 3 | 30 | 3 |
| 4 | 40 | 2 |
| 5 | 50 | 3 |
| 6 | 60 | 0 |

## Observed Structure Families
| # | Count | Source | Normalized sections | Attachment | Extra info |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 10 | `recommend_modal` | `job_match, job_intent, work_experience, education, languages, attachment_resume` | yes | no |
| 2 | 10 | `recommend_modal` | `job_match, job_intent, work_experience, education, certificates, languages, attachment_resume` | yes | no |
| 3 | 8 | `recommend_modal` | `job_match, job_intent, work_experience, project_experience, education, languages, attachment_resume` | yes | no |
| 4 | 5 | `recommend_modal` | `job_match, job_intent, work_experience, project_experience, education, skills, certificates, languages, attachment_resume` | yes | no |
| 5 | 4 | `recommend_modal` | `job_match, job_intent, work_experience, education, skills, certificates, languages, attachment_resume` | yes | no |
| 6 | 3 | `recommend_modal` | `job_match, job_intent, work_experience, project_experience, education, certificates, languages, attachment_resume` | yes | no |
| 7 | 3 | `recommend_modal` | `job_match, job_intent, work_experience, education, languages` | no | no |
| 8 | 3 | `recommend_modal` | `job_match, job_intent, work_experience, project_experience, education, skills, certificates, languages, extra_info, attachment_resume` | yes | yes |
| 9 | 3 | `recommend_modal` | `job_match, job_intent, education, certificates, languages, attachment_resume` | yes | no |
| 10 | 2 | `recommend_modal` | `job_match, job_intent, work_experience, education, certificates, languages` | no | no |
| 11 | 1 | `chat_resume_detail` | `job_intent, work_experience, education, languages, attachment_resume` | yes | no |
| 12 | 1 | `chat_resume_detail` | `job_intent, work_experience, project_experience, education, skills, certificates, languages, attachment_resume` | yes | no |
| 13 | 1 | `chat_resume_detail` | `job_intent, work_experience, project_experience, education, certificates, languages, attachment_resume` | yes | no |
| 14 | 1 | `chat_resume_detail` | `job_intent, work_experience, education, certificates, languages, extra_info` | no | yes |
| 15 | 1 | `recommend_modal` | `job_match, job_intent, education, languages` | no | no |
| 16 | 1 | `recommend_modal` | `job_match, job_intent, work_experience, education, skills, languages, attachment_resume` | yes | no |
| 17 | 1 | `recommend_modal` | `job_match, job_intent, work_experience, project_experience, education, certificates, languages` | no | no |
| 18 | 1 | `recommend_modal` | `job_match, job_intent, education, languages, attachment_resume` | yes | no |
| 19 | 1 | `recommend_modal` | `job_match, job_intent, work_experience, project_experience, education, certificates, languages, extra_info, attachment_resume` | yes | yes |

## Current Findings
- Recommend modal includes `job_match`; chat `resume/detail` does not.
- Both sources use `printable-content`, but root wrapper classes differ:
  - recommend modal: `resume-detail-content-body`
  - chat detail page: `resume-detail-page-wrap`
- `attachment_resume` appears as a gated metadata/preview region, not necessarily as full downloadable attachment text.
- `extra_info` is optional and appears in both recommend modal and chat detail samples.
- `project_experience`, `skills`, and `certificates` are independent optional sections and must not be assumed to co-occur.

## Phase-Gate Status
- `P07` is `PASSED`.
- This taxonomy is sufficient to begin `P08` acquisition decision matrix and `P09` parser schema design.

## Historical Notes
- Earlier `--per-pass 25` survey attempts produced useful exploratory evidence but were too aggressive and contributed to a captcha/risk incident.
- Do not use the old high-frequency command as the normal research pace.
