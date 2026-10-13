import { describe, expect, it } from "vitest";
import {
  detectSecret,
  detectSecretInFields,
  fingerprintSecret,
} from "../services/secret-detection.js";

/**
 * Unit coverage for the multi-field entry point DIG-3351 adds on top of the
 * DIG-3344 detector (server/src/services/secret-detection.ts).
 *
 * The route-level suites prove the guard fires through a real service; these
 * prove the part of it that is easy to get wrong and hard to see through an
 * HTTP response: a persisted jsonb column must be scanned as the bytes that
 * would actually be stored, not as the string "[object Object]", and the
 * reported rule must be deterministic because fields are scanned in order.
 *
 * No database is required here on purpose - the embedded Postgres suites are
 * skipped on hosts that cannot boot one, and this behaviour must stay proven
 * regardless.
 */

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("detectSecretInFields", () => {
  it("returns null when no field carries a secret", () => {
    expect(
      detectSecretInFields([
        "Quarterly plan",
        "Ship on Friday",
        { prompt: "Ready to merge?", options: [{ id: "a", label: "Yes" }] },
      ]),
    ).toBeNull();
  });

  it("returns null for an empty field list", () => {
    expect(detectSecretInFields([])).toBeNull();
  });

  it("finds a secret in a string field and reports the rule", () => {
    const match = detectSecretInFields(["clean", `deploy key ${AWS_KEY}`]);
    expect(match).toEqual({
      rule: "aws_access_key_id",
      fingerprint: fingerprintSecret(AWS_KEY),
    });
  });

  it("scans a jsonb field as its serialized bytes, not as [object Object]", () => {
    const match = detectSecretInFields([
      { note: `please use ${AWS_KEY} for the deploy` },
    ]);
    expect(match).toEqual({
      rule: "aws_access_key_id",
      fingerprint: fingerprintSecret(AWS_KEY),
    });
  });

  it("finds a secret nested inside an array-valued jsonb field", () => {
    // The rule under test is array nesting, so the payload uses a rule shape
    // that fires on its own (aws_access_key_id) rather than borrowing the
    // `bearer_token` rule, which is deliberately anchored on a literal
    // `Authorization:` prefix and so cannot match a bare "Bearer <token>".
    const match = detectSecretInFields([
      { steps: ["build", { token: `deploy key ${AWS_KEY}` }] },
    ]);
    expect(match).toEqual({
      rule: "aws_access_key_id",
      fingerprint: fingerprintSecret(AWS_KEY),
    });
  });

  it("scans number and boolean fields as their string form", () => {
    expect(detectSecretInFields([true, 42, null, undefined])).toBeNull();
    expect(typeof detectSecretInFields([42])).toBe("object");
  });

  it("skips a value that cannot be serialized instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => detectSecretInFields([cyclic])).not.toThrow();
    expect(detectSecretInFields([cyclic])).toBeNull();
  });

  it("reports the first offending field in field order, not the best match", () => {
    const hexToken = "0123456789abcdef".repeat(8);
    const forward = detectSecretInFields([`key ${AWS_KEY}`, `token ${hexToken}`]);
    const reversed = detectSecretInFields([`token ${hexToken}`, `key ${AWS_KEY}`]);
    expect(forward?.rule).toBe("aws_access_key_id");
    expect(reversed?.rule).toBe("high_entropy_hex");
  });

  it("matches detectSecret on a plain string so both entry points agree", () => {
    const text = `Authorization: Bearer ${"z".repeat(40)}`;
    expect(detectSecretInFields([text])).toEqual(detectSecret(text));
  });

  it("never returns any part of the value it refused", () => {
    const match = detectSecretInFields([`key ${AWS_KEY}`]);
    const serialized = JSON.stringify(match);
    expect(serialized).not.toContain("AKIA");
    expect(serialized).not.toContain(AWS_KEY);
    expect(serialized).not.toContain(AWS_KEY.slice(0, 8));
  });

  it("returns null when the caller disables detection", () => {
    expect(
      detectSecretInFields([`key ${AWS_KEY}`], { enabled: false }),
    ).toBeNull();
    expect(detectSecret(`key ${AWS_KEY}`, { enabled: false })).toBeNull();
  });

  it("returns null for an empty or non-string text passed to detectSecret", () => {
    expect(detectSecret("")).toBeNull();
    expect(detectSecret(undefined as unknown as string)).toBeNull();
  });
});