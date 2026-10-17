import { describe, expect, it } from "vitest";
import { classifyOpenCodeLimitError, extractOpenCodeRetryNotBefore, isOpenCodeQuotaClassificationEnabled } from "./quota.js";

const now = new Date("2026-10-17T02:00:00.000Z");

describe("classifyOpenCodeLimitError", () => {
  it("returns null for unrelated errors", () => {
    expect(classifyOpenCodeLimitError("TypeError: cannot read x", now)).toBeNull();
    expect(classifyOpenCodeLimitError("", now)).toBeNull();
    expect(classifyOpenCodeLimitError(null, now)).toBeNull();
  });
  it("classifies quota errors with a relative reset", () => {
    const r = classifyOpenCodeLimitError("Error: Go usage limit reached. Try again in 2h 30m.", now);
    expect(r?.errorFamily).toBe("provider_quota");
    expect(r?.retryNotBefore?.toISOString()).toBe("2026-10-17T04:30:00.000Z");
  });
  it("classifies quota errors without a reset", () => {
    const r = classifyOpenCodeLimitError("You exceeded your current quota, please check your plan", now);
    expect(r).toEqual({ errorFamily: "provider_quota", retryNotBefore: null });
  });
  it("classifies rate limits as transient upstream", () => {
    const r = classifyOpenCodeLimitError("APIError 429 Too Many Requests retry-after: 90", now);
    expect(r?.errorFamily).toBe("transient_upstream");
    expect(r?.retryNotBefore?.toISOString()).toBe("2026-10-17T02:01:30.000Z");
  });
});

describe("extractOpenCodeRetryNotBefore", () => {
  it("reads an absolute ISO reset", () => {
    expect(extractOpenCodeRetryNotBefore("quota resets at 2026-10-17T06:00:00Z", now)?.toISOString()).toBe("2026-10-17T06:00:00.000Z");
  });
  it("reads an epoch reset", () => {
    const epoch = Math.floor(Date.parse("2026-10-17T03:00:00Z") / 1000);
    expect(extractOpenCodeRetryNotBefore(`{"x-ratelimit-reset": ${epoch}}`, now)?.toISOString()).toBe("2026-10-17T03:00:00.000Z");
  });
  it("ignores resets in the past", () => {
    expect(extractOpenCodeRetryNotBefore("resets at 2026-10-16T00:00:00Z", now)).toBeNull();
  });
  it("caps very long resets at 7 days", () => {
    expect(extractOpenCodeRetryNotBefore("try again in 30 days", now)?.toISOString()).toBe("2026-10-24T02:00:00.000Z");
  });
});

describe("isOpenCodeQuotaClassificationEnabled", () => {
  it("is off by default", () => {
    expect(isOpenCodeQuotaClassificationEnabled({})).toBe(false);
    expect(isOpenCodeQuotaClassificationEnabled({ PAPERCLIP_OPENCODE_QUOTA_CLASSIFICATION: "1" })).toBe(true);
    expect(isOpenCodeQuotaClassificationEnabled({ PAPERCLIP_OPENCODE_QUOTA_CLASSIFICATION: "true" })).toBe(true);
    expect(isOpenCodeQuotaClassificationEnabled({ PAPERCLIP_OPENCODE_QUOTA_CLASSIFICATION: "0" })).toBe(false);
  });
});
