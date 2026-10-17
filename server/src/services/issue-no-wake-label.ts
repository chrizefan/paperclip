/**
 * Dispatch skip label.
 *
 * Operators sometimes need to park an issue so that no automatic wake starts a
 * run for it (held for a human decision, frozen during a hand-off, waiting on
 * an outside party). Blocked status works for most cases, but it changes the
 * workflow state and some issues must keep their status.
 *
 * When PAPERCLIP_NO_WAKE_LABEL names a label (for example "no-wake"), any wake
 * for an issue that carries that label is recorded as skipped, unless a human
 * user requested it. Label names match case-insensitively. Unset = disabled.
 */
export function resolveNoWakeLabelName(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.PAPERCLIP_NO_WAKE_LABEL?.trim();
  return raw ? raw : null;
}

export function shouldSkipWakeForNoWakeLabel(input: {
  noWakeLabel: string | null;
  issueLabelNames: readonly string[];
  requestedByActorType: "user" | "agent" | "system" | null | undefined;
}): boolean {
  if (!input.noWakeLabel) return false;
  if (input.requestedByActorType === "user") return false;
  const target = input.noWakeLabel.toLowerCase();
  return input.issueLabelNames.some((name) => name.trim().toLowerCase() === target);
}
