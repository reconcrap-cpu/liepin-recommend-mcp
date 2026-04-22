# LLM Coverage Audit

## Fixed Audit Principles
- Production screening will only require structured decisions:
  - Recommend: `{ decision, post_action }`
  - Chat: `{ decision, post_action }`
- Production prompts will not request pass/fail explanations.
- If the provider exposes reasoning / CoT streaming natively, it may be written to `reasoning.log`.
- If the provider does not expose reasoning streaming, that is acceptable and should not be treated as a bug.

## Implemented Coverage Mechanism
- The “LLM saw the whole CV” check will be implemented through input auditing, not by asking the model to explain itself.
- Implemented audit artifacts per sample:
  - ordered section manifest
  - per-section character counts
  - per-section content hash
  - full payload hash
  - coverage summary aligned to the parsed CV schema

## Current Audit State
- Parser:
  - `src/liepin/cv-parser.js`
  - schema version `liepin_cv_v1`
- Payload builder:
  - `src/liepin/cv-payload.js`
  - screen input schema `liepin_screen_input_v1`
- Validation command:
  - `node src/cli.js research audit-payload --file "C:\Users\yaolin\.liepin-recommend-mcp\research\cv-structure-survey-1776759213165.json" --limit 10`
- Latest result:
  - `auditedSampleCount = 10`
  - `uniqueStructureCount = 10`
  - `allAuditsPassed = true`
  - `failedAudits = []`

## P20 Recommend Dry-Run Audit
- Validation command:
  - `node src/cli.js research recommend-dry-run-screening --debug-port 9222 --candidate-limit 20 --tab 推荐 --step-delay-ms 5500 --mock-llm --mock-decision pass --mock-post-action chat`
- Latest result file:
  - `C:\Users\yaolin\.liepin-recommend-mcp\research\recommend-dry-run-screening-p20-20260421-002.json`
- Summary:
  - `processedCandidates = 20`
  - `llmCalls = 20`
  - `actionClicks = 0`
  - `coveragePassed = true`
  - `closeVerified = true`
  - `violations = []`
- Coverage file audit:
  - `uniqueTextHashes = 20`
  - `uniqueStructures = 14`
  - `allUntruncated = true`
  - `allMissingParsedEmpty = true`
  - `decisionSet = ["pass/chat"]`
  - first candidate label = `推荐职位：`
  - first payload char count = `2110`
- The request contract still only asks for structured fields:
  - `decision`
  - `post_action`
- P20 does not request pass/fail explanations. Mock provider did not expose reasoning stream, so `reasoningCaptured=false` is expected and not a bug.

## Remaining Work
- `P12` implemented the LLM adapter abstraction and optional reasoning stream side channel.
- `P20` wires adapter outputs into recommend dry-run JSON evidence.
- Later async run phases still need to split adapter outputs into fixed run artifacts:
  - `llm-request.json`
  - `decision.json`
  - optional `reasoning.log`
- `reasoning.log` should only be generated when the provider natively exposes reasoning / CoT stream.

The production policy is:
- do not ask the model for pass/fail reasons;
- record provider-native reasoning/CoT stream only if the provider exposes it;
- verify CV completeness through input coverage manifests, hashes, and calibration audit mode rather than explanations.

Implementation lands in later phases after parser and full payload packing are complete.
