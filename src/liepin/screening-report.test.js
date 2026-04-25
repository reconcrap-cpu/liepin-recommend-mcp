import assert from "node:assert/strict";
import test from "node:test";

import { RUN_WORKFLOWS } from "../constants.js";
import { buildScreeningCsvReport } from "./screening-report.js";

test("buildScreeningCsvReport uses candidateName from chat list row as name", () => {
  const csv = buildScreeningCsvReport({
    workflowResult: {
      workflow: RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING,
      result: {
        items: [
          {
            llmCalled: true,
            decision: { decision: "pass", post_action: "request_resume" },
            beforeState: {
              rowKey: "candidate-1",
              rowText: "王萌 招聘实习生 10:42",
              candidateName: "王萌",
              candidateTitle: "招聘实习生"
            },
            rowKey: "candidate-1"
          }
        ]
      }
    }
  });

  const dataLine = csv.trim().split("\n").at(-1);
  assert.match(dataLine, /^"王萌",/u);
});
