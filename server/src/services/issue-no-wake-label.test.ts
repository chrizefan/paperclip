import { describe, expect, it } from "vitest";
import { resolveNoWakeLabelName, shouldSkipWakeForNoWakeLabel } from "./issue-no-wake-label.js";

describe("resolveNoWakeLabelName", () => {
  it("is disabled when unset or blank", () => {
    expect(resolveNoWakeLabelName({})).toBeNull();
    expect(resolveNoWakeLabelName({ PAPERCLIP_NO_WAKE_LABEL: "  " })).toBeNull();
  });
  it("returns the trimmed label name", () => {
    expect(resolveNoWakeLabelName({ PAPERCLIP_NO_WAKE_LABEL: " no-wake " })).toBe("no-wake");
  });
});

describe("shouldSkipWakeForNoWakeLabel", () => {
  const base = { noWakeLabel: "no-wake", issueLabelNames: ["feature", "No-Wake"] };
  it("skips agent and system wakes on a labelled issue", () => {
    expect(shouldSkipWakeForNoWakeLabel({ ...base, requestedByActorType: "agent" })).toBe(true);
    expect(shouldSkipWakeForNoWakeLabel({ ...base, requestedByActorType: "system" })).toBe(true);
    expect(shouldSkipWakeForNoWakeLabel({ ...base, requestedByActorType: null })).toBe(true);
  });
  it("lets a human user wake through", () => {
    expect(shouldSkipWakeForNoWakeLabel({ ...base, requestedByActorType: "user" })).toBe(false);
  });
  it("does nothing without the label or when disabled", () => {
    expect(shouldSkipWakeForNoWakeLabel({ noWakeLabel: "no-wake", issueLabelNames: ["feature"], requestedByActorType: "agent" })).toBe(false);
    expect(shouldSkipWakeForNoWakeLabel({ noWakeLabel: null, issueLabelNames: ["no-wake"], requestedByActorType: "agent" })).toBe(false);
  });
});
