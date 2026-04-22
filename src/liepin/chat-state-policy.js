export const CHAT_SCREENING_STATUS = {
  SCREENABLE: "screenable",
  SKIP: "skip"
};

export function classifyChatScreeningEligibility(state = {}) {
  const resumeState = state.resumeState || "UNKNOWN";
  if (state.rowType !== "candidate") {
    return buildSkip(state, "non_candidate_row");
  }
  if (resumeState === "索要简历") {
    return {
      rowKey: state.rowKey || "",
      rowIndex: state.rowIndex ?? null,
      rowType: state.rowType || "",
      resumeState,
      screeningStatus: CHAT_SCREENING_STATUS.SCREENABLE,
      shouldCallLlm: true,
      skipReason: null
    };
  }
  if (resumeState === "索要中") {
    return buildSkip(state, "resume_request_pending");
  }
  if (resumeState === "看简历") {
    return buildSkip(state, "resume_already_available");
  }
  if (resumeState === "浏览简历") {
    return buildSkip(state, "browse_resume_not_normal_screenable_state");
  }
  return buildSkip(state, "unknown_or_no_resume_action");
}

export function summarizeChatScreeningPolicy(states = []) {
  const decisions = states.map((state) => classifyChatScreeningEligibility(state));
  const counts = {};
  const skipReasons = {};
  for (const decision of decisions) {
    counts[decision.screeningStatus] = (counts[decision.screeningStatus] || 0) + 1;
    if (decision.skipReason) {
      skipReasons[decision.skipReason] = (skipReasons[decision.skipReason] || 0) + 1;
    }
  }
  const violations = decisions.filter((decision) => {
    if (decision.screeningStatus === CHAT_SCREENING_STATUS.SCREENABLE) {
      return decision.resumeState !== "索要简历" || decision.rowType !== "candidate" || !decision.shouldCallLlm;
    }
    return decision.shouldCallLlm;
  });
  return {
    totalRows: states.length,
    counts,
    skipReasons,
    decisions,
    violations,
    passed: violations.length === 0
  };
}

function buildSkip(state, skipReason) {
  return {
    rowKey: state.rowKey || "",
    rowIndex: state.rowIndex ?? null,
    rowType: state.rowType || "",
    resumeState: state.resumeState || "UNKNOWN",
    screeningStatus: CHAT_SCREENING_STATUS.SKIP,
    shouldCallLlm: false,
    skipReason
  };
}
