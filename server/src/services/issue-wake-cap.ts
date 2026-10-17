/**
 * Per-issue daily wake cap.
 *
 * The rewake throttle slows down no-progress loops, but an issue can still
 * collect many full-price runs in a day when each run changes something small
 * (a comment, a label) and a driver or timer keeps waking it. Operators want a
 * hard ceiling per (agent, issue) per rolling 24 hours.
 *
 * PAPERCLIP_ISSUE_WAKE_CAP_PER_DAY sets the ceiling. Unset or 0 = disabled.
 * Wakes requested by a human user always pass.
 */
export const ISSUE_WAKE_CAP_WINDOW_MS = 24 * 60 * 60_000;

export function resolveIssueWakeCapPerDay(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PAPERCLIP_ISSUE_WAKE_CAP_PER_DAY?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function shouldSkipWakeForIssueCap(input: {
  capPerDay: number;
  runsInWindow: number;
  requestedByActorType: "user" | "agent" | "system" | null | undefined;
}): boolean {
  if (input.capPerDay <= 0) return false;
  if (input.requestedByActorType === "user") return false;
  return input.runsInWindow >= input.capPerDay;
}
