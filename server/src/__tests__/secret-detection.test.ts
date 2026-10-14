import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  containsSecret,
  detectSecret,
  fingerprintSecret,
} from "../services/secret-detection.js";

/**
 * Pure unit coverage for the shared secret detector. The route-level suite
 * (issue-comment-secret-detection.test.ts) proves the guard at the persistence
 * choke point; this file pins the rule catalog and the false-positive carve-outs.
 */

function expectRule(text: string, rule: string) {
  const match = detectSecret(text);
  expect(match?.rule).toBe(rule);
  return match!;
}

describe("detectSecret named rules", () => {
  const cases: Array<{ name: string; sample: string }> = [
    {
      name: "wireguard_private_key",
      sample: "PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
    {
      name: "wireguard_private_key_inline",
      sample: "key: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= end",
    },
    {
      name: "openvpn_static_key",
      sample: "<ca>\n-----BEGIN PRIVATE KEY-----\n",
    },
    {
      name: "pem_private_key",
      sample: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
    },
    { name: "slack_token", sample: "token xoxb-1234567890-abcdefghij done" },
    {
      name: "github_token",
      sample: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    },
    { name: "aws_access_key_id", sample: "AKIAIOSFODNN7EXAMPLE" },
    { name: "google_api_key", sample: `AIza${"a".repeat(35)}` },
    { name: "stripe_secret_key", sample: `sk_live_${"a".repeat(24)}` },
    { name: "anthropic_key", sample: `sk-ant-api03-${"a".repeat(24)}` },
    { name: "openai_key", sample: `sk-${"A".repeat(36)}` },
    {
      name: "bearer_token",
      sample: `Authorization: Bearer ${"a".repeat(24)}`,
    },
    {
      name: "private_key_header_inline",
      sample: `API_SECRET=${"a".repeat(24)}`,
    },
  ];

  for (const { name, sample } of cases) {
    it(`reports ${name}`, () => {
      expectRule(sample, name);
    });
  }

  it("reuses looksLikeCredentialJwt for a credential JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expectRule(jwt, "credential_jwt");
  });

  it("reports a 128-hex opaque token as high entropy hex", () => {
    const token = "0123456789abcdef".repeat(8);
    expect(token).toHaveLength(128);
    expectRule(token, "high_entropy_hex");
  });

  it("reports an opaque base64 blob as high entropy base64", () => {
    const token = randomBytes(96).toString("base64");
    expect(token.length).toBeGreaterThanOrEqual(80);
    expectRule(token, "high_entropy_base64");
  });
});

describe("detectSecret false positives", () => {
  it("passes a 40-character git SHA", () => {
    expect(detectSecret("commit 0123456789abcdef0123456789abcdef01234567")).toBeNull();
  });

  it("passes a 64-character sha256", () => {
    expect(
      detectSecret(
        "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
    ).toBeNull();
  });

  it("passes a UUID", () => {
    expect(detectSecret("id 123e4567-e89b-12d3-a456-426614174000 here")).toBeNull();
  });

  it("passes several UUIDs joined by slashes in one markdown link", () => {
    // System recovery comments link runs as [id](.../agents/<uuid>/runs/<uuid>).
    // The joining `/` and `-` are in the base64url alphabet, so without
    // identifier masking the path reads as one 80+ high-entropy run.
    const runId = "123e4567-e89b-12d3-a456-426614174000";
    const agentId = "223e4567-e89b-12d3-a456-426614174001";
    expect(
      detectSecret(`- Latest run: [${runId}](/TST/agents/${agentId}/runs/${runId})`),
    ).toBeNull();
  });

  it("passes a 40-hex SHA next to a 64-hex sha256", () => {
    expect(
      detectSecret(
        "commit 0123456789abcdef0123456789abcdef01234567 sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
    ).toBeNull();
  });

  it("still reports a 128-hex token beside UUIDs", () => {
    const token = randomBytes(64).toString("hex");
    expect(token).toHaveLength(128);
    expectRule(`run 123e4567-e89b-12d3-a456-426614174000 token ${token}`, "high_entropy_hex");
  });

  it("passes a long repeated-digit run (low-entropy hex alphabet)", () => {
    // chat-channels.integration posts a 5,003-char "0123456789" repetition.
    // Digits are hex-valid, so without an entropy gate the whole run reads
    // as one high_entropy_hex hit (~3.32 bits/char vs the 3.5 threshold).
    const source = Array.from({ length: 5_003 }, (_v, i) => String(i % 10)).join("");
    expect(detectSecret(source)).toBeNull();
  });

  it("passes base64 of prose", () => {
    const encoded = Buffer.from(
      "The quick brown fox jumps over the lazy dog. This is a plain sentence.",
      "utf8",
    ).toString("base64");
    expect(encoded.length).toBeGreaterThanOrEqual(80);
    expect(detectSecret(`notes: ${encoded}`)).toBeNull();
  });

  it("passes ordinary prose", () => {
    expect(detectSecret("Looks good, thanks. Ship it.")).toBeNull();
  });

  it("returns null when disabled", () => {
    expect(detectSecret("AKIAIOSFODNN7EXAMPLE", { enabled: false })).toBeNull();
    expect(containsSecret("AKIAIOSFODNN7EXAMPLE", { enabled: false })).toBe(false);
  });
});

describe("fingerprintSecret", () => {
  it("is deterministic and 12 hex characters", () => {
    const value = "AKIAIOSFODNN7EXAMPLE";
    const first = fingerprintSecret(value);
    const second = fingerprintSecret(value);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes with the value", () => {
    expect(fingerprintSecret("value-one")).not.toBe(fingerprintSecret("value-two"));
  });
});

describe("detectSecret never echoes the value", () => {
  it("returns only the rule and fingerprint", () => {
    const secret = `sk_live_${"a".repeat(24)}`;
    const match = detectSecret(`here ${secret} end`);
    expect(match).not.toBeNull();
    expect(Object.keys(match!).sort()).toEqual(["fingerprint", "rule"]);
    const serialized = JSON.stringify(match);
    expect(serialized).not.toContain("sk_live_");
    expect(serialized).not.toContain(secret);
    // The fingerprint is a hash, not a substring of the value.
    expect(secret).not.toContain(String(match!.fingerprint));
  });
});
