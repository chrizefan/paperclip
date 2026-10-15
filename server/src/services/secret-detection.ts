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
  /** Optional second check on the value; a match it rejects is not a secret. */
  accept?: (value: string) => boolean;
}

/**
 * A `TOKEN=`/`SECRET:` value with no digit is an identifier or a placeholder
 * (`see_the_documentation_below`, `YOUR_TOKEN_HERE`), not a generated credential.
 */
function looksGeneratedCredential(value: string): boolean {
  return /\d/.test(value) && !/^(?:your|my|example|placeholder|changeme)/i.test(value);
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
    // `-` in the lookbehind keeps an SRI digest (`sha256-<43>=`) out of this rule.
    regex: /(?<![A-Za-z0-9_+/=-])(?<s>[A-Za-z0-9+/]{43}=)(?![A-Za-z0-9+/=])/g,
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
    accept: looksGeneratedCredential,
  },
];

/**
 * A JWT-shaped run; kept only when `looksLikeCredentialJwt` confirms it. The
 * lookbehind anchors a candidate to the start of a run: without it the engine
 * retries from every offset of a long dot-free run, which is quadratic (16 s on
 * an 80k-character blob). Anchored, each run is tried once.
 */
const JWT_CANDIDATE =
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

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

/**
 * A random base64 token has a `/`, `+`, `-` or `_` about once every 32
 * characters. A filesystem path, URL path or kebab/snake slug has one every
 * few characters. Above this ratio the run is addressing, not a credential.
 */
const MAX_TOKEN_SEPARATOR_RATIO = 0.08;

function looksLikePathOrSlug(value: string): boolean {
  const separators = value.match(/[/+_-]/g)?.length ?? 0;
  return separators / value.length > MAX_TOKEN_SEPARATOR_RATIO;
}

/** A data URI payload (`data:image/png;base64,...`) or an SRI digest (`sha512-...`). */
function isEncodedPayloadOrDigest(text: string, value: string, index: number): boolean {
  if (/^sha(?:256|384|512)-/.test(value)) return true;
  return text.slice(Math.max(0, index - 7), index) === "base64,";
}
const MAX_PRINTABLE_DECODED_RATIO = 0.85;

/**
 * Identifier shapes that are addressing, not credentials. A single UUID, git
 * SHA or sha256 never reaches the 80-character high-entropy threshold on its
 * own — but system comments embed several of them in one markdown link
 * (`[run](.../agents/<uuid>/runs/<uuid>)`), and the `/` and `-` joining them
 * are both in the base64url alphabet, so the joined path reads as one 80+
 * run. Mask them (length-preserving, so positions are stable) before the
 * high-entropy scans. Boundaries keep a longer hex run intact: masking can
 * never shorten a real 128-hex token below the threshold.
 */
const UUID_SHAPE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
/**
 * A sha384/sha512 hex digest is only masked behind its label: a bare 96/128-hex
 * run is indistinguishable from an opaque token and stays reportable.
 */
const LABELLED_SHA384_512_HEX =
  /(?<=\bsha-?(?:384|512)(?:sum)?\s*[:=]?\s*)(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{96})(?![0-9a-fA-F])/gi;
const STANDALONE_HEX_64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const STANDALONE_HEX_40 = /(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

function maskBenignIdentifiers(text: string): string {
  return text
    .replace(UUID_SHAPE, (m) => " ".repeat(m.length))
    .replace(LABELLED_SHA384_512_HEX, (m) => " ".repeat(m.length))
    .replace(STANDALONE_HEX_64, (m) => " ".repeat(m.length))
    .replace(STANDALONE_HEX_40, (m) => " ".repeat(m.length));
}

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
      if (value && (!rule.accept || rule.accept(value))) {
        return { rule: rule.name, fingerprint: fingerprintSecret(value) };
      }
    }
  }

  for (const match of text.matchAll(JWT_CANDIDATE)) {
    if (looksLikeCredentialJwt(match[0])) {
      return { rule: "credential_jwt", fingerprint: fingerprintSecret(match[0]) };
    }
  }

  const scannable = maskBenignIdentifiers(text);
  for (const match of scannable.matchAll(HIGH_ENTROPY_HEX)) {
    const value = match[1]!;
    // A repeated digit run (e.g. synthetic "0123456789" fixtures) is long
    // but low-entropy; a real opaque hex token is uniformly random (~4 bits
    // per char). Same threshold as the base64 arm below.
    if (shannonEntropy(value) < MIN_BASE64_ENTROPY_BITS_PER_CHAR) continue;
    return { rule: "high_entropy_hex", fingerprint: fingerprintSecret(value) };
  }

  for (const match of scannable.matchAll(HIGH_ENTROPY_BASE64)) {
    const value = match[1]!;
    if (isEncodedPayloadOrDigest(scannable, value, match.index ?? 0)) continue;
    if (looksLikePathOrSlug(value)) continue;
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
