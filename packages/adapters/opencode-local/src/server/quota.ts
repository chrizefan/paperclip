/**
 * Classify OpenCode provider limit errors so the server can schedule a retry
 * after the limit resets instead of failing the run outright.
 *
 * OpenCode wraps many providers (free tiers, OpenAI-compatible gateways, Go
 * credit plans). They report limits as plain text. This module reads that
 * text and returns the shared adapter error family the heartbeat retry path
 * already understands (`provider_quota` or `transient_upstream`) plus an
 * optional `retryNotBefore` time.
 *
 * Opt-in: set PAPERCLIP_OPENCODE_QUOTA_CLASSIFICATION=1 (or "true").
 */

export type OpenCodeLimitClassification = {
  errorFamily: "provider_quota" | "transient_upstream";
  retryNotBefore: Date | null;
};

const QUOTA_RX =
  /\b(quota (exceeded|exhausted|reached)|usage limit|monthly limit|daily limit|insufficient (credit|credits|balance|quota)|out of (credits?|tokens)|credit balance is too low|billing hard limit|exceeded your current quota|Go usage)\b/i;
const RATE_RX = /\b(rate[ -]?limit(ed)?|too many requests|429|overloaded|capacity|try again later)\b/i;

const MAX_RETRY_DELAY_MS = 7 * 24 * 60 * 60_000;

function clampFuture(now: Date, ms: number): Date | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(now.getTime() + Math.min(ms, MAX_RETRY_DELAY_MS));
}

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

/** Find a reset time in provider text. Returns null when none is stated. */
export function extractOpenCodeRetryNotBefore(text: string, now: Date): Date | null {
  // retry-after: 120  /  Retry-After: 120
  const retryAfter = /retry[- ]after["':\s]+(\d+(?:\.\d+)?)\b/i.exec(text);
  if (retryAfter) return clampFuture(now, Number(retryAfter[1]) * 1000);
  // "try again in 2h 30m", "resets in 45 minutes", "reset in 3600s"
  const rel = /(?:try again|retry|resets?|available again)\s+in\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (rel) {
    let total = 0;
    for (const m of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const unit = UNIT_MS[m[2].toLowerCase()];
      if (unit) total += Number(m[1]) * unit;
    }
    const at = clampFuture(now, total);
    if (at) return at;
  }
  // "resets at 2026-10-17T06:00:00Z" or an epoch-seconds reset field
  const abs = /(?:resets?|reset_at|resetAt|available)\s*(?:at|on|:)?\s*["']?(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (abs) {
    const t = Date.parse(abs[1]);
    if (!Number.isNaN(t)) return clampFuture(now, t - now.getTime());
  }
  const epoch = /(?:reset|resets_at|x-ratelimit-reset)["':\s]+(\d{10})\b/i.exec(text);
  if (epoch) return clampFuture(now, Number(epoch[1]) * 1000 - now.getTime());
  return null;
}

export function classifyOpenCodeLimitError(text: string | null | undefined, now: Date = new Date()): OpenCodeLimitClassification | null {
  if (!text) return null;
  const sample = text.length > 20_000 ? text.slice(-20_000) : text;
  if (QUOTA_RX.test(sample)) {
    return { errorFamily: "provider_quota", retryNotBefore: extractOpenCodeRetryNotBefore(sample, now) };
  }
  if (RATE_RX.test(sample)) {
    return { errorFamily: "transient_upstream", retryNotBefore: extractOpenCodeRetryNotBefore(sample, now) };
  }
  return null;
}

export function isOpenCodeQuotaClassificationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.PAPERCLIP_OPENCODE_QUOTA_CLASSIFICATION?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
