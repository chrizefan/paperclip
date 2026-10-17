import { describe, expect, it } from "vitest";
import { resolveIssueWakeCapPerDay, shouldSkipWakeForIssueCap } from "./issue-wake-cap.js";

describe("resolveIssueWakeCapPerDay", () => {
  it("is disabled by default and for invalid values", () => {
    for (const v of [undefined, "", "0", "-1", "1.5", "abc"]) {
      expect(resolveIssueWakeCapPerDay(v === undefined ? {} : { PAPERCLIP_ISSUE_WAKE_CAP_PER_DAY: v })).toBe(0);
    }
  });
  it("reads a positive integer", () => {
    expect(resolveIssueWakeCapPerDay({ PAPERCLIP_ISSUE_WAKE_CAP_PER_DAY: "6" })).toBe(6);
  });
});

describe("shouldSkipWakeForIssueCap", () => {
  it("skips at or above the cap", () => {
    expect(shouldSkipWakeForIssueCap({ capPerDay: 3, runsInWindow: 3, requestedByActorType: "agent" })).toBe(true);
    expect(shouldSkipWakeForIssueCap({ capPerDay: 3, runsInWindow: 5, requestedByActorType: null })).toBe(true);
  });
  it("allows below the cap, when disabled, and for human users", () => {
    expect(shouldSkipWakeForIssueCap({ capPerDay: 3, runsInWindow: 2, requestedByActorType: "system" })).toBe(false);
    expect(shouldSkipWakeForIssueCap({ capPerDay: 0, runsInWindow: 99, requestedByActorType: "agent" })).toBe(false);
    expect(shouldSkipWakeForIssueCap({ capPerDay: 3, runsInWindow: 99, requestedByActorType: "user" })).toBe(false);
  });
});
