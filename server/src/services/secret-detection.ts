import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { looksLikeCredentialJwt } from "@paperclipai/adapter-utils/command-redaction";

/**
 * Shared secret detector for persisted writes (issue comments first; interactions,
 * documents and work products later through the same guard).
 *
 * It mirrors `kit/bin/dt-secret-scan`: the same named rules plus a high-entropy
 * long-run detector for opaque hex/base64. The detector NEVER returns, logs or
 * echoes the matched value. Callers receive only the rule name and a salted
 * fingerprint, so a leak can be correlated without the value being re-exposed.
 */

/** Fixed salt, identical to `kit/bin/dt-secret-scan` (FP_SALT). Do not change. */
export const SECRET_FINGERPRINT_SALT = "dt-secret-scan/v1";

/** sha256(salt || utf8(value)), first 12 hex chars. Deterministic across runs. */
export function fingerprintSecret(value: string): string {
  return createHash("sha256")
    .update(Buffer.from(SECRET_FINGERPRINT_SALT, "utf8"))
    .update(Buffer.from(value, "utf8"))
    .digest("hex")
    .slice(0, 12);
}

export interface SecretMatch {
  /** Rule name from the shared catalog (see NAMED_RULES and the high-entropy rules). */
  rule: string;
  /** Salted, truncated hash of the matched value. Never the value itself. */
  fingerprint: string;
}

export interface DetectSecretOptions {
  /** When false the detector is a no-op (instance experimental flag is off). */
  enabled?: boolean;
}

interface NamedRule {
  name: string;
  regex: RegExp;
  /** Named capture group holding the sensitive value; defaults to the whole match. */
  valueGroup?: string;
}

/**
 * Named rules, ordered so the most specific pattern wins when two could match.
 * Each regex is global so `String.prototype.matchAll` can walk every occurrence.
 */
const NAMED_RULES: NamedRule[] = [
  {
    name: "wireguard_private_key",
    regex: /PrivateKey\s*=\s*(?<s>[A-Za-z0-9+/]{43}=)/g,
    valueGroup: "s",
  },
  {
    name: "wireguard_private_key_inline",
    regex: /(?<![A-Za-z0-9_+/=])(?<s>[A-Za-z0-9+/]{43}=)(?![A-Za-z0-9+/=])/g,
    valueGroup: "s",
  },
  {
    name: "openvpn_static_key",
    regex: /<ca>\s*-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
  },
  {
    name: "pem_private_key",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  { name: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "aws_access_key_id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "google_api_key", regex: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { name: "stripe_secret_key", regex: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  {
    name: "anthropic_key",
    regex: /\bsk-ant-(?:api\d\d-|admin\d\d-)?[A-Za-z0-9_\-]{20,}/g,
  },
  { name: "openai_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  {
    name: "bearer_token",
    regex: /[Aa]uthorization:\s*Bearer\s+(?<s>[A-Za-z0-9_\-.]{20,})/g,
    valueGroup: "s",
  },
  {
    name: "private_key_header_inline",
    regex: /(?:PRIVATE_KEY|SECRET|TOKEN)\s*[=:]\s*["']?(?<s>[A-Za-z0-9+/_\-]{24,})/g,
    valueGroup: "s",
  },
];

/** A JWT-shaped run; kept only when `looksLikeCredentialJwt` confirms it. */
const JWT_CANDIDATE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/**
 * Opaque hex run of 80+ characters. Above a git SHA (40) and a sha256 (64),
 * below a typical opaque session token (128). Boundaries stop a longer hex
 * string from being double-counted.
 */
const HIGH_ENTROPY_HEX = /(?<![0-9a-fA-F])([0-9a-fA-F]{80,})(?![0-9a-fA-F])/g;

/** Opaque base64/base64url run of 80+ characters. */
const HIGH_ENTROPY_BASE64 =
  /(?<![A-Za-z0-9+/_\-])([A-Za-z0-9+/_\-]{80,}={0,2})(?![A-Za-z0-9+/_\-=])/g;

const MIN_BASE64_ENTROPY_BITS_PER_CHAR = 3.5;
const MAX_PRINTABLE_DECODED_RATIO = 0.85;

/** Shannon entropy, in bits per character, of a short string. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/**
 * True when a base64 candidate decodes to mostly printable ASCII — the shape of
 * an encoded sentence, log line or diff, not an opaque credential.
 */
function decodesToPrintableText(value: string): boolean {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = Buffer.from(padded, "base64");
  if (decoded.length === 0) return false;
  let printable = 0;
  for (const byte of decoded) {
    const isText = byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
    if (isText) printable += 1;
  }
  return printable / decoded.length >= MAX_PRINTABLE_DECODED_RATIO;
}

/**
 * Return the first secret match in `text`, or null. The returned object carries
 * only the rule name and the salted fingerprint — never any part of the value.
 */
export function detectSecret(text: string, options: DetectSecretOptions = {}): SecretMatch | null {
  if (options.enabled === false) return null;
  if (typeof text !== "string" || text.length === 0) return null;

  for (const rule of NAMED_RULES) {
    for (const match of text.matchAll(rule.regex)) {
      const value = rule.valueGroup ? match.groups?.[rule.valueGroup] : match[0];
      if (value) {
        return { rule: rule.name, fingerprint: fingerprintSecret(value) };
      }
    }
  }

  for (const match of text.matchAll(JWT_CANDIDATE)) {
    if (looksLikeCredentialJwt(match[0])) {
      return { rule: "credential_jwt", fingerprint: fingerprintSecret(match[0]) };
    }
  }

  for (const match of text.matchAll(HIGH_ENTROPY_HEX)) {
    return { rule: "high_entropy_hex", fingerprint: fingerprintSecret(match[1]!) };
  }

  for (const match of text.matchAll(HIGH_ENTROPY_BASE64)) {
    const value = match[1]!;
    if (decodesToPrintableText(value)) continue;
    if (shannonEntropy(value) < MIN_BASE64_ENTROPY_BITS_PER_CHAR) continue;
    return { rule: "high_entropy_base64", fingerprint: fingerprintSecret(value) };
  }

  return null;
}

/** Convenience predicate for callers that only need yes/no. */
export function containsSecret(text: string, options: DetectSecretOptions = {}): boolean {
  return detectSecret(text, options) !== null;
}

/**
 * Serialize one persisted field to the bytes the column will hold. Strings pass
 * through unchanged; anything else (a jsonb column such as an interaction
 * payload or work-product metadata) is JSON-encoded so it is scanned as the
 * stored text rather than as the literal `"[object Object]"`. A value that
 * cannot be encoded is skipped rather than throwing: the guard must not become
 * an outage on a payload the writer was going to persist anyway.
 */
function scanTextForField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * Scan several persisted fields of one write as a single payload, in field
 * order, and return the first match. Field order makes the reported rule
 * deterministic for a payload that trips more than one rule.
 *
 * Callers must pass the values they are about to persist; this never inspects a
 * value the write will not store.
 */
export function detectSecretInFields(
  fields: readonly unknown[],
  options: DetectSecretOptions = {},
): SecretMatch | null {
  if (options.enabled === false) return null;
  for (const field of fields) {
    const text = scanTextForField(field);
    if (text === null) continue;
    const match = detectSecret(text, options);
    if (match) return match;
  }
  return null;
}
