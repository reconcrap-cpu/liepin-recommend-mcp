import assert from "node:assert/strict";
import test from "node:test";

import { parseCvSnapshot, validateSurveyCvParsing } from "./cv-parser.js";

test("parseCvSnapshot maps missing sections to empty section objects", () => {
  const cv = parseCvSnapshot({
    sourceKind: "recommend_modal",
    captureSource: "recommend_tab_推荐",
    candidateLabel: "候选人A",
    fullText: [
      "候选人A 在线",
      "求职意向",
      "人力资源 5-8k",
      "教育经历",
      "某大学 本科",
      "语言能力",
      "英语 CET4"
    ].join("\n"),
    sectionTitles: ["求职意向", "教育经历", "语言能力"]
  });

  assert.equal(cv.schemaVersion, "liepin_cv_v1");
  assert.equal(cv.sections.job_intent.present, true);
  assert.equal(cv.sections.work_experience.present, false);
  assert.equal(cv.sections.work_experience.text, "");
  assert.equal(cv.sections.attachment_resume.present, false);
  assert.deepEqual(cv.coverage.presentSectionIds, ["job_intent", "education", "languages"]);
});

test("parseCvSnapshot keeps repeated section chunks under the same schema key", () => {
  const cv = parseCvSnapshot({
    sourceKind: "recommend_modal",
    fullText: [
      "候选人B",
      "推荐职位： 招聘实习生",
      "推荐职位： 招聘实习生",
      "求职意向",
      "招聘 100-200元/天",
      "附件简历与个人作品",
      "简历.pdf 预览 下载",
      "人才招聘记录",
      "暂无记录",
      "简历备注",
      "暂无备注"
    ].join("\n"),
    sectionTitles: ["推荐职位： 招聘实习生", "求职意向", "附件简历", "人才招聘记录", "简历备注"]
  });

  assert.equal(cv.sections.job_match.present, true);
  assert.equal(cv.sections.job_match.chunks.length, 2);
  assert.equal(cv.sections.attachment_resume.present, true);
  assert.match(cv.sections.attachment_resume.text, /附件简历与个人作品/u);
  assert.equal(cv.sections.recruit_records.present, true);
  assert.equal(cv.sections.resume_notes.present, true);
});

test("validateSurveyCvParsing maps every survey structure without throwing", () => {
  const survey = {
    summary: {
      uniqueStructureCount: 2
    },
    samples: [
      {
        sourceKind: "recommend_modal",
        structureSignature: "sig-a",
        fullText: "求职意向\nHR\n工作经历\n公司A\n教育经历\n学校A",
        sectionTitles: ["求职意向", "工作经历", "教育经历"]
      },
      {
        sourceKind: "chat_resume_detail",
        structureSignature: "sig-b",
        fullText: "求职意向\n运营\n项目经历\n项目A\n附加信息\n可实习",
        sectionTitles: ["求职意向", "项目经历", "附加信息"]
      }
    ]
  };

  const result = validateSurveyCvParsing(survey);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.parsedCount, 2);
  assert.equal(result.structureCount, 2);
  assert.equal(result.allExpectedStructuresParsed, true);
  assert.equal(result.allExpectedSectionsPresent, true);
  assert.deepEqual(result.samplesMissingExpectedSections, []);
});
