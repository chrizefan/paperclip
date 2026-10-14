import { describe, expect, it } from "vitest";
import {
  buildContinuationSummaryMarkdown,
  continuationSummaryParksExecutor,
} from "../services/issue-continuation-summary.js";

// The authored "I am deliberately waiting" bullet a seat posts when its work is
// blocked on a human, a board decision, or an external gate (DIG-3097).
const AUTHORED_WAIT =
  "Wait for the board to decide the merge-queue ruling before continuing executor work.";

const PARKING_SUMMARY = ["## Next Action", "", `- ${AUTHORED_WAIT}`].join("\n");

function summaryFor(runStatus: string, previousSummaryBody: string | null) {
  return buildContinuationSummaryMarkdown({
    issue: {
      id: "issue-1",
      identifier: "DIG-3097",
      title: "missing-disposition loop",
      description: "Root-cause ticket.",
      status: "in_progress",
      priority: "high",
    },
    run: {
      id: "run-1",
      status: runStatus as never,
      error: null,
      resultJson: { summary: "Measured the loop." },
      stdoutExcerpt: null,
      stderrExcerpt: null,
      finishedAt: new Date("2026-10-14T04:00:00.000Z"),
    },
    agent: { id: "a1", name: "Host & Runtime Engineer" },
    previousSummaryBody,
  } as never);
}

describe("DIG-3097: an authored deliberate wait must survive next-action generation", () => {
  it("keeps the authored wait on a clean succeeded run (default branch)", () => {
    const body = summaryFor("succeeded", PARKING_SUMMARY);
    expect(continuationSummaryParksExecutor(body)).toBe(true);
  });

  it("keeps the authored wait when the continuation run FAILED", () => {
    const body = summaryFor("failed", PARKING_SUMMARY);
    expect(continuationSummaryParksExecutor(body)).toBe(true);
  });

  it("keeps the authored wait when the continuation run was CANCELLED", () => {
    const body = summaryFor("cancelled", PARKING_SUMMARY);
    expect(continuationSummaryParksExecutor(body)).toBe(true);
  });
});
