import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE_HEALTH_TIMEOUT_MS, resolveServiceHealthTimeoutMs } from "../commands/service.js";

describe("resolveServiceHealthTimeoutMs", () => {
  it("uses the 60s default when the variable is not set", () => {
    expect(resolveServiceHealthTimeoutMs({})).toBe(DEFAULT_SERVICE_HEALTH_TIMEOUT_MS);
    expect(DEFAULT_SERVICE_HEALTH_TIMEOUT_MS).toBe(60_000);
  });
  it("uses a valid override", () => {
    expect(resolveServiceHealthTimeoutMs({ PAPERCLIP_SERVICE_HEALTH_TIMEOUT_MS: "900000" })).toBe(900_000);
  });
  it("ignores invalid values", () => {
    for (const v of ["", "  ", "abc", "0", "-5"]) {
      expect(resolveServiceHealthTimeoutMs({ PAPERCLIP_SERVICE_HEALTH_TIMEOUT_MS: v })).toBe(60_000);
    }
  });
  it("caps the value at one hour", () => {
    expect(resolveServiceHealthTimeoutMs({ PAPERCLIP_SERVICE_HEALTH_TIMEOUT_MS: "99999999" })).toBe(3_600_000);
  });
});
